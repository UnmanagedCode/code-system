// PINS THE OPERATOR GATE, launcher side.
//
// The gate is `record.enabled` (src/store.mjs) and it is enforced at ONE site:
// `StoreRemoteSource.lookup()` (src/launcher/remotes.mjs), which
// session.mjs:118 calls for every one of the four REQUEST frames and nowhere
// else. So these tests drive the REAL launcher over pipes rather than calling
// the source directly — the claim is not "the function refuses", it is "no
// operation gets through".
//
// The gate is NOT `reachability.connected`. That is the probed state; this is
// what the operator set. See .wiki/gotchas/gate-versus-probe.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FS_ERROR_CODES } from '../src/launcher/protocol.mjs';
import { FlagRemoteSource, StoreRemoteSource } from '../src/launcher/remotes.mjs';
import { FAKE_TRANSPORT, Launcher, record, tempStore, writeRecord } from './helpers.mjs';

function fakeEnv(storeDir, extra = {}) {
  return { CODE_SYSTEM_STORE: storeDir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT, ...extra };
}

const textOf = (frames, id, type = 'stdout') =>
  frames.filter(f => f.type === type && f.id === id)
    .map(f => Buffer.from(f.dataB64, 'base64').toString('utf8')).join('');

// PINS: the gate covers EVERY request path, not just `exec`. `readFile` and
// `writeFile` resolve through the same `lookup` before `makeRunner` ever sees a
// config, and `describeRemote` does too — a gate that only caught `exec` would
// leave a disabled remote's whole filesystem readable and writable.
test('a switched-off remote refuses exec, readFile, writeFile AND describeRemote', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('off', { enabled: false }));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'exec', id: 'e', remoteId: 'off', cwd: '/tmp', argv: ['printf', 'ran'] });
  l.send({ type: 'readFile', id: 'r', remoteId: 'off', path: '/etc/hostname' });
  l.send({ type: 'writeFile', id: 'w', remoteId: 'off', path: '/tmp/x' });
  l.send({ type: 'describeRemote', id: 'd', remoteId: 'off' });

  for (const id of ['e', 'r', 'w', 'd']) {
    const err = await l.waitFor(f => f.type === 'error' && f.id === id);
    assert.equal(err.code, 'ENOREMOTE', `${id}: the gate refuses with ENOREMOTE`);
    assert.match(err.message, /switched OFF/, `${id}: and says the remote is switched off`);
    assert.equal(err.id, id, `${id}: ID-ADDRESSED — an id-less frame is connection-level`);
  }

  // `describeRemote` is the sharpest of the four: the fake kind does NOT
  // advertise `remoteDescriptors`, so an ungated one would answer EUNSUPPORTED.
  // Getting the gate's answer instead proves the gate runs BEFORE the frame's
  // own handler, not inside it.
  const d = l.frames.find(f => f.type === 'error' && f.id === 'd');
  assert.notEqual(d.code, 'EUNSUPPORTED', 'the gate precedes the frame handler');

  // NOTHING RAN. A refusal that still executed the command would be worse than
  // no gate at all.
  assert.equal(l.frames.some(f => f.type === 'exit'), false, 'no command was executed');
  assert.equal(textOf(l.frames, 'e'), '', 'and it produced no output');
});

// PINS: the refusal is ID-ADDRESSED, so one switched-off remote is not a dead
// connection (systems-protocol.md §9). An id-less error frame trips cc's
// #teardown, failing every OTHER target's in-flight work and then refusing
// unrelated work through a backoff window.
test('a gate refusal does not disturb another target\'s in-flight work', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('on', { enabled: true }));
  await writeRecord(store.dir, record('off', { enabled: false }));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  // In flight ACROSS the refusal.
  l.send({ type: 'exec', id: 'live', remoteId: 'on', cwd: '/tmp', shell: 'sleep 0.4; echo survived' });
  l.send({ type: 'exec', id: 'dead', remoteId: 'off', cwd: '/tmp', argv: ['printf', 'x'] });

  const err = await l.waitFor(f => f.type === 'error' && f.id === 'dead');
  assert.equal(err.code, 'ENOREMOTE');

  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'live');
  assert.equal(exit.code, 0);
  assert.equal(textOf(l.frames, 'live').trim(), 'survived');
});

// PINS the WORDING, because the code alone cannot carry the difference. Every
// refusal this launcher emits for a routing failure is ENOREMOTE — the gate's,
// an absent record's, a stopped container's. Only the message tells the
// operator that nothing is wrong with the target and that the fix is their own
// toggle rather than the machine.
test('the refusal names the operator setting, and does not claim the target failed', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('app-ctr', { enabled: false }));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'exec', id: 'e', remoteId: 'app-ctr', cwd: '/tmp', argv: ['printf', 'x'] });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'e');

  assert.match(err.message, /app-ctr/, 'it names the remote');
  assert.match(err.message, /code-system/, 'and where the toggle is');
  assert.match(err.message, /operator setting, not a fault/,
    'a disabled remote must not read as a broken one');
  assert.match(err.message, /did not contact it/,
    'the discriminator: a BROKEN remote names what failed ON the target; this one never touched it');

  // EVERYTHING READABLE MUST RIDE `message`. cc drops the error frame's
  // `stderr` on the exec path (providerSystem.ts) and never reads it on the
  // request path, so a reason placed there reaches nobody.
  assert.equal('stderr' in err, false, 'the gate refusal carries no stderr');
});

// PINS THE ERRNO-TOKEN HAZARD, which is invisible in production and cheap here.
//
// cc's `runGit` and `ProviderShell` IGNORE the structured `spawnErrorCode` and
// RE-DERIVE a code from the message text with `new RegExp('\\b'+code+'\\b')`
// over FS_ERROR_CODES (classifySpawnError, protocol.ts). A standalone FS errno
// token anywhere in this sentence silently downgrades an administrative refusal
// into "git answered non-zero" — shown as git's own stderr, with no
// system-level signal at all. See .wiki/gotchas/refusal-message-errno-tokens.md.
test('the refusal survives cc\'s text-based re-classification', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('off', { enabled: false }));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'exec', id: 'e', remoteId: 'off', cwd: '/tmp', argv: ['printf', 'x'] });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'e');

  // Built from the shipped taxonomy rather than a hand-copied list, so a new
  // FS code cannot slip past this test.
  for (const code of FS_ERROR_CODES) {
    assert.doesNotMatch(err.message, new RegExp(`\\b${code}\\b`),
      `'${code}' in the message makes cc re-classify this refusal as a command failure`);
  }
});

// PINS THE WHOLE NO-RESTART MECHANISM, end to end and in ONE launcher process.
// The store has no cache — readRemote is readFile + JSON.parse per call — and
// `lookup` runs on every request frame. That ABSENCE is what makes a toggle
// flipped in the UI reach a launcher cc spawned minutes ago. Adding a cache to
// the store, or memoising the lookup, reds this.
test('flipping the gate takes effect on the next frame, with no restart', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('r', { enabled: false }));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'exec', id: 'before', remoteId: 'r', cwd: '/tmp', argv: ['printf', 'ran'] });
  assert.equal((await l.waitFor(f => f.type === 'error' && f.id === 'before')).code, 'ENOREMOTE');

  // What the backend's connect route does, reduced to its one effect.
  await writeRecord(store.dir, record('r', { enabled: true }));

  l.send({ type: 'exec', id: 'after', remoteId: 'r', cwd: '/tmp', argv: ['printf', 'ran'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'after');
  assert.equal(exit.code, 0, 'the SAME launcher process now serves the remote');
  assert.equal(textOf(l.frames, 'after'), 'ran');

  // And back off again, in the same process — the gate is not one-way.
  await writeRecord(store.dir, record('r', { enabled: false }));
  l.send({ type: 'exec', id: 'again', remoteId: 'r', cwd: '/tmp', argv: ['printf', 'ran'] });
  assert.equal((await l.waitFor(f => f.type === 'error' && f.id === 'again')).code, 'ENOREMOTE');
});

// PINS THE ORDER of the two gates in `lookup`. A remote that is BOTH switched
// off and known to fail the tooling baseline must answer "switched off": the
// operator's own action is the actionable answer, and a disabled remote's stale
// baseline verdict is not what they need to hear. Swapping the two lines reds
// this without changing any other test.
test('the operator gate precedes the tooling-baseline gate', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('both', {
    enabled: false,
    baseline: {
      state: 'unsupported',
      fingerprint: 'fake:1',
      missing: [{ capability: 'readDir', probe: 'find -printf', detail: 'find: unrecognized: -printf' }],
      checkedAt: '2026-09-03T00:00:00.000Z',
    },
  }));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'exec', id: 'e', remoteId: 'both', cwd: '/tmp', argv: ['printf', 'x'] });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'e');

  assert.match(err.message, /switched OFF/, 'the gate answers');
  assert.doesNotMatch(err.message, /tooling baseline/, 'not the baseline gate');
  assert.equal(err.code, 'ENOREMOTE', "and with the gate's code, not the baseline gate's EUNKNOWN");
});

// PINS: work already in flight is STILL REAPED after the gate closes behind it.
//
// `reap` deliberately does not pass through `lookup` — gating it would abandon
// far-side processes at shutdown, which is exactly the leak PROTOCOL MUST 3
// exists to prevent. An operator disabling a remote while a command runs is the
// reachable form of that hazard, so it is the form under test.
test('disabling a remote mid-flight does not stop its work being reaped', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('r', { enabled: true }));
  const reapLog = path.join(store.dir, 'reaps.jsonl');
  const l = new Launcher(['--kind', 'fake'],
    fakeEnv(store.dir, { CODE_SYSTEM_FAKE_REAP_LOG: reapLog }));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'exec', id: 'long', remoteId: 'r', cwd: '/tmp', shell: 'sleep 30' });
  // A barrier proving the exec really started before the gate closes.
  l.send({ type: 'exec', id: 'barrier', remoteId: 'r', cwd: '/tmp', argv: ['printf', 'up'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier');

  await writeRecord(store.dir, record('r', { enabled: false }));
  l.closeStdin();
  await l.exited;

  const calls = (await fs.readFile(reapLog, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(calls.some(c => c.remoteId === 'r'), true,
    'a gate closed over live work must not leak the far-side process');
});

// PINS THAT CONFORMANCE IS UNAFFECTED BY CONSTRUCTION, not by luck.
//
// `npm run conformance` drives `--kind host`, which uses FlagRemoteSource — a
// different class that reads no store and so has no record to carry a gate.
// This is the unit half of that claim; the other half is actually running cc's
// suite against a clone of the pin.
test('FlagRemoteSource has no gate, even with a switched-off store record of the same name', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const before = process.env.CODE_SYSTEM_STORE;
  process.env.CODE_SYSTEM_STORE = store.dir;
  t.after(() => {
    if (before === undefined) delete process.env.CODE_SYSTEM_STORE;
    else process.env.CODE_SYSTEM_STORE = before;
  });
  await writeRecord(store.dir, record('a', { kind: 'host', enabled: false }));

  const flag = new FlagRemoteSource(new Map([['a', '/tmp/root-a']]));
  const res = await flag.lookup('a');
  assert.equal(res.ok, true, 'the flag-backed source resolves a flagged id with no gate consulted');
  assert.equal(res.remote.root, '/tmp/root-a');

  // With no --remote flags at all the default target is unfenced and ungated.
  assert.equal((await new FlagRemoteSource().lookup(null)).ok, true);

  // The CONTROL: the same id, through the store-backed source, IS gated — so
  // the test above is proving an asymmetry rather than that nothing is gated.
  const stored = await new StoreRemoteSource('host').lookup('a');
  assert.equal(stored.ok, false);
  assert.match(stored.message, /switched OFF/);
});
