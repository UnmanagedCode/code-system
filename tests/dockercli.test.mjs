// The docker-invocation resolver (kinds/dockerCli.mjs), driven by a scripted
// `run` fake: no docker, no sudo, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCKER_ENV, createDockerCliResolver } from '../src/launcher/kinds/dockerCli.mjs';

const DENIED = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "x": dial unix /var/run/docker.sock: connect: permission denied\n';
const DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';
const OK = { code: 0, stdout: '27.0.0\n', stderr: '', error: null };
const fail = (stderr, code = 1) => ({ code, stdout: '', stderr, error: null });

// `answers` maps "docker" / "sudo -n docker" to a result, or a function of the call count.
function harness(answers, env = {}) {
  const calls = [];
  const run = async (cli, args) => {
    const key = cli.join(' ');
    calls.push([...cli, ...args].join(' '));
    const a = answers[key];
    return typeof a === 'function' ? a(calls.filter(c => c.startsWith(`${key} `)).length) : a;
  };
  return { calls, env, resolver: createDockerCliResolver({ run, env }) };
}

// Invariant: a working bare docker is used as-is, sudo is never tried, the answer
// is cached, and concurrent resolves share one probe.
test('direct docker answering is settled, cached and probed once', async () => {
  const h = harness({ docker: OK });
  const [a, b] = await Promise.all([h.resolver.resolve(), h.resolver.resolve()]);
  assert.deepEqual(a, { ok: true, argv: ['docker'], via: 'direct', settled: true });
  assert.deepEqual(b, a);
  await h.resolver.resolve();
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0], /^docker version /);
  assert.deepEqual(h.resolver.current(), { argv: ['docker'], via: 'direct' });
});

// Invariant: a socket denial (and only that) falls through to `sudo -n docker`.
test('a socket denial falls back to sudo -n docker', async () => {
  const h = harness({ docker: fail(DENIED), 'sudo -n docker': OK });
  const r = await h.resolver.resolve();
  assert.deepEqual(r, { ok: true, argv: ['sudo', '-n', 'docker'], via: 'sudo', settled: true });
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0], /^docker version /);
  assert.match(h.calls[1], /^sudo -n docker version /);
  assert.equal(h.resolver.current().via, 'sudo');
});

// Invariant: the operator's override is used verbatim with ZERO probes, however
// the fake would answer; a malformed one is a loud operatorError.
test('an override wins without probing, and a malformed one throws', async () => {
  const h = harness({ docker: fail(DENIED), 'sudo -n docker': fail(DENIED) }, { [DOCKER_ENV]: '["/x/docker"]' });
  const r = await h.resolver.resolve();
  assert.deepEqual(r, { ok: true, argv: ['/x/docker'], via: 'override', settled: true });
  assert.deepEqual(h.resolver.current(), { argv: ['/x/docker'], via: 'override' });
  assert.equal(h.calls.length, 0);

  const bad = harness({}, { [DOCKER_ENV]: 'nope' });
  await assert.rejects(bad.resolver.resolve(), /CODE_SYSTEM_DOCKER/);
});

// Invariant: when both attempts fail the result names both and sudo's line, is
// not cached, and carries no bare errno token (cc re-parses refusal text).
test('both denied gives a named, uncached failure with no errno token', async () => {
  const h = harness({ docker: fail(DENIED), 'sudo -n docker': fail('sudo: a password is required\n') });
  const r = await h.resolver.resolve();
  assert.equal(r.ok, false);
  assert.match(r.detail, /`docker`/);
  assert.match(r.detail, /sudo -n docker/);
  assert.match(r.detail, /sudo: a password is required/);
  assert.equal(h.resolver.lastFailure(), r.detail);
  await h.resolver.resolve();
  assert.equal(h.calls.length, 4, 'a failure is re-probed, never cached');

  const spawnErr = harness({
    docker: fail(DENIED),
    'sudo -n docker': { code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn sudo ENOENT'), { code: 'ENOENT' }) },
  });
  const r2 = await spawnErr.resolver.resolve();
  assert.equal(r2.ok, false);
  assert.doesNotMatch(r2.detail, /ENOENT/);
});

// Invariant: anything that is not a socket denial never escalates to sudo, and is
// handed back unsettled so the next resolve probes again.
test('daemon down, a missing docker and a timeout never try sudo and are not cached', async () => {
  const cases = {
    'daemon down': fail(DOWN),
    'docker missing': { code: null, stdout: '', stderr: '', error: new Error('spawn docker ENOENT') },
    timeout: { code: null, stdout: '', stderr: '', error: null },
  };
  for (const [name, res] of Object.entries(cases)) {
    const h = harness({ docker: res, 'sudo -n docker': OK });
    const r = await h.resolver.resolve();
    assert.deepEqual(r, { ok: true, argv: ['docker'], via: 'direct', settled: false }, name);
    await h.resolver.resolve();
    assert.equal(h.calls.length, 2, `${name}: probed again, never cached`);
    assert.ok(h.calls.every(c => c.startsWith('docker ')), `${name}: sudo never called`);
  }
});

// Invariant: an observed access failure forgets the settled mode and re-resolves
// from scratch (here to direct once the grant changed).
test('invalidate() re-resolves a cached sudo mode', async () => {
  let granted = false;
  const h = harness({ docker: () => (granted ? OK : fail(DENIED)), 'sudo -n docker': OK });
  assert.equal((await h.resolver.resolve()).via, 'sudo');
  granted = true;
  h.resolver.invalidate();
  assert.equal((await h.resolver.resolve()).via, 'direct');
  assert.equal(h.resolver.current().via, 'direct');
});

// Invariant: the cache is keyed on the override, so setting it later wins at once
// with no probe — a cached sudo cannot outlive a policy change.
test('a cached mode does not survive an override being set', async () => {
  const env = {};
  const h = harness({ docker: fail(DENIED), 'sudo -n docker': OK }, env);
  await h.resolver.resolve();
  const before = h.calls.length;
  env[DOCKER_ENV] = '["docker"]';
  assert.deepEqual(h.resolver.current(), { argv: ['docker'], via: 'override' });
  assert.equal((await h.resolver.resolve()).via, 'override');
  assert.equal(h.calls.length, before);
});

// Invariant: invalidating while a resolve is in flight starts no second probe.
test('invalidate() during an in-flight resolve starts no second probe', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const calls = [];
  const resolver = createDockerCliResolver({
    env: {},
    run: async (cli) => { calls.push(cli.join(' ')); await gate; return OK; },
  });
  const p = resolver.resolve();
  resolver.invalidate();
  release();
  await p;
  assert.equal(calls.length, 1);
});
