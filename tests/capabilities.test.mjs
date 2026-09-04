// PINS the per-kind advertised capabilities — the three booleans of cc's
// `Capabilities` interface, which it negotiates on and then MEMOISES for the
// life of a connection generation, so a wrong one is not re-derived later.
//
// In particular: `docker` and `ssh` advertise `remotes:true` ALWAYS, never
// derived from store contents, because a capability that flapped as remotes
// were added would be memoised wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_KINDS, REGISTERED_KINDS, createTransport } from '../src/launcher/kinds/index.mjs';
import { createDockerTransport } from '../src/launcher/kinds/docker.mjs';
import { FAKE_TRANSPORT, Launcher, tempStore } from './helpers.mjs';

// cc's `Capabilities` interface, verbatim: processGroupSignal, remotes,
// remoteDescriptors. A missing key is false; an unknown key is ignored — so a
// fourth key would be a field with no reader.
const CAPABILITY_KEYS = ['processGroupSignal', 'remoteDescriptors', 'remotes'];

test('only docker and ssh are auto-registered — host is deliberately not', () => {
  assert.deepEqual(REGISTERED_KINDS, ['docker', 'ssh']);
  assert.equal(ALL_KINDS.includes('host'), true, 'the kind exists');
  assert.equal(REGISTERED_KINDS.includes('host'), false, 'but never gets a cc System row');
});

for (const kind of ['docker', 'ssh']) {
  test(`${kind} advertises processGroupSignal:false and remotes:true, on the wire`, async (t) => {
    const store = await tempStore();
    t.after(() => store.cleanup());
    const l = new Launcher(['--kind', kind], { CODE_SYSTEM_STORE: store.dir });
    t.after(() => l.kill());
    const hs = await l.hello();

    assert.deepEqual(hs.capabilities, {
      processGroupSignal: false,
      remotes: true,
      remoteDescriptors: false,
    });
    assert.match(hs.provider, new RegExp(`^code-system-${kind}/\\S+$`));
  });

  test(`${kind} advertises remotes:true even with an EMPTY store`, async (t) => {
    // The registration handshake happens with zero remotes configured, and cc
    // memoises the answer — so this must not depend on what is in the store.
    const store = await tempStore();
    t.after(() => store.cleanup());
    const l = new Launcher(['--kind', kind], { CODE_SYSTEM_STORE: store.dir });
    t.after(() => l.kill());
    assert.equal((await l.hello()).capabilities.remotes, true);
  });
}

test('docker and ssh validate their own config, and the store never inspects it', () => {
  const docker = createTransport('docker');
  assert.equal(docker.validateConfig({ container: 'app' }).ok, true);
  assert.deepEqual(docker.validateConfig({ container: ' app ' }).config, { container: 'app' });
  assert.equal(docker.validateConfig({}).ok, false);
  assert.match(docker.validateConfig({}).error, /container/);
  assert.equal(docker.validateConfig(null).ok, false);

  const ssh = createTransport('ssh');
  assert.equal(ssh.validateConfig({ host: 'box' }).ok, true);
  assert.deepEqual(ssh.validateConfig({ host: 'box', user: 'me' }).config, { host: 'box', user: 'me' });
  assert.equal(ssh.validateConfig({ user: 'me' }).ok, false);
});

// PINS THE ARGV/OPTION BOUNDARY. These values become operands — `docker exec
// <container>`, `ssh <user>@<host>` — so a leading `-` makes the far-side binary
// read them as OPTIONS instead. Refused at the store's front door, because
// cards 2026-0003 and 2026-0004 build argv from them and the rule has to hold
// before either exists.
test('an option-shaped config value is refused, not stored', () => {
  const docker = createTransport('docker');
  for (const container of ['-v /:/host', '--privileged', '-it', '-']) {
    const r = docker.validateConfig({ container });
    assert.equal(r.ok, false, `docker container ${JSON.stringify(container)} must be refused`);
    assert.match(r.error, /must not start with/);
  }
  // Trimming happens first, so whitespace cannot smuggle one past.
  assert.equal(docker.validateConfig({ container: '   -v /:/host' }).ok, false);

  const ssh = createTransport('ssh');
  for (const host of ['-oProxyCommand=evil', '-D8080', '--']) {
    assert.equal(ssh.validateConfig({ host }).ok, false, `ssh host ${JSON.stringify(host)} must be refused`);
  }
  for (const user of ['-oProxyCommand=evil', '-l']) {
    const r = ssh.validateConfig({ host: 'box', user });
    assert.equal(r.ok, false, `ssh user ${JSON.stringify(user)} must be refused`);
    assert.match(r.error, /user/);
  }
  // A dash INSIDE the value is ordinary and must still be accepted.
  assert.equal(docker.validateConfig({ container: 'my-app-1' }).ok, true);
  assert.equal(ssh.validateConfig({ host: 'build-box-2', user: 'ci-runner' }).ok, true);
});

// NARROWED TO `ssh` when card 2026-0003 landed the docker transport. Deleting
// it instead would drop ssh's fence, and leaving it whole would red.
test('the ssh transport fails LOUDLY where its card has not landed', async () => {
  const t = createTransport('ssh');
  assert.throws(() => t.spawnPlan({}, { argv: ['true'], shell: null, cwd: '/', env: null }),
    /2026-0004/, 'a stub that returned a plausible plan would be worse than one that throws');
  const reach = await t.reachability({});
  assert.equal(reach.connected, false);
  assert.match(reach.detail, /2026-0004/);
});

// THE OTHER HALF of the same claim: docker's seams answer for real now, and
// filling them changed NOTHING cc negotiates on. In particular
// `processGroupSignal` is deliberately still false — see the decision recorded
// in kinds/docker.mjs and .wiki/gotchas/docker-exec-transport.md — so a card
// that "finished" by flipping it to true reds here as well as lying to cc.
test('docker\'s seams answer for real, and its negotiated capabilities did not move', async () => {
  const t = createTransport('docker');
  assert.deepEqual(
    { g: t.processGroupSignal, r: t.remotes, d: t.remoteDescriptors },
    { g: false, r: true, d: false });

  // An explicit cli, so this does not depend on whether the environment running
  // the suite has CODE_SYSTEM_DOCKER set (it does on a host where docker needs
  // a prefix, and tests/dockerkind.test.mjs owns the seam's own behaviour).
  const plan = createDockerTransport({ cli: ['docker'] }).spawnPlan({ container: 'app' },
    { argv: ['true'], shell: null, cwd: '/', env: null, stdinMode: 'ignore', remoteId: null, token: 'tok' });
  assert.equal(plan.file, 'docker');
  assert.equal(plan.args[0], 'exec');
  assert.doesNotMatch(JSON.stringify(plan), /2026-0003/, 'no card placeholder survives anywhere in the plan');

  // Reachability really talks to a daemon now. Driven through a docker
  // invocation that CANNOT exist, so the answer does not depend on whether the
  // machine running the suite happens to have docker: it must be unreachable,
  // and it must name the override rather than the card.
  const reach = await createDockerTransport({ cli: ['/definitely-not-docker-xyz'] })
    .reachability({ container: 'app' });
  assert.equal(reach.connected, false);
  assert.equal(reach.fingerprint, null);
  assert.match(reach.detail, /CODE_SYSTEM_DOCKER/);
  assert.doesNotMatch(reach.detail, /2026-0003/);
});

test('host advertises what it was flagged with — createTransport does not hardcode', () => {
  const bare = createTransport('host', {});
  assert.deepEqual(
    { g: bare.processGroupSignal, r: bare.remotes, d: bare.remoteDescriptors },
    { g: true, r: false, d: false },
    'no flags at all is cc\'s first core configuration');
  const on = createTransport('host', { processGroupSignal: true, remotes: true, remoteDescriptors: true });
  assert.deepEqual(
    { g: on.processGroupSignal, r: on.remotes, d: on.remoteDescriptors },
    { g: true, r: true, d: true });
  const off = createTransport('host', { processGroupSignal: false, remotes: false, remoteDescriptors: false });
  assert.deepEqual(
    { g: off.processGroupSignal, r: off.remotes, d: off.remoteDescriptors },
    { g: false, r: false, d: false });
});

// PINS THE SHAPE, across every kind at once: the capability key SET is cc's
// `Capabilities` interface and nothing more, and no kind's hello carries a
// `system` descriptor. The per-kind deep-equals above pin VALUES; this pins
// that no fourth key and no deleted block can creep back into any one kind.
test('no kind\'s hello carries a system key, and the capability object has exactly cc\'s three keys', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const launches = [
    ['docker', {}],
    ['ssh', {}],
    ['host', { CODE_SYSTEM_ALLOW_HOST_KIND: '1', CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED: '1' }],
    ['fake', { CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT }],
  ];
  for (const [kind, extra] of launches) {
    const l = new Launcher(['--kind', kind], { CODE_SYSTEM_STORE: store.dir, ...extra });
    t.after(() => l.kill());
    const hs = await l.hello();
    assert.deepEqual(Object.keys(hs.capabilities).sort(), CAPABILITY_KEYS,
      `${kind} advertises exactly cc's Capabilities keys`);
    assert.ok(!('system' in hs), `${kind} sends no system descriptor`);
  }
});
