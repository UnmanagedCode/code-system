// PINS the per-kind advertised capabilities — the booleans of cc's
// `Capabilities` interface, which it negotiates on and then MEMOISES for the
// life of a connection generation, so a wrong one is not re-derived later.
//
// In particular: `docker` and `ssh` advertise `remotes`, `remoteDescriptors`
// AND `remoteListing` ALWAYS, never derived from store contents, because a
// capability that flapped as remotes were added — or as one gained or lost a
// mirror — would be memoised wrong. The PER-REMOTE mirror answer lives in the
// `describeRemote` frame instead (tests/mirror-frames.test.mjs), and the
// configured set in the `remoteList` frame (tests/listing.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ALL_KINDS, REGISTERED_KINDS, createTransport } from '../src/launcher/kinds/index.mjs';
import { createDockerTransport } from '../src/launcher/kinds/docker.mjs';
import { createSshTransport } from '../src/launcher/kinds/ssh.mjs';
import { FAKE_TRANSPORT, Launcher, tempStore } from './helpers.mjs';

// cc's `Capabilities` interface, verbatim (`src/systems/protocol.ts`). A
// missing key is false; an unknown key is ignored — so an extra key would be a
// field with no reader.
const CAPABILITY_KEYS = ['processGroupSignal', 'pty', 'remoteDescriptors', 'remoteListing', 'remotes'];

// THIS HOST's answer to "can the pty helper run here", asked independently of
// the launcher's own probe: the same import line, the same interpreter name.
// `pty` is advertised iff it succeeds, so it is a fact about the host, never a
// constant.
// The same interpreter NAME the launcher probes: CODE_SYSTEM_PYTHON, else python3.
const HOST_PTY = spawnSync(process.env.CODE_SYSTEM_PYTHON?.trim() || 'python3',
  ['-I', '-c', 'import pty,termios,fcntl,select,sys'], { stdio: 'ignore' }).status === 0;

test('only docker and ssh are auto-registered — host is deliberately not', () => {
  assert.deepEqual(REGISTERED_KINDS, ['docker', 'ssh']);
  assert.equal(ALL_KINDS.includes('host'), true, 'the kind exists');
  assert.equal(REGISTERED_KINDS.includes('host'), false, 'but never gets a cc System row');
});

for (const kind of ['docker', 'ssh']) {
  test(`${kind} advertises processGroupSignal:false, remotes:true, remoteDescriptors:true and remoteListing:true, on the wire`, async (t) => {
    const store = await tempStore();
    t.after(() => store.cleanup());
    const l = new Launcher(['--kind', kind], { CODE_SYSTEM_STORE: store.dir });
    t.after(() => l.kill());
    const hs = await l.hello();

    assert.deepEqual(hs.capabilities, {
      processGroupSignal: false,
      remotes: true,
      remoteDescriptors: true,
      remoteListing: true,
      pty: HOST_PTY,
    });
    assert.match(hs.provider, new RegExp(`^code-system-${kind}/\\S+$`));
  });

  test(`${kind} advertises remotes, remoteDescriptors and remoteListing even with an EMPTY store`, async (t) => {
    // The registration handshake happens with zero remotes configured, and cc
    // memoises the answer — so neither may depend on what is in the store. For
    // `remoteDescriptors` the store is empty of MIRRORS too, and the answer is
    // still true: an opted-out remote answers the legal empty descriptor.
    const store = await tempStore();
    t.after(() => store.cleanup());
    const l = new Launcher(['--kind', kind], { CODE_SYSTEM_STORE: store.dir });
    t.after(() => l.kill());
    const caps = (await l.hello()).capabilities;
    assert.equal(caps.remotes, true);
    assert.equal(caps.remoteDescriptors, true);
    // An empty store is an empty configured set, which is still a listing.
    assert.equal(caps.remoteListing, true);
  });
}

// PINS the absent-behaviour of `pty` (systems-protocol.md §2): without a
// runnable python3 the provider advertises `pty:false` — so cc refuses a
// terminal SYSTEM_NO_PTY naming the system and provider — says why on stderr,
// and goes on serving everything else. A crash or a silent `false` would both
// red this.
for (const kind of ['docker', 'ssh', 'host']) {
  test(`${kind}: no runnable python3 advertises pty:false, names the reason on stderr, and still serves`, async (t) => {
    const store = await tempStore();
    t.after(() => store.cleanup());
    const l = new Launcher(['--kind', kind], {
      CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_PYTHON: '/nonexistent/python3',
      CODE_SYSTEM_ALLOW_HOST_KIND: '1', CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED: '1',
    });
    t.after(() => l.kill());
    const hs = await l.hello();
    assert.equal(hs.capabilities.pty, false);
    assert.match(l.stderr, /\/nonexistent\/python3/, `the stderr line names the interpreter it tried: ${l.stderr}`);
    // Still serving: a frame after the hello is answered.
    l.send({ type: 'listRemotes', id: 'l1' });
    await l.waitFor(f => f.id === 'l1');
  });
}

test('host advertises pty iff this host can run the pty helper', async (t) => {
  const l = new Launcher(['--kind', 'host'], { CODE_SYSTEM_ALLOW_HOST_KIND: '1', CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED: '1' });
  t.after(() => l.kill());
  assert.equal((await l.hello()).capabilities.pty, HOST_PTY);
});

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

// THE POST-LANDING ANALOGUE of the fence this test used to be. Card 2026-0004
// landed the ssh transport, so the `/2026-0004/` placeholder assertions became
// their opposite: the seams answer for real, and NO card placeholder may
// survive anywhere in a shipped plan. `processGroupSignal` is deliberately
// still false — see the decision in kinds/docker.mjs, which ssh shares — so a
// card that "finished" by flipping it to true reds here as well as lying to cc.
test('ssh\'s seams answer for real, and its negotiated capabilities did not move', async () => {
  const t = createTransport('ssh');
  assert.deepEqual(
    { g: t.processGroupSignal, r: t.remotes, d: t.remoteDescriptors },
    { g: false, r: true, d: true });

  // An explicit cli, so this does not depend on whether the environment running
  // the suite has CODE_SYSTEM_SSH set (tests/sshkind.test.mjs owns the seam's
  // own behaviour).
  const plan = createSshTransport({ cli: ['ssh'] }).spawnPlan({ host: 'box' },
    { argv: ['true'], shell: null, cwd: '/', env: null, stdinMode: 'ignore', remoteId: null, token: 'tok' });
  assert.equal(plan.file, 'ssh');
  assert.equal(plan.args.at(-2), 'box', 'the destination is an operand after `--`');
  assert.equal(plan.args.at(-3), '--');
  assert.doesNotMatch(JSON.stringify(plan), /2026-0004/, 'no card placeholder survives anywhere in the plan');

  // Reachability really asks a control socket now. Driven through an ssh
  // invocation that CANNOT exist, so the answer does not depend on whether the
  // machine running the suite happens to have ssh or a reachable host: it must
  // be unreachable, and it must name the override rather than the card.
  const reach = await createSshTransport({ cli: ['/definitely-not-ssh-xyz'] })
    .reachability({ host: 'box' });
  assert.equal(reach.connected, false);
  assert.equal(reach.fingerprint, null);
  assert.match(reach.detail, /CODE_SYSTEM_SSH/);
  assert.doesNotMatch(reach.detail, /2026-0004/);
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
    { g: false, r: true, d: true });

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
// that no extra key and no deleted block can creep back into any one kind.
test('no kind\'s hello carries a system key, and the capability object has exactly cc\'s Capabilities keys', async (t) => {
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
