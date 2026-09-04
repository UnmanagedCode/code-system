// PINS the frame loop's protocol obligations: the handshake's shape and
// once-ness, id-addressed ENOREMOTE routing (including that one dead remote
// does not disturb another target's in-flight work), that follow-on frames
// carry no remoteId, and that every malformed-input path is a FATAL EPROTO
// rather than a skipped frame or a silent partial answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_LINE_BYTES } from '../src/launcher/protocol.mjs';
import { FAKE_TRANSPORT, Launcher, record, tempStore, writeRecord } from './helpers.mjs';

function fakeEnv(storeDir, extra = {}) {
  return { CODE_SYSTEM_STORE: storeDir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT, ...extra };
}

const textOf = (frames, id, type = 'stdout') =>
  frames.filter(f => f.type === type && f.id === id)
    .map(f => Buffer.from(f.dataB64, 'base64').toString('utf8')).join('');

test('the handshake is answered once, before any other frame, carries NO system descriptor, and works on an EMPTY store', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());

  const hs = await l.hello();
  // THE REGISTRATION CONSTRAINT, asserted directly: cc registers by spawning
  // this argv and handshaking with zero remotes configured.
  assert.equal(hs.protocol, 1);
  assert.match(hs.provider, /^\S+\/\S+$/);
  // cc's HelloProviderFrame is {type, protocol, provider, capabilities?}. The
  // descriptor it used to carry is DELETED, and `shell` — its only ever
  // reader — went with the long-lived shell. We send no key with zero readers,
  // and re-adding one must red this.
  assert.ok(!('system' in hs), 'the hello carries no `system` descriptor at all');
  assert.equal(hs.capabilities.remotes, true, 'a store-backed kind always advertises remotes');
  assert.equal(l.frames.length, 1, 'the hello is the FIRST frame');

  // A second hello must not produce a second handshake. The exec that follows
  // is only a barrier: it proves the launcher processed both frames before we
  // count the hellos.
  l.send({ type: 'hello', protocol: 1, client: 'code-conductor' });
  l.send({ type: 'exec', id: 'e0', cwd: '/tmp', argv: ['printf', 'ok'] });
  await l.waitFor(f => f.id === 'e0');
  assert.equal(l.frames.filter(f => f.type === 'hello').length, 1, 'exactly one hello');
});

test('ENOREMOTE is id-addressed for an absent AND an unknown remoteId, and another target survives it', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  // A real command on a real remote, IN FLIGHT ACROSS both refusals.
  l.send({ type: 'exec', id: 'live', remoteId: 'alpha', cwd: '/tmp', shell: 'sleep 0.4; echo survived' });

  l.send({ type: 'readFile', id: 'r-none', path: '/tmp/x' });                       // names none
  l.send({ type: 'readFile', id: 'r-ghost', remoteId: 'ghost', path: '/tmp/x' });   // names an unknown one

  const none = await l.waitFor(f => f.type === 'error' && f.id === 'r-none');
  const ghost = await l.waitFor(f => f.type === 'error' && f.id === 'r-ghost');
  assert.equal(none.code, 'ENOREMOTE');
  assert.equal(ghost.code, 'ENOREMOTE');
  assert.match(ghost.message, /ghost/);
  // ID-ADDRESSED IS A MUST: an id-less error frame is connection-level and
  // would fail every OTHER target's in-flight work.
  assert.equal(typeof none.id, 'string');
  assert.equal(typeof ghost.id, 'string');

  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'live');
  assert.equal(exit.code, 0);
  assert.equal(textOf(l.frames, 'live').trim(), 'survived',
    "the other target's work was untouched");
});

test('a wrong-kind and a wrong-schema record are ENOREMOTE by name, not a guess', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('wrongkind', { kind: 'docker' }));
  await writeRecord(store.dir, record('future', { schema: 2 }));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'readFile', id: 'k', remoteId: 'wrongkind', path: '/tmp/x' });
  l.send({ type: 'readFile', id: 's', remoteId: 'future', path: '/tmp/x' });
  const k = await l.waitFor(f => f.type === 'error' && f.id === 'k');
  const s = await l.waitFor(f => f.type === 'error' && f.id === 's');
  assert.equal(k.code, 'ENOREMOTE');
  assert.match(k.message, /docker/, 'the refusal names the kind it actually is');
  assert.equal(s.code, 'ENOREMOTE');
  assert.match(s.message, /schema 2/, 'the refusal quotes the schema it found');
  assert.match(s.message, /backend/, 'and names the repair');
});

// PINS: a `signal` frame naming NO remote reaches THE child its `exec` id bound
// — and no other. `signal` is the surviving follow-on frame with a visible
// effect; cc deleted `stdin`/`stdinClose`, which is what this test used to ride
// on.
//
// THREE children, and the signalled one is the MIDDLE one, because the mutants
// worth catching are the id-blind ones and each picks a different victim:
//
//   - "kill the first live child"  kills c1 → c2's exit never arrives
//   - "kill the most recent"       kills c3 → c2's exit never arrives
//   - "kill every live child"      kills all three → caught by the SIGINT step
//
// Two live children would not do it: with c1 and c2 up and c1 signalled, the
// insertion-order mutant coincides with correct behaviour, and once one child is
// dead every "pick the single live one" heuristic coincides again. The middle of
// three is the position no ordering heuristic reaches by accident.
//
// THE SIGINT STEP IS THE DETERMINISTIC PART, and it is why the signal NAME
// differs. `waitFor` scans frames already received, so "c1 can still be killed"
// proves nothing on its own — a mutant that killed c1 early has already emitted
// its exit, and that frame would satisfy a bare liveness check. Asserting the
// exit carries SIGINT does discriminate: an exit produced by the earlier
// SIGTERM cannot report SIGINT, and a child has exactly one exit frame. No
// ordering assumption, no race.
//
// Adding `signal` to REQUEST_FRAMES (i.e. looking for a `remoteId` on a
// follow-on frame) answers ENOREMOTE and leaves every command running, so no
// exit arrives at all.
test('an id is bound to one remote: a follow-on frame carries no remoteId and reaches only its own child', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  for (const id of ['c1', 'c2', 'c3']) {
    l.send({ type: 'exec', id, remoteId: 'alpha', cwd: '/tmp', argv: ['sleep', '30'] });
  }
  // The signal frame names NO remote. The `id` is the whole address.
  l.send({ type: 'signal', id: 'c2', signal: 'SIGTERM', processGroup: true });
  const killed = await l.waitFor(f => f.type === 'exit' && f.id === 'c2');
  assert.equal(killed.signal, 'SIGTERM', 'the signal reached the child the id was bound to');

  // A fast negative. The barrier proves the `signal` frame was PROCESSED — it
  // does not prove a wrong kill's exit frame would already have been emitted, so
  // this assert is a strong signal rather than an ordering guarantee. The
  // deterministic discrimination is the SIGINT step below.
  l.send({ type: 'exec', id: 'barrier', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier');
  for (const id of ['c1', 'c3']) {
    assert.equal(l.frames.some(f => f.type === 'exit' && f.id === id), false,
      `${id} was untouched — the id, not "whatever is running", is the address`);
  }

  // THE DETERMINISTIC PROOF, and it also reaps both survivors rather than
  // leaving a detached `sleep` behind when the launcher is killed. A SIGINT exit
  // can only come from this frame; an exit already produced by the SIGTERM above
  // reports SIGTERM and reds here.
  for (const id of ['c1', 'c3']) {
    l.send({ type: 'signal', id, signal: 'SIGINT', processGroup: true });
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === id);
    assert.equal(exit.signal, 'SIGINT',
      `${id} was still alive and answered ITS OWN signal — not one aimed at another id`);
  }

  assert.equal(l.frames.some(f => f.type === 'error'), false,
    'a follow-on frame is never refused for naming no remote');
});

// PINS: a frame type cc DELETED is ignored — not answered, not fatal to a
// running command, and NOT FATAL TO THE CONNECTION EVEN WITH A MALFORMED
// PAYLOAD. §2 of the contract: "Unknown frame types are likewise ignored by
// both ends."
//
// This is not dead-code hygiene, and it pins two separate deletions:
//
//  1. The dispatch arms. The handler they replace set `state.closed`, SIGKILLed
//     the child and answered EUNSUPPORTED — so a stray frame would have killed a
//     live command AND answered an id cc was still waiting on.
//  2. `'stdin'` leaving PAYLOAD_FRAMES (src/launcher/protocol.mjs). While it was
//     listed there, `decodeFrame` validated the `dataB64` of a frame type that
//     no longer exists, so a corrupt payload on it threw a FATAL id-less EPROTO
//     and tore the whole connection down. The valid-base64 half of this test
//     cannot see that; the corrupt frame below is what pins it. The existing
//     unknown-type test uses `"weird"`, which was never in that set, so it is
//     blind to this too — as is cc's suite, which sends no `stdin` frames.
test('a deleted frame type is IGNORED — stdin and stdinClose neither refuse, kill the command, nor break the connection', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'exec', id: 'c1', remoteId: 'alpha', cwd: '/tmp', argv: ['cat'] });
  l.send({ type: 'stdin', id: 'c1', dataB64: Buffer.from('written\n').toString('base64') });
  l.send({ type: 'stdinClose', id: 'c1' });
  // A payload that is NOT canonical base64, on a deleted type. A frame type
  // still listed in PAYLOAD_FRAMES rejects this EPROTO and kills the
  // connection; an ignored type carries it as just another unknown field.
  // Byte-identical to the payload the `data`-frame test proves IS fatal.
  l.send({ type: 'stdin', id: 'c1', dataB64: 'V09STEQ=!!corrupted' });

  // A BARRIER, not a sleep: frames are handled in arrival order, so this exec's
  // exit proves every frame above was already processed — and that the
  // connection is still framing, which a teardown would have ended.
  l.send({ type: 'exec', id: 'barrier', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier');

  // ANY error frame, not just an id-addressed one: a connection-level refusal
  // is id-LESS, so narrowing this to `f.id === 'c1'` would let a teardown pass.
  assert.equal(l.frames.some(f => f.type === 'error'), false,
    'no error of any kind — a deleted type is ignored, not answered and not fatal');
  assert.equal(l.frames.some(f => f.type === 'stdout' && f.id === 'c1'), false,
    'the payload was not written into the child either');
  assert.equal(l.frames.some(f => f.type === 'exit' && f.id === 'c1'), false,
    'and nothing settled the id — the command is still running');

  // Positive proof the command is still LIVE (this asserts liveness, not id
  // routing — the binding test above is what pins the address).
  l.send({ type: 'signal', id: 'c1', signal: 'SIGTERM', processGroup: true });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'c1');
  assert.equal(exit.signal, 'SIGTERM');
});

test('an unknown frame type and a blank line are ignored, not errors', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'somethingFromTheFuture', id: 'x', nested: { a: 1 } });
  l.sendRaw('\n\n   \n');
  l.send({ type: 'exec', id: 'after', cwd: '/tmp', remoteId: 'nope', argv: ['true'] });
  // The connection is still framing correctly afterwards.
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'after');
  assert.equal(err.code, 'ENOREMOTE');
  assert.equal(l.frames.some(f => f.type === 'error' && f.id === 'x'), false,
    'the unknown type produced no error — it is the extension point');
});

test('a malformed line is a FATAL id-less EPROTO and the launcher exits non-zero', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.sendRaw('{not json at all\n');
  const err = await l.waitFor(f => f.type === 'error');
  assert.equal(err.code, 'EPROTO');
  assert.equal(err.id, undefined, 'id-less: the whole connection failed');
  const { code } = await l.exited;
  assert.notEqual(code, 0);
});

test('a data frame with non-canonical base64 is EPROTO and leaves NO partial file', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const target = path.join(store.dir, 'must-not-exist');
  await writeRecord(store.dir, record('alpha'));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'writeFile', id: 'w1', remoteId: 'alpha', path: target });
  l.send({ type: 'data', id: 'w1', seq: 0, dataB64: Buffer.from('HELLO').toString('base64') });
  // Valid JSON, valid line, unusable payload. A lenient decoder would keep the
  // readable prefix and report success for a TRUNCATED file.
  l.send({ type: 'data', id: 'w1', seq: 1, dataB64: 'V09STEQ=!!corrupted' });
  l.send({ type: 'end', id: 'w1' });

  const err = await l.waitFor(f => f.type === 'error');
  assert.equal(err.code, 'EPROTO');
  assert.equal(l.frames.some(f => f.type === 'writeFileResult'), false,
    'a corrupted payload must never report success');
  await l.exited;
  assert.equal(await fs.stat(target).then(() => 'exists', () => 'absent'), 'absent');
});

test('a line past MAX_LINE_BYTES is EPROTO', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  // One line, no newline until well past the ceiling.
  l.sendRaw(`{"type":"exec","id":"big","pad":"${'x'.repeat(MAX_LINE_BYTES + 16)}"}\n`);
  const err = await l.waitFor(f => f.type === 'error');
  assert.equal(err.code, 'EPROTO');
  assert.match(err.message, /exceeded/);
  const { code } = await l.exited;
  assert.notEqual(code, 0);
});

test('an unknown kind, and a missing --kind, refuse before any frame', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  for (const args of [['--kind', 'nonsense'], []]) {
    const l = new Launcher(args, { CODE_SYSTEM_STORE: store.dir });
    const { code } = await l.exited;
    assert.equal(code, 2, `${JSON.stringify(args)} must exit 2`);
    assert.equal(l.frames.length, 0, 'nothing was written to stdout');
    assert.match(l.stderr, /kind/);
  }
});

test('--remote is refused for a store-backed kind rather than silently ignored', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const l = new Launcher(['--kind', 'docker', '--remote', 'a=/tmp'], { CODE_SYSTEM_STORE: store.dir });
  const { code } = await l.exited;
  assert.equal(code, 2);
  assert.match(l.stderr, /config store/);
});

// PINS "read fresh per operation" WHERE THE INVARIANT ACTUALLY LIVES:
// StoreRemoteSource.lookup, called once per request frame on a LIVE connection.
// tests/store.test.mjs proves the store itself does not memoise, but a `Map`
// added inside lookup would pass that and every other file — and a remote the
// backend re-probes mid-connection would then serve a stale verdict until the
// launcher restarted. This is also the only test that drives the two-tier
// baseline design's real scenario: the backend writes a new verdict while a
// project is already pointed at that remote.
test('a record rewritten mid-connection is seen by the very next frame', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const l = new Launcher(['--kind', 'fake'], fakeEnv(store.dir));
  t.after(() => l.kill());
  await l.hello();

  // Served: the baseline is `unknown`, which the launcher treats as "no evidence".
  l.send({ type: 'exec', id: 'before', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'served'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'before')).code, 0);

  // The backend probes and writes an `unsupported` verdict, with the connection
  // still open and no restart.
  await writeRecord(store.dir, record('alpha', {
    baseline: {
      state: 'unsupported',
      fingerprint: 'fp2',
      missing: [{ capability: 'readDir', probe: 'find -printf', detail: 'find: unrecognized: -printf' }],
      checkedAt: '2026-09-03T00:00:00.000Z',
    },
  }));

  l.send({ type: 'exec', id: 'after', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'served'] });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'after');
  assert.equal(err.code, 'EUNKNOWN', 'the launcher re-read the record rather than answering from a cache');
  assert.match(err.message, /readDir/);
  assert.equal(l.frames.some(f => f.type === 'exit' && f.id === 'after'), false);

  // And it works in the other direction too — a fixed target clears itself.
  await writeRecord(store.dir, record('alpha'));
  l.send({ type: 'exec', id: 'fixed', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'served'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'fixed')).code, 0);
});
