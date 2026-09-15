// THE HELD-OPEN CHANNEL'S FRAMING AND OP STATE MACHINE, driven against a plain
// local `/bin/sh` — the same shell a container's `docker exec -i … /bin/sh`
// gives us, with no docker anywhere. Everything here is deterministic: no
// wall-clock dependence, no network, and the idle deadline is INJECTED in
// milliseconds rather than waited out.
//
// Every test names the invariant it pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelPool, buildOpCommand } from '../src/launcher/channel.mjs';
import { makeNonce } from '../src/launcher/fileops.mjs';

// A Transport offering a channel that is just this machine's `/bin/sh` — which
// is exactly what `docker exec -i <container> /bin/sh` hands the pool, minus
// the container.
const shTransport = { kind: 'fake', channelPlan() { return { file: '/bin/sh', args: [] }; } };

function pool(t, opts = {}) {
  const p = new ChannelPool({ transport: shTransport, warn: () => {}, ...opts });
  t.after(() => p.close());
  return p;
}

const REQ = { config: {}, remoteId: 'r1', token: 'tok' };

// Bounded poll: no sleeps, no timing luck.
async function until(pred, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise(r => setTimeout(r, 10));
  }
}

// Wait until the pool has an idle channel, so a test that is ABOUT the framing
// is not also a test of the lazy open's timing, and DISPATCH one op — returning
// the still-pending promise, which several tests below need unresolved.
// Boxed, because `await` unwraps a promise returned from an async function —
// and several tests below need the op still PENDING.
async function dispatch(p, req) {
  const warm = await until(() => p.tryRun({ ...REQ, script: ':' }));
  assert.ok(warm, 'no channel became ready');
  await warm;
  const run = p.tryRun({ ...REQ, ...req });
  assert.ok(run, 'the channel must be idle for this op');
  return { run };
}

/** Dispatch and await — the shape most framing tests want. */
const onChannel = async (p, req) => (await dispatch(p, req)).run;

// ── framing ──────────────────────────────────────────────────────────

// PINS that a call settles on the AND of both streams' sentinels, and that
// neither stream's output carries a byte of the framing. A settle on one stream
// alone would truncate whichever of the two was still arriving.
test('a call settles only when BOTH streams have closed, and each stream is clean', async (t) => {
  const p = pool(t);
  const res = await onChannel(p, { script: 'printf out; printf err >&2' });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.toString('utf8'), 'out');
  assert.equal(res.stderr, 'err');
});

// PINS that output which does NOT end in a newline comes back byte-identically.
// The framing prepends its own `\n` to the sentinel, so an off-by-one here would
// append or eat a newline on every single op — silently, and on every target.
test('output is byte-identical whether or not it ends in a newline', async (t) => {
  const p = pool(t);
  assert.equal((await onChannel(p, { script: 'printf "a\\nb\\n"' })).stdout.toString(), 'a\nb\n');
  assert.equal((await onChannel(p, { script: 'printf "a\\nb"' })).stdout.toString(), 'a\nb');
  assert.equal((await onChannel(p, { script: 'true' })).stdout.toString(), '');
});

// PINS THE PER-CALL NONCE. A fixed sentinel string would let a command that
// merely echoed it settle its own call early — and the far side is running paths
// and content cc did not author.
test('a foreign-nonce closing line does not settle the call early', async (t) => {
  const p = pool(t);
  const res = await onChannel(p, {
    script: `printf '\\nCCEND-deadbeefcafe 0\\n'; printf '\\nCCEND-000000000000\\n' >&2; printf tail; exit 7`,
  });
  assert.equal(res.code, 7, 'the real sentinel carried the real exit code');
  assert.equal(res.stdout.toString().endsWith('tail'), true,
    `everything after the forgery is still output: ${JSON.stringify(res.stdout.toString())}`);
  assert.equal(res.stderr.includes('CCEND-000000000000'), true,
    'and a foreign stderr sentinel is stderr, not a boundary');
});

// PINS THE COMMAND SHAPE ITSELF, which is the half of the framing no round trip
// can show: the per-call nonce reaches BOTH sentinels and the ready marker, the
// payload is framed by an EXACT BYTE COUNT with no delimiter of any kind, and
// the reap token rides as the COMMAND's env prefix rather than as a
// channel-wide variable.
test('the op command frames by byte count with a per-call nonce and a per-op token prefix', () => {
  const a = makeNonce();
  const b = makeNonce();
  assert.notEqual(a, b, 'makeNonce is fresh per call — the property this framing rests on');

  const withPayload = buildOpCommand({ nonce: a, token: 'TOK', script: 'cat', payloadBytes: 1234 });
  assert.match(withPayload, /printf '\\nCCRDY-/, 'the ready marker precedes a payload');
  assert.ok(withPayload.includes(`CCRDY-${a}`), 'and carries this call\'s nonce');
  assert.ok(withPayload.includes('head -c 1234 |'), 'the payload is framed by exact byte count');
  assert.ok(withPayload.includes('CC_EXEC_TOKEN=TOK /bin/sh -c'),
    'the token is the COMMAND\'s env prefix, so it reaches the op tree and not the channel shell');
  assert.ok(withPayload.includes(`CCEND-${a} %s`), 'the stdout sentinel carries the exit code');
  assert.ok(withPayload.includes(`printf '\\nCCEND-${a}\\n' >&2`), 'and stderr gets its own, bare');
  assert.equal(/<<-?\s*\w/.test(withPayload), false, 'no heredoc delimiter anywhere');

  const noPayload = buildOpCommand({ nonce: b, token: 'TOK', script: 'true', payloadBytes: null });
  assert.equal(noPayload.includes('CCRDY'), false, 'no marker when there is no payload to release');
  assert.ok(noPayload.includes('< /dev/null'),
    'and the op cannot read the channel\'s own command stream');
  assert.equal(noPayload.includes(a), false, 'two ops never share a nonce');
});

// PINS the `$?` capture: the exit code rides the stdout sentinel, so every code
// cc branches on has to survive the round trip.
test('the exit code comes back off the stdout sentinel', async (t) => {
  const p = pool(t);
  for (const code of [0, 1, 7, 137]) {
    assert.equal((await onChannel(p, { script: `exit ${code}` })).code, code);
  }
});

// PINS THE READY-MARKER / EXACT-BYTE-COUNT FRAMING, which is the one piece of
// this design that cannot be derived from the wire contract.
//
// dash OVER-READS ITS COMMAND STREAM: writing the command and the payload
// back-to-back lets the shell swallow the payload into its own input buffer,
// where it is parsed as script text while `head -c` gets nothing. The channel
// therefore emits a ready marker FIRST and releases the payload only when it
// comes back — at which point the shell has finished parsing and its buffer is
// empty, so `head -c <n>` reads exactly the payload out of the pipe.
//
// WITHOUT THE READY MARKER THIS TEST HANGS. It is not belt-and-braces.
test('a stdin payload framed by exact byte count round-trips byte-exact, twice in a row', async (t) => {
  const p = pool(t);
  // NUL, a quote, a dollar, a backtick and newlines: everything that would be
  // syntax if the payload ever reached the shell as script text.
  const payload = Buffer.concat([Buffer.from("a'b$c`d\ne f\n", 'utf8'), Buffer.from([0]), Buffer.from('z\n')]);
  for (let i = 0; i < 2; i++) {
    const res = await onChannel(p, { script: 'cat', stdinData: payload });
    assert.equal(res.code, 0);
    assert.deepEqual(res.stdout, payload, `round trip ${i} must be byte-exact`);
  }
  // AND THE CHANNEL IS STILL USABLE: `head -c <n>` must not have over-read the
  // pipe, or the next command would be short by the bytes it swallowed.
  assert.equal((await onChannel(p, { script: 'printf after' })).stdout.toString(), 'after');
});

// PINS the same framing at a size where any buffering mistake shows: a payload
// several pipe buffers long cannot be written in one go.
test('a large stdin payload round-trips byte-exact', async (t) => {
  const p = pool(t);
  const payload = Buffer.alloc(512 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const res = await onChannel(p, { script: 'cat', stdinData: payload });
  assert.equal(res.code, 0);
  assert.deepEqual(res.stdout, payload);
});

// PINS the per-op reap handle. The token rides as the COMMAND's env prefix, so
// the op's whole process tree carries it while the channel shell's own
// environment does not — which is what keeps `buildReapScript` able to kill ONE
// op without taking the channel and every other op on it with it.
test('each op sees only its own CC_EXEC_TOKEN, and nothing leaks between ops', async (t) => {
  const p = pool(t);
  const read = 'printf %s "${CC_EXEC_TOKEN-unset}"';
  assert.equal((await onChannel(p, { script: read, token: 'abc123' })).stdout.toString(), 'abc123');
  assert.equal((await onChannel(p, { script: read, token: 'def456' })).stdout.toString(), 'def456');
});

// ── never queue ──────────────────────────────────────────────────────

// PINS NEVER-QUEUE. A single `sh` is strictly sequential, so an op that waited
// for a busy channel would serialise cc behind it — the exact hazard
// `#readFileOpen`'s detached body exists to avoid. An op that finds nothing idle
// is told so IMMEDIATELY and takes today's spawn instead.
test('a second op while one is in flight is refused rather than queued', async (t) => {
  const p = pool(t);
  const { run: first } = await dispatch(p, { script: 'printf a' });
  // Same tick: the first op has been dispatched and has not settled.
  assert.equal(p.tryRun({ ...REQ, script: 'printf b' }), null,
    'the pool must answer "unavailable", never a queued promise');
  await first;
});

// ── failure asymmetry ────────────────────────────────────────────────

// The far side kills the channel shell out from under its own op — exactly what
// a container-side `docker exec … /bin/sh` dying mid-op looks like.
const KILL_THE_CHANNEL = 'kill -9 $PPID; exec cat';

// PINS THE FAILURE ASYMMETRY'S REPORTING CODE. `ETRANSPORT` is what keeps a dead
// channel out of cc's errno classifier — which is precisely what stops a retried
// exclusive create's `EEXIST` being reported as a failure that actually
// succeeded.
test('a channel that dies mid-op fails that op with ETRANSPORT and is dropped from the pool', async (t) => {
  const p = pool(t);
  const { run } = await dispatch(p, { script: KILL_THE_CHANNEL });
  await assert.rejects(run, (e) => {
    assert.equal(e.code, 'ETRANSPORT');
    return true;
  });
  assert.equal(p.tryRun({ ...REQ, script: ':' }), null,
    'the dead channel is not offered again');
  assert.equal(p.stats().channels, 1, 'exactly one channel had opened before the death');
});

// PINS THAT AN OP IS NEVER RE-DISPATCHED after a channel death, for any op kind.
// A mutating derivation or a `writeFile` whose first attempt LANDED must report
// a failure rather than run a second time.
test('an op is never re-dispatched after a channel death', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-chan-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const witness = path.join(tmp, 'ran');

  const p = pool(t);
  // Records that it ran, then kills the channel with itself still in flight.
  const { run } = await dispatch(p, {
    script: `printf x >> ${JSON.stringify(witness)}; ${KILL_THE_CHANNEL}`,
  });
  await assert.rejects(run, (e) => e.code === 'ETRANSPORT');
  assert.equal(await fs.readFile(witness, 'utf8'), 'x', 'the op ran exactly once');
  // Give any retry every chance to show up, then re-read.
  const retried = await until(() => fs.readFile(witness, 'utf8').then(s => s.length > 1), 300);
  assert.equal(retried, null, 'and was never re-dispatched');
});

// PINS lazy relaunch with no second backoff layer: a dead channel is simply not
// offered, and the next op that finds the pool short reopens one.
test('the pool reopens lazily after a death', async (t) => {
  const p = pool(t);
  await assert.rejects((await dispatch(p, { script: KILL_THE_CHANNEL })).run, (e) => e.code === 'ETRANSPORT');
  const res = await onChannel(p, { script: 'printf recovered' });
  assert.equal(res.stdout.toString(), 'recovered');
  assert.equal(p.stats().channels, 2, 'a fresh channel, not the dead one');
});

// ── the idle watchdog ────────────────────────────────────────────────

// PINS THE IDLE WATCHDOG. A framing desync has exactly one signature — an op
// that never emits its sentinel — and nothing in this design may let that become
// a hung worker or a permanently wedged pool slot.
//
// The fixture blocks without writing a byte, so no sentinel can ever arrive.
// The deadline is INJECTED at 150 ms, so nothing is waited out: the channel is
// torn down long before the far side would have ended on its own.
test('an op that never answers is failed at the idle deadline and the channel is reclaimed', async (t) => {
  const p = pool(t, { idleMs: 150 });
  const { run } = await dispatch(p, { script: 'exec sleep 5' });
  await assert.rejects(run, (e) => {
    assert.equal(e.code, 'ETRANSPORT');
    assert.match(e.message, /idle/);
    return true;
  });
  assert.equal(p.tryRun({ ...REQ, script: ':' }), null, 'the wedged channel is gone, not left busy for ever');
  // AND THE POOL RECOVERS: the next op is served on a fresh channel.
  assert.equal((await onChannel(p, { script: 'printf recovered' })).stdout.toString(), 'recovered');
});

// PINS *IDLE*, NOT TOTAL ELAPSED — the distinction the whole constant rests on.
// A `readDir` over a huge directory, or a large `readFile`'s base64, is slow and
// progressively NOISY; only a desynced op is silent. A total-elapsed deadline
// would have to be set above the worst pathological case.
test('an op that keeps producing output outlives its idle deadline many times over', async (t) => {
  const p = pool(t, { idleMs: 400 });
  // Six chunks at ~100 ms: well past 400 ms in total, never 400 ms silent.
  const res = await onChannel(p, {
    script: 'i=0; while [ $i -lt 6 ]; do printf .; sleep 0.1; i=$((i+1)); done; printf done',
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.toString(), '......done');
});

// ── cancellation ─────────────────────────────────────────────────────

// PINS that an aborted op releases its caller at once WITHOUT taking the channel
// with it: `close` on a file operation reaps by token and the op still emits its
// sentinel, so the channel is RECLAIMED rather than destroyed. Tearing it down
// for one cancellation would cost every other op on it.
test('an aborted op rejects at once and the channel survives to serve the next one', async (t) => {
  // ONE channel allowed, which is what makes this discriminating: had the
  // abort torn the channel down, the pool would have had to OPEN a second one
  // to serve the next op, and the census would say 2.
  const p = pool(t, { idleMs: 2_000, maxPerTarget: 1 });
  const ac = new AbortController();
  const { run } = await dispatch(p, { script: 'printf slow', signal: ac.signal });
  ac.abort();
  await assert.rejects(run, (e) => /closed by the client/.test(e.message));
  assert.equal((await onChannel(p, { script: 'printf next' })).stdout.toString(), 'next');
  assert.equal(p.stats().channels, 1, 'the same channel was reused, not replaced');
});

// ── the pool's own boundaries ────────────────────────────────────────

// PINS the census counters the shutdown line reports: `admitted` is what was
// OFFERED to the pool, `carried` is what actually rode a channel, and the two
// differ exactly by the ops that found nothing idle.
test('the pool counts what it was offered and what it carried', async (t) => {
  const p = pool(t);
  assert.equal(p.tryRun({ ...REQ, script: ':' }), null, 'the very first op finds no channel');
  assert.deepEqual(p.stats(), { admitted: 1, carried: 0, channels: 0 });
  await onChannel(p, { script: 'true' });
  const s = p.stats();
  assert.ok(s.carried >= 1, `something was carried: ${JSON.stringify(s)}`);
  assert.ok(s.admitted > s.carried, 'and the miss is still counted as admitted');
  assert.equal(s.channels, 1, 'a channel that opened successfully is counted');
});

// PINS THE KILL SWITCH. `CODE_SYSTEM_CHANNEL=0` must remove the pool entirely,
// not merely discourage it — it is the conformance suite's off arm and the
// operator's escape hatch.
test('a disabled pool offers nothing at all, and does not even count', async (t) => {
  const p = pool(t, { enabled: false });
  assert.equal(p.tryRun({ ...REQ, script: ':' }), null);
  assert.deepEqual(p.stats(), { admitted: 0, carried: 0, channels: 0 });
});

// PINS that a kind which offers no `channelPlan` is untouched — `ssh` and `host`
// must be byte-identical after this change, and the seam is optional for exactly
// that reason.
test('a transport with no channelPlan is never given a channel', async (t) => {
  const p = new ChannelPool({ transport: { kind: 'ssh' }, warn: () => {} });
  t.after(() => p.close());
  assert.equal(p.tryRun({ ...REQ, script: ':' }), null);
  assert.deepEqual(p.stats(), { admitted: 0, carried: 0, channels: 0 });
});
