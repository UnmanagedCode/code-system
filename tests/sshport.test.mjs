// THE OPTIONAL `port` ON AN SSH REMOTE. Deterministic — no ssh, no docker:
// `spawnPlan` is pure and everything that would dial goes through a stub. The
// live proof is tests/ssh-port-live.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  controlDir, controlPathFor, createSshTransport, sshBaseArgs,
} from '../src/launcher/kinds/ssh.mjs';
import { stubSshCli } from './helpers.mjs';

const PASSWORD_CONFIG = { host: '10.1.2.3', user: 'dev', password: 'pw' };
const KEY_CONFIG = { host: '10.1.2.3', user: 'root', identityFile: '/keys/id' };
const AMBIENT = { host: 'box', user: 'me' };

const validate = (raw) => createSshTransport({ cli: ['ssh'] }).validateConfig(raw);
const req = () => ({
  argv: ['git', 'status'], shell: null, cwd: '/w', env: null, stdinMode: 'ignore', remoteId: 'r1', token: 'tok',
});
const hashPath = (s) => path.join(controlDir(), createHash('sha256').update(s).digest('hex').slice(0, 20));

async function withTmpdir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-sshport-'));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(async () => {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// ── validateConfig ───────────────────────────────────────────────────

// PINS that every accepted spelling of a port is stored as the same NUMBER, and
// that an explicit 22 is kept rather than canonicalised to "unset".
test('validateConfig stores an accepted port as a number', () => {
  for (const raw of [2222, '2222', ' 2222 ', '02222']) {
    assert.strictEqual(validate({ host: 'h', port: raw }).config.port, 2222, JSON.stringify(raw));
  }
  assert.strictEqual(validate({ host: 'h', port: '022' }).config.port, 22);
  assert.strictEqual(validate({ host: 'h', port: 22 }).config.port, 22, 'an explicit 22 is kept');
  assert.strictEqual(validate({ host: 'h', port: 65535 }).config.port, 65535);
  assert.strictEqual(validate({ host: 'h', port: 1 }).config.port, 1);
});

// PINS that every "no port" spelling leaves no key behind, as user and identityFile do.
test('validateConfig: an absent or blank port stores no key', () => {
  for (const raw of [undefined, null, '', '  ']) {
    const v = validate({ host: 'h', port: raw });
    assert.equal(v.ok, true);
    assert.deepEqual(v.config, { host: 'h' }, JSON.stringify(raw));
  }
});

// PINS the refusal set and its exact wording, so nothing but a whole 1-65535 reaches `-p`.
test('validateConfig refuses everything but a whole number from 1 to 65535', () => {
  for (const raw of [0, 65536, -1, 22.5, '22.5', '0x16', '1e3', '+22', 'abc', true, [22], '0', '65536', '-1', {}]) {
    const v = validate({ host: 'h', port: raw });
    assert.equal(v.ok, false, JSON.stringify(raw));
    assert.equal(v.error,
      `ssh config: 'port' must be a whole number from 1 to 65535 (got ${JSON.stringify(raw)})`);
  }
});

// ── argv ─────────────────────────────────────────────────────────────

// PINS that a remote with no port spawns byte-identically to before the field
// existed, for ambient, key and password configs alike.
test('no port: the whole argv is the pre-port literal', async (t) => {
  await withTmpdir(t);
  const tr = createSshTransport({ cli: ['ssh'], env: { PATH: '/bin' } });
  const base = (config) => [
    '-T', '-o', `BatchMode=${config.password ? 'no' : 'yes'}`, '-o', 'ConnectTimeout=5',
    '-o', `ControlPath=${controlPathFor(config)}`, '-o', 'ControlMaster=no', '-o', 'ControlPersist=600',
  ];
  const a = tr.spawnPlan(AMBIENT, req()).args;
  assert.deepEqual(a.slice(0, -1), [...base(AMBIENT), '--', 'me@box']);
  assert.match(a.at(-1), /git/, 'the one quoted remote command follows');
  const k = tr.spawnPlan(KEY_CONFIG, req()).args;
  assert.deepEqual(k.slice(0, -1), [
    ...base(KEY_CONFIG), '-i', '/keys/id', '-o', 'IdentitiesOnly=yes',
    '-o', 'PreferredAuthentications=publickey', '--', 'root@10.1.2.3']);
  const p = tr.spawnPlan(PASSWORD_CONFIG, req()).args;
  assert.deepEqual(p.slice(0, 11), base(PASSWORD_CONFIG));
  assert.equal(p.includes('-p'), false);
  assert.deepEqual(sshBaseArgs('/s', { master: 'no', config: AMBIENT }), [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlPath=/s',
    '-o', 'ControlMaster=no', '-o', 'ControlPersist=600',
  ]);
});

// PINS `-p <port>` as two adjacent elements after the shared block and before
// the auth args and `--`, composing with either credential.
test('a port adds -p after ControlPersist and before the auth args and the terminator', async (t) => {
  await withTmpdir(t);
  const tr = createSshTransport({ cli: ['ssh'], env: { PATH: '/bin' } });
  for (const config of [{ ...AMBIENT, port: 2222 }, { ...KEY_CONFIG, port: 2222 }, { ...PASSWORD_CONFIG, port: 2222 }]) {
    const args = tr.spawnPlan(config, req()).args;
    const at = args.indexOf('ControlPersist=600');
    assert.deepEqual(args.slice(at + 1, at + 3), ['-p', '2222']);
    assert.equal(args.filter(a => a === '-p').length, 1);
    assert.ok(at + 3 <= args.indexOf('--'));
    if (config.identityFile) assert.ok(args.indexOf('-i') > at + 2, 'auth args follow the port');
  }
  assert.deepEqual(sshBaseArgs('/s', { master: 'no', config: { ...AMBIENT, port: 22 } }).slice(-2), ['-p', '22'],
    'an explicit 22 is emitted literally');
});

// ── ControlPath ──────────────────────────────────────────────────────

// PINS that an unset port keeps every pre-port socket path, and that a set port
// (including an explicit 22) splits the master from unset and from other ports.
test('controlPathFor: unset keeps the pre-port path, a port splits it', () => {
  assert.equal(controlPathFor(AMBIENT), hashPath('me\0box'));
  assert.equal(controlPathFor(PASSWORD_CONFIG), hashPath('dev\x0010.1.2.3\0password'));
  assert.equal(controlPathFor(KEY_CONFIG), hashPath('root\x0010.1.2.3\0key:/keys/id'));
  const p = (port) => controlPathFor({ ...AMBIENT, port });
  assert.equal(p(2222), hashPath('me\0box\0port:2222'));
  assert.notEqual(p(2222), controlPathFor(AMBIENT));
  assert.notEqual(p(2222), p(2223));
  assert.notEqual(p(22), controlPathFor(AMBIENT), 'an explicit 22 is not "unset"');
  assert.notEqual(controlPathFor({ ...PASSWORD_CONFIG, port: 2222 }), controlPathFor(PASSWORD_CONFIG));
});

// ── every dial ───────────────────────────────────────────────────────

// PINS that all six dials (pre-check, master, proving check, reachability, reap,
// disconnect) carry `-p`, and the `-V` probe, which dials nothing, does not.
test('every dial of a port remote carries -p, and the -V probe does not', async (t) => {
  await withTmpdir(t);
  const stub = await stubSshCli(t, { master: true });
  const tr = createSshTransport({ cli: stub.cli, env: { PATH: '/bin' } });
  const config = { ...PASSWORD_CONFIG, port: 2222 };
  await tr.connect(config);
  await tr.reachability(config);
  await tr.reap(config, { token: 'tok', remoteId: 'r' }).catch(() => {});
  await tr.disconnect(config);

  // The stub logs one argument per line, so split into invocations at each
  // dial's leading `-T`; whatever precedes the first is the `-V` probe.
  const argv = await stub.argv();
  const first = argv.indexOf('-T');
  assert.deepEqual(argv.slice(0, first), ['-V'], 'the version probe came first and carries no -p');
  const dials = [];
  for (const a of argv.slice(first)) {
    if (a === '-T') dials.push([]);
    dials.at(-1).push(a);
  }
  assert.equal(dials.length, 6, 'six dials');
  for (const d of dials) {
    assert.equal(d.filter(a => a === '-p').length, 1, d.join(' '));
    assert.equal(d[d.indexOf('-p') + 1], '2222', d.join(' '));
  }
});

// PINS that the NUL-joined identity cannot be forged: an operand carrying NUL (or
// any control character) is refused, so {host:'box\0port:2222'} can never share a
// ControlPath with {host:'box', port:2222}.
test('validateConfig refuses control characters in host and user', () => {
  const forged = { host: 'box\0port:2222' };
  assert.equal(controlPathFor(forged), controlPathFor({ host: 'box', port: 2222 }), 'the collision is real if it got through');
  for (const bad of [forged, { host: 'box', user: 'me\0password' }, { host: 'bo\nx' }]) {
    const v = validate(bad);
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.match(v.error, /must not contain control characters/);
  }
});

// PINS that the host-key refusal's advice names the card's port, and stays the
// bare `ssh-keyscan` when no port is set.
test('the host-key refusal advises ssh-keyscan -p when the card sets a port', () => {
  const tr = createSshTransport({ cli: ['ssh'] });
  const stderr = 'Host key verification failed.\r\n';
  const withPort = tr.classifyFailure({ ...AMBIENT, port: 2222 }, { code: 255, stdout: '', stderr });
  assert.match(withPort.message, /ssh-keyscan -p 2222\)/);
  const without = tr.classifyFailure(AMBIENT, { code: 255, stdout: '', stderr });
  assert.match(without.message, /\(e\.g\. ssh-keyscan\)/);
});
