// PINS the per-kind advertised capabilities — the four booleans cc negotiates
// on and then MEMOISES for the life of a connection generation, so a wrong one
// is not re-derived later.
//
// In particular: `docker` and `ssh` advertise `persistentShell:false`
// PERMANENTLY, and `remotes:true` ALWAYS. Neither is derived from store
// contents, because a capability that flapped as remotes were added would be
// memoised wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_KINDS, REGISTERED_KINDS, createTransport } from '../src/launcher/kinds/index.mjs';
import { Launcher, tempStore } from './helpers.mjs';

test('only docker and ssh are auto-registered — host is deliberately not', () => {
  assert.deepEqual(REGISTERED_KINDS, ['docker', 'ssh']);
  assert.equal(ALL_KINDS.includes('host'), true, 'the kind exists');
  assert.equal(REGISTERED_KINDS.includes('host'), false, 'but never gets a cc System row');
});

for (const kind of ['docker', 'ssh']) {
  test(`${kind} advertises persistentShell:false and remotes:true, on the wire`, async (t) => {
    const store = await tempStore();
    t.after(() => store.cleanup());
    const l = new Launcher(['--kind', kind], { CODE_SYSTEM_STORE: store.dir });
    t.after(() => l.kill());
    const hs = await l.hello();

    assert.deepEqual(hs.capabilities, {
      // No long-lived shell for this kind: cc takes its documented
      // absent-behaviour and runs every redirected shell command as a one-shot
      // exec. Because cc GATES `stdin`/`stdinClose` on this capability
      // (src/systems/providerSystem.ts, the persistentShell gate), advertising false is what stops
      // those frames being sent at all; the shared refusal path they would meet
      // is pinned in tests/hostkind.test.mjs, which uses the one kind that can
      // currently spawn a child.
      persistentShell: false,
      processGroupSignal: false,
      remotes: true,
      remoteDescriptors: false,
    });
    assert.equal(hs.system.shell.startsWith('/'), true, 'system.shell is absolute');
    assert.equal(hs.system.shell, '/bin/bash');
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

test('the docker and ssh transports fail LOUDLY where their card has not landed', async () => {
  for (const [kind, card] of [['docker', '2026-0003'], ['ssh', '2026-0004']]) {
    const t = createTransport(kind);
    assert.throws(() => t.spawnPlan({}, { argv: ['true'], shell: null, cwd: '/', env: null }),
      new RegExp(card), 'a stub that returned a plausible plan would be worse than one that throws');
    const reach = await t.reachability({});
    assert.equal(reach.connected, false);
    assert.match(reach.detail, new RegExp(card));
  }
});

test('host advertises what it was flagged with — createTransport does not hardcode', () => {
  const bare = createTransport('host', {});
  assert.deepEqual(
    { p: bare.persistentShell, g: bare.processGroupSignal, r: bare.remotes, d: bare.remoteDescriptors },
    { p: true, g: true, r: false, d: false },
    'no flags at all is cc\'s first core configuration');
  const on = createTransport('host', { persistentShell: true, processGroupSignal: true, remotes: true, remoteDescriptors: true });
  assert.deepEqual(
    { p: on.persistentShell, g: on.processGroupSignal, r: on.remotes, d: on.remoteDescriptors },
    { p: true, g: true, r: true, d: true });
  const off = createTransport('host', { persistentShell: false, processGroupSignal: false, remotes: false, remoteDescriptors: false });
  assert.deepEqual(
    { p: off.persistentShell, g: off.processGroupSignal, r: off.remotes, d: off.remoteDescriptors },
    { p: false, g: false, r: false, d: false });
});
