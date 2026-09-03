// PINS the `host` kind's guard and its flag-derived capabilities.
//
// The guard, because a hand-registered `--kind host` row is an unfenced
// arbitrary-exec provider on cc's own machine. The capabilities, because
// deriving them from flags is the ONLY thing that makes cc's conformance suite
// runnable against this launcher at all: its three core configurations pass no
// flags and deep-equal `remotes:false` / `remoteDescriptors:false`, while its
// remotes and mirror tests pass `--remote` / `--mirror` and require the
// opposite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Launcher, tempStore } from './helpers.mjs';

const ALLOW = { CODE_SYSTEM_ALLOW_HOST_KIND: '1' };

const textOf = (frames, id, type = 'stdout') =>
  frames.filter(f => f.type === type && f.id === id)
    .map(f => Buffer.from(f.dataB64, 'base64').toString('utf8')).join('');

test('without CODE_SYSTEM_ALLOW_HOST_KIND the host kind refuses before ANY frame', async () => {
  const l = new Launcher(['--kind', 'host'], { CODE_SYSTEM_ALLOW_HOST_KIND: '' });
  const { code } = await l.exited;
  // Asserted on the exit code and stderr, so a regression cannot pass by
  // emitting a hello anyway.
  assert.equal(code, 2);
  assert.equal(l.frames.length, 0, 'nothing reached stdout — cc answers 502 quoting our stderr');
  assert.match(l.stderr, /CODE_SYSTEM_ALLOW_HOST_KIND/, 'the refusal names the condition');
  assert.match(l.stderr, /TEST VEHICLE/i, 'and says what the kind is for');
});

test('a value other than 1 does not open the guard', async () => {
  for (const v of ['0', 'true', 'yes', '11']) {
    const l = new Launcher(['--kind', 'host'], { CODE_SYSTEM_ALLOW_HOST_KIND: v });
    const { code } = await l.exited;
    assert.equal(code, 2, `${v} must not enable the host kind`);
  }
});

test('with the guard open and NO flags, host advertises exactly what cc\'s core configs expect', async (t) => {
  const l = new Launcher(['--kind', 'host'], ALLOW);
  t.after(() => l.kill());
  const hs = await l.hello();
  // This deep-equal is CAPABILITY_CONFIGS[0].caps, verbatim.
  assert.deepEqual(hs.capabilities, {
    persistentShell: true, processGroupSignal: true, remotes: false, remoteDescriptors: false,
  });
  assert.equal(hs.system.shell.startsWith('/'), true);
  assert.match(hs.provider, /^code-system-host\/\S+$/);

  // With no --remote it serves ONE unfenced default target, so a request naming
  // no remote is answered rather than refused.
  l.send({ type: 'exec', id: 'e1', cwd: '/tmp', argv: ['printf', 'served'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'e1')).code, 0);
  assert.equal(textOf(l.frames, 'e1'), 'served');
});

test('--no-persistent-shell lowers the capability AND makes it real', async (t) => {
  const l = new Launcher(['--kind', 'host', '--no-persistent-shell'], ALLOW);
  t.after(() => l.kill());
  const hs = await l.hello();
  // CAPABILITY_CONFIGS[1].caps, verbatim.
  assert.deepEqual(hs.capabilities, {
    persistentShell: false, processGroupSignal: true, remotes: false, remoteDescriptors: false,
  });

  // THE MECHANISM docker and ssh permanently sit behind: with the capability
  // absent, a `stdin` frame is refused rather than served. Exercised here
  // because `host` is the kind that can actually spawn a child; the per-kind
  // constants are pinned in tests/capabilities.test.mjs.
  l.send({ type: 'exec', id: 'c1', cwd: '/tmp', argv: ['cat'] });
  l.send({ type: 'stdin', id: 'c1', dataB64: Buffer.from('hi').toString('base64') });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'c1');
  assert.equal(err.code, 'EUNSUPPORTED');
  assert.equal(typeof err.id, 'string', 'id-addressed');
});

test('--no-process-group-signal lowers the capability and sets descendantsMaySurvive', async (t) => {
  const l = new Launcher(['--kind', 'host', '--no-process-group-signal'], ALLOW);
  t.after(() => l.kill());
  const hs = await l.hello();
  // CAPABILITY_CONFIGS[2].caps, verbatim.
  assert.deepEqual(hs.capabilities, {
    persistentShell: true, processGroupSignal: false, remotes: false, remoteDescriptors: false,
  });

  // The grandchild's own stdout goes to /dev/null so it does not hold the
  // command's pipes open after the direct child dies — what is under test is
  // the SIGNAL's reach, not how long an orphan keeps a pipe. Same shape cc's
  // own conformance suite uses.
  l.send({ type: 'exec', id: 'g', cwd: '/tmp', shell: 'sleep 30 >/dev/null 2>&1 & wait', timeoutMs: 200 });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'g');
  assert.equal(exit.timedOut, true);
  assert.equal(exit.code, 124, "124 is timeout(1)'s convention");
  // Asserted on the FLAG, not on a race against real process death.
  assert.equal(exit.descendantsMaySurvive, true,
    'without group reach the result SAYS grandchildren may survive');
});

test('with group reach, a timed-out exec claims nothing was left behind', async (t) => {
  const l = new Launcher(['--kind', 'host'], ALLOW);
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'exec', id: 'g', cwd: '/tmp', shell: 'sleep 30 >/dev/null 2>&1 & wait', timeoutMs: 200 });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'g');
  assert.equal(exit.timedOut, true);
  assert.equal(exit.descendantsMaySurvive, undefined);
});

test('--remote turns on `remotes`, fences each target, and injects CC_REMOTE', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const rootA = path.join(store.dir, 'a');
  const rootB = path.join(store.dir, 'b');
  await fs.mkdir(rootA); await fs.mkdir(rootB);

  const l = new Launcher(['--kind', 'host', '--remote', `a=${rootA}`, '--remote', `b=${rootB}`], ALLOW);
  t.after(() => l.kill());
  const hs = await l.hello();
  assert.equal(hs.capabilities.remotes, true, 'given targets, the provider says so');
  assert.equal(hs.capabilities.remoteDescriptors, false, 'and still advertises no mirror');

  // POSITIVE ROUTING EVIDENCE: only the far side knows which target ran this.
  l.send({ type: 'exec', id: 'e1', remoteId: 'a', cwd: rootA, shell: 'echo "$CC_REMOTE"' });
  await l.waitFor(f => f.type === 'exit' && f.id === 'e1');
  assert.equal(textOf(l.frames, 'e1').trim(), 'a');

  // A path belonging to another target is REFUSED, never served — on a machine
  // where every target is one filesystem that refusal is the only thing between
  // a mis-bound operation and a plausible-looking answer.
  l.send({ type: 'readFile', id: 'x', remoteId: 'a', path: path.join(rootB, 'secret') });
  assert.equal((await l.waitFor(f => f.type === 'error' && f.id === 'x')).code, 'EACCES');

  // AND `/` IS EXEMPT: every cc derivation carries cwd '/' as a placeholder
  // with its real target in argv, so fencing it would refuse them all.
  l.send({ type: 'exec', id: 'deriv', remoteId: 'a', cwd: '/', argv: ['printf', 'derived'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'deriv');
  assert.equal(exit.code, 0, "cwd '/' must never be fenced");
  assert.equal(textOf(l.frames, 'deriv'), 'derived');
});

test('--mirror/--exclude turn on remoteDescriptors and round-trip the advertisement', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const l = new Launcher(
    ['--kind', 'host', '--mirror', store.dir, '--exclude', '/proc', '--exclude', '/dev'], ALLOW);
  t.after(() => l.kill());
  const hs = await l.hello();
  assert.equal(hs.capabilities.remoteDescriptors, true);
  assert.equal(hs.capabilities.remotes, false, 'a mirror flag alone does not make it multi-target');

  l.send({ type: 'describeRemote', id: 'd1' });
  const d = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd1');
  assert.equal(d.mirrorRoot, store.dir);
  assert.deepEqual(d.exclude, ['/proc', '/dev']);
});

test('describeRemote for an unknown remote is an id-addressed ENOREMOTE', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const l = new Launcher(
    ['--kind', 'host', '--remote', `a=${store.dir}`, '--mirror', `a=${store.dir}`], ALLOW);
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'describeRemote', id: 'ghost', remoteId: 'nope' });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'ghost');
  assert.equal(err.code, 'ENOREMOTE');
  assert.equal(typeof err.id, 'string');

  // The connection is still serving the target that does exist.
  l.send({ type: 'describeRemote', id: 'd1', remoteId: 'a' });
  const d = await l.waitFor(f => f.type === 'remoteDescriptor' && f.id === 'd1');
  assert.equal(d.mirrorRoot, store.dir);
});

test('describeRemote without the capability is EUNSUPPORTED, id-addressed', async (t) => {
  const l = new Launcher(['--kind', 'host'], ALLOW);
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'describeRemote', id: 'd1' });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'd1');
  assert.equal(err.code, 'EUNSUPPORTED');
  assert.equal(typeof err.id, 'string');
});

test('a command that never started is an error frame carrying the FS code, not an exit frame', async (t) => {
  const l = new Launcher(['--kind', 'host'], ALLOW);
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'exec', id: 'e1', cwd: '/tmp', argv: ['definitely-not-a-real-binary-xyz'] });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'e1');
  assert.equal(err.code, 'ENOENT');
  l.send({ type: 'exec', id: 'e2', cwd: '/definitely-not-a-real-directory-xyz', argv: ['true'] });
  assert.equal((await l.waitFor(f => f.type === 'error' && f.id === 'e2')).code, 'ENOENT');
  assert.equal(l.frames.some(f => f.type === 'exit'), false, 'never an exit frame');
});
