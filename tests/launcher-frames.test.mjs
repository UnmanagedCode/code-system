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

// ── the exec seam, driven in-process ─────────────────────────────────
//
// Two obligations of the frame loop that no kind-level test can reach, because
// they are about what the CORE hands a kind and what it does with the kind's
// answer. Driven through `Session` directly with a recording stub transport, so
// they hold with no docker anywhere.

/** Records every ExecRequest and answers with a canned exit code / streams. */
function recordingTransport({ code = 0, stdout = '', stderr = '', classifyFailure } = {}) {
  const seen = [];
  return {
    seen,
    kind: 'stub',
    processGroupSignal: false,
    remotes: true,
    remoteDescriptors: false,
    validateConfig(raw) { return { ok: true, config: raw ?? {} }; },
    spawnPlan(_config, req) {
      seen.push(req);
      return {
        file: '/bin/sh',
        args: ['-c', `printf %s ${JSON.stringify(stdout)}; printf %s ${JSON.stringify(stderr)} >&2; exit ${code}`],
        env: null,
        detached: false,
      };
    },
    async reachability() { return { connected: true, detail: 'stub', fingerprint: 'stub:1' }; },
    async reap() {},
    ...(classifyFailure ? { classifyFailure } : {}),
  };
}

async function driveExec(transport, frame) {
  const { Session } = await import('../src/launcher/session.mjs');
  const out = [];
  const session = new Session({
    transport,
    source: { hasRemotes: () => true, ids: () => ['alpha'], mirrorFor: () => ({ mirrorRoot: null, exclude: [] }),
      async lookup(id) { return { ok: true, remote: { remoteId: id, config: { container: 'app' }, root: null } }; } },
    capabilities: { processGroupSignal: false, remotes: true, remoteDescriptors: false },
    write: f => out.push(f),
    onFatal: (m) => { throw new Error(m); },
  });
  await session.deliver({ type: 'hello', protocol: 1 });
  await session.deliver(frame);
  for (let i = 0; i < 200 && !out.some(f => f.id === frame.id && (f.type === 'exit' || f.type === 'error')); i++) {
    await new Promise(r => setTimeout(r, 10));
  }
  return out;
}

// PINS that the core hands the kind THE FRAME'S OWN env, with `null` for an
// absent one — never its own `process.env`. That substitution was the shipped
// behaviour before this card, and for `host` it is indistinguishable, which is
// why it has to be asserted on the ExecRequest itself rather than on an outcome.
// For docker it decides whether every cc derivation runs with the CONTAINER's
// PATH or with cc's (measured: `env: 'git': No such file or directory`).
test("an absent frame `env` reaches the kind as null, not as the launcher's process.env", async () => {
  const t1 = recordingTransport();
  await driveExec(t1, { type: 'exec', id: 'a', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  assert.equal(t1.seen[0].env, null, "'inherit the far side' must not be spelled as cc's own environment");
  assert.equal(t1.seen[0].remoteId, 'alpha', 'and the binding travels beside it, not inside it');

  // A supplied env is passed through UNTOUCHED — CC_REMOTE is the kind's
  // overlay, not the core's, so a frame-supplied one survives to this point.
  const t2 = recordingTransport();
  await driveExec(t2, {
    type: 'exec', id: 'b', remoteId: 'alpha', cwd: '/tmp', argv: ['true'],
    env: { PATH: '/p', CC_REMOTE: 'frame-supplied' },
  });
  assert.deepEqual(t2.seen[0].env, { PATH: '/p', CC_REMOTE: 'frame-supplied' });
});

// PINS that `classifyFailure` is WIRED, not merely implemented: a kind's verdict
// replaces the `exit` frame with an id-addressed `error`. Without the wiring a
// stopped container is reported as the command's own non-zero exit — which is
// exactly what acceptance 8 forbids, and it is invisible in a kind-level test of
// the classifier alone.
test('a kind\'s classifyFailure verdict replaces the exit frame with an id-addressed error', async () => {
  const verdict = { code: 'ENOREMOTE', message: "container 'app' is not running", stderr: 'daemon said so' };
  const withHook = recordingTransport({
    code: 1, stderr: 'Error response from daemon: …',
    classifyFailure: (config, res) => {
      assert.deepEqual(config, { container: 'app' }, 'the kind is handed the remote\'s own config');
      assert.equal(res.code, 1);
      assert.match(res.stderr, /Error response from daemon/, 'and a head of the streams to read');
      return verdict;
    },
  });
  const out = await driveExec(withHook, { type: 'exec', id: 'c', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  const err = out.find(f => f.type === 'error' && f.id === 'c');
  assert.ok(err, `expected an error frame; got ${JSON.stringify(out)}`);
  assert.equal(err.code, 'ENOREMOTE');
  assert.equal(err.exitCode, 1, 'the transport exit code is still reported');
  assert.equal(out.some(f => f.type === 'exit' && f.id === 'c'), false, 'and NO exit frame');

  // A null verdict — every kind without the hook, and the common case within
  // one — leaves the exit frame exactly as it was.
  const noVerdict = recordingTransport({ code: 3, classifyFailure: () => null });
  const out2 = await driveExec(noVerdict, { type: 'exec', id: 'd', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  assert.equal(out2.find(f => f.type === 'exit' && f.id === 'd').code, 3);
  assert.equal(out2.some(f => f.type === 'error' && f.id === 'd'), false);

  // A kind with no hook at all must be unaffected.
  const noHook = recordingTransport({ code: 3 });
  const out3 = await driveExec(noHook, { type: 'exec', id: 'e', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  assert.equal(out3.find(f => f.type === 'exit' && f.id === 'e').code, 3);
});

// PINS the bound on what `classifyFailure` is shown, and — the part that
// matters — that it is the LEADING bytes. Both guards in every kind's
// classifier anchor at byte 0 (`startsWith`, `=== ''`), so a mutant taking the
// TAIL of a chatty stream would silently stop recognising a transport failure
// whose message arrived first, which is every one of them.
test('classifyFailure sees a bounded HEAD of each stream, taken from the front', async () => {
  let seen = null;
  // BOTH PAYLOADS MUST DIFFER HEAD FROM TAIL, or the leg pins nothing: 600
  // identical bytes capped to 512 are byte-identical whichever end you take, and
  // a `slice(-512)` mutant passes.
  const noisy = recordingTransport({
    code: 1,
    stdout: `OPENS-HERE${'A'.repeat(580)}ENDS-HERE`,
    stderr: `Error response from daemon: ${'B'.repeat(560)}ENDS-HERE`,
    classifyFailure: (_config, res) => { seen = res; return null; },
  });
  await driveExec(noisy, { type: 'exec', id: 'h', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  assert.ok(seen, 'the hook was consulted');
  assert.equal(seen.stdout.length, 512, 'stdout is capped');
  assert.equal(seen.stderr.length, 512, 'stderr is capped');

  assert.ok(seen.stdout.startsWith('OPENS-HERE'), 'stdout is the HEAD…');
  assert.equal(seen.stdout.includes('ENDS-HERE'), false, '…and not the tail');
  assert.ok(seen.stderr.startsWith('Error response from daemon: '),
    'a transport message arrives first, so a tail-shaped head would lose it');
  assert.equal(seen.stderr.includes('ENDS-HERE'), false, 'stderr is the head too');
});

// PINS that a failed reap is REPORTED rather than swallowed, and that reporting
// it does not take the connection down. Both halves matter: a silent catch makes
// a relay that could not run indistinguishable from a clean shutdown (the MUST-3
// hazard itself), and a throw that escaped would fail every other target's
// in-flight work over one container's leftovers.
test('a reap that could not be proved to have run is reported, and does not kill the session', async () => {
  const { Session } = await import('../src/launcher/session.mjs');
  const warnings = [];
  const out = [];
  const transport = recordingTransport({ code: 0 });
  transport.reap = async () => { throw new Error('reap could not be proved to have run'); };
  const session = new Session({
    transport,
    source: { hasRemotes: () => true, ids: () => ['alpha'], mirrorFor: () => ({ mirrorRoot: null, exclude: [] }),
      async lookup(id) { return { ok: true, remote: { remoteId: id, config: {}, root: null } }; } },
    capabilities: { processGroupSignal: false, remotes: true, remoteDescriptors: false },
    write: f => out.push(f),
    warn: m => warnings.push(m),
    onFatal: (m) => { throw new Error(`the session died on a failed reap: ${m}`); },
  });
  await session.deliver({ type: 'hello', protocol: 1 });
  await session.deliver({ type: 'exec', id: 'r', remoteId: 'alpha', cwd: '/tmp', argv: ['sleep', '30'] });
  await session.deliver({ type: 'close', id: 'r' });
  await session.shutdown();

  assert.equal(warnings.length >= 1, true, `the failure must be surfaced; warnings=${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /reap/);
  assert.match(warnings[0], /alpha/, 'and it names the remote whose far side may have leaked');
});
