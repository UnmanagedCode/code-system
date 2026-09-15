// A HELD-OPEN COMMAND CHANNEL, and the pool that owns it.
//
// THE COST THIS REMOVES IS THE SPAWN, NOT THE COMMAND. Every frame today costs
// one `docker exec`: a host process, a daemon round trip and a container exec
// setup — measured at 84–94 ms median against a live container, where the same
// work written into one long-lived `docker exec -i <container> /bin/sh` costs
// 3.5–4.4 ms. So this module holds that shell open and writes framed commands
// into it.
//
// NOTHING IS DEPLOYED INTO THE TARGET. The channel execs a POSIX shell the
// container already provides — the same dependency every derived file operation
// already has (`tail`/`head`/`base64` in fileops.mjs).
//
// THE SEAM IS `Transport.channelPlan`, and it is OPTIONAL. `ssh` and `host`
// implement none, so every call here answers "no channel" for them and they take
// today's path unchanged.
//
// ONE RESPONSIBILITY: the pool, the framing and the op state machine. Which
// FRAMES may ride it is admission.mjs's question, and reaping is the kind's.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { makeNonce, shellQuote } from './fileops.mjs';
import { TOKEN_VAR } from './kinds/reapscript.mjs';
import { ProtocolError } from './protocol.mjs';

// THE OPERATOR'S ESCAPE HATCH AND THE CONFORMANCE SUITE'S OFF ARM. `=0` removes
// the pool entirely rather than discouraging it, so the off arm really is
// today's code path.
export const CHANNEL_ENV = 'CODE_SYSTEM_CHANNEL';

// HOW LONG A DISPATCHED OP MAY GO WITHOUT PRODUCING A SINGLE BYTE ON EITHER
// STREAM before its channel is declared dead.
//
// IDLE, NOT TOTAL ELAPSED, and the distinction is the whole reason this number
// can be small. A framing desync has exactly one signature — an op that never
// emits its sentinel, silent for ever — while every legitimately slow admitted
// op is either fast and silent (`mkdir`, `chmod`, `rm -d`, `unlink`, `ln`) or
// slow and progressively NOISY (`find` over a very large directory, a large
// `readFile`'s base64). A total-elapsed deadline would have to clear the worst
// pathological `readDir`; an idle one needs no such margin.
//
// ANCHORED AT BOTH ENDS. The measured medians are 3.5–4.4 ms and the largest
// payload the protocol permits (`MAX_FILE_BYTES`, 32 MiB) streams at a measured
// ~27 ms/MiB — under a second end to end — so this is an order of magnitude
// above anything real. And it is a sixth of cc's own 60 s abandon
// (`DEFAULT_OP_TIMEOUT_MS`), so the watchdog reclaims a wedged channel long
// before cc gives up and can never be the first to fail an op that is merely
// slow.
//
// WHY NOT LEAVE IT TO CC AT ALL: cc does reach an in-flight channel op on both
// paths at 60 s (`#exec`'s abandon timer and `#request`'s `done()` each send
// `{type:'close', id}`), but that is 60 s of a channel held by an op that will
// never answer, it depends on the counterparty sending a frame, and a reap does
// not by itself produce a sentinel — so `close` alone would leave the channel
// unusable rather than reclaimed.
export const CHANNEL_IDLE_MS = 10_000;

// Channels per (container, user, remoteId). A single `sh` is strictly
// sequential, so without lazy growth any concurrency in cc's lookups would leave
// all but one op on the slow path. Four idle shells per container is the same
// order as the transient exec clients today's code creates and destroys per op.
// A module constant, not a config knob.
export const MAX_CHANNELS_PER_TARGET = 4;

/**
 * Is the pool on? Off only for an explicit `0`, so an unset or unreadable
 * variable is the shipped behaviour.
 */
export function channelEnabled(env = process.env) {
  return String(env[CHANNEL_ENV] ?? '').trim() !== '0';
}

// The two framing markers. Each is always emitted with a LEADING NEWLINE, and
// each is followed by a per-call nonce — never a fixed string, so a command that
// echoes one cannot settle its own call early.
const RDY = 'CCRDY';
const END = 'CCEND';

/**
 * ONE OP'S COMMAND, as it is written into the channel.
 *
 * A SINGLE COMPOUND COMMAND, deliberately. The shell cannot execute any part of
 * `{ … }` before it has parsed the whole of it, which is what makes the ready
 * marker's guarantee independent of the shell's input-buffer size: by the time
 * the marker is printed, everything this op will ever need to parse has already
 * been read out of the pipe.
 *
 * THE READY MARKER IS LOAD-BEARING, not belt-and-braces. dash OVER-READS its
 * command stream: writing the command and a stdin payload back-to-back lets the
 * shell swallow the payload into its own buffer, where it is parsed as script
 * text while `head -c` gets nothing. So the marker goes out first and the
 * payload is released only when it comes back — at which point the shell has
 * finished parsing, its buffer is empty, and `head -c <n>` reads exactly the
 * payload out of the pipe. The payload is still framed by EXACT BYTE COUNT,
 * known host-side, unspoofable by content, with no delimiter anywhere.
 *
 * `< /dev/null` ON THE NO-PAYLOAD BRANCH matches the spawn path's
 * `stdin: 'ignore'` and keeps the channel's own command stream out of reach of
 * the op — an op that read it would eat the next command.
 *
 * THE TOKEN RIDES AS THE COMMAND'S ENV PREFIX, never as a channel-wide
 * variable: a prefix assignment reaches that command's whole process tree and
 * nothing else, so the channel shell's own `/proc/<pid>/environ` carries no
 * token and the unmodified `buildReapScript` kills one op without touching the
 * channel or any other op on it.
 *
 * @param {{nonce:string, token:string, script:string, payloadBytes:number|null}} o
 */
export function buildOpCommand({ nonce, token, script, payloadBytes = null }) {
  const q = shellQuote(script);
  const parts = [];
  if (payloadBytes !== null) {
    parts.push(`printf '\\n${RDY}-${nonce}\\n'`);
    parts.push(`head -c ${payloadBytes} | ${TOKEN_VAR}=${token} /bin/sh -c ${q}`);
  } else {
    parts.push(`${TOKEN_VAR}=${token} /bin/sh -c ${q} < /dev/null`);
  }
  parts.push('rc=$?');
  // TWO SENTINELS, ONE PER STREAM, each carrying its own LEADING NEWLINE so
  // "start of line" is free and the scanner never has to remember whether it
  // sits at a line boundary — the idiom cc's own `ClosingLineScan` uses. The
  // stdout one carries the exit code; the stderr one is bare.
  parts.push(`printf '\\n${END}-${nonce} %s\\n' "$rc"`);
  parts.push(`printf '\\n${END}-${nonce}\\n' >&2`);
  return `{ ${parts.join('; ')}; }\n`;
}

/**
 * Scans a stream for a needle, emitting everything before it and holding back
 * only the bytes that could still be a partial match. Output is therefore
 * STREAMED rather than buffered, and memory is bounded by the needle rather
 * than by the op's output size.
 */
class Scan {
  #needle;
  #pending = Buffer.alloc(0);
  seen = false;
  rest = Buffer.alloc(0);

  constructor(needle) { this.#needle = Buffer.from(needle, 'utf8'); }

  /** @returns {Buffer} the bytes that are definitely not part of the needle */
  push(chunk) {
    const buf = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    const i = buf.indexOf(this.#needle);
    if (i !== -1) {
      this.seen = true;
      this.rest = buf.subarray(i + this.#needle.length);
      this.#pending = Buffer.alloc(0);
      return buf.subarray(0, i);
    }
    const keep = Math.min(buf.length, this.#needle.length - 1);
    this.#pending = buf.subarray(buf.length - keep);
    return buf.subarray(0, buf.length - keep);
  }
}

export class ChannelPool {
  #transport;
  #warn;
  #idleMs;
  #maxPerTarget;
  #enabled;
  #buckets = new Map();
  #admitted = 0;
  #carried = 0;
  #opened = 0;
  #closed = false;

  constructor({
    transport, warn = () => {}, idleMs = CHANNEL_IDLE_MS,
    maxPerTarget = MAX_CHANNELS_PER_TARGET, enabled = true,
  }) {
    this.#transport = transport;
    this.#warn = warn;
    this.#idleMs = idleMs;
    this.#maxPerTarget = maxPerTarget;
    this.#enabled = enabled === true && typeof transport?.channelPlan === 'function';
  }

  /** What `shutdown()` reports: carried / admitted / channels opened. */
  stats() {
    return { carried: this.#carried, admitted: this.#admitted, channels: this.#opened };
  }

  /**
   * Run one op on an idle channel, or answer `null` — NEVER a queued promise.
   *
   * NO OP EVER WAITS. A single `sh` is strictly sequential, so an op that queued
   * behind a busy channel would serialise cc exactly as `#readFileOpen`'s
   * detached body exists to prevent. An op that finds nothing idle takes today's
   * per-op spawn immediately, and a new channel is opened in the BACKGROUND for
   * whoever comes next — so the worst case is exactly today's latency and the
   * pool can never become a bottleneck.
   *
   * @returns {Promise<{code:number, stdout:Buffer, stderr:string}>|null}
   */
  tryRun({
    config, remoteId = null, script, stdinData = null, token,
    signal = null, collect = true, onStdout = null, onStderr = null,
  }) {
    if (!this.#enabled || this.#closed) return null;
    this.#admitted += 1;
    let plan;
    try { plan = this.#transport.channelPlan(config ?? {}, { remoteId }); }
    catch { return null; }
    if (!plan) return null;

    const bucket = this.#bucketFor(plan);
    const ch = bucket.channels.find(c => c.ready && !c.busy && !c.dead);
    if (!ch) { this.#grow(bucket); return null; }
    this.#carried += 1;
    return this.#dispatch(ch, { script, stdinData, token, signal, collect, onStdout, onStderr });
  }

  /**
   * Close every channel. Called from `Session.shutdown()` inside its existing
   * reap deadline.
   *
   * THE CHANNEL NEEDS NO REAP TOKEN OF ITS OWN, and that is measured rather than
   * assumed: a shell blocked on a `docker exec`'s stdin dies with its host
   * client (unlike a RUNNING command, which is why the per-op relay exists), and
   * closing stdin ends it cleanly. In-flight channel OPS are already covered by
   * `#fileOps`/`#execs` reaping, by their own per-op tokens.
   */
  close() {
    this.#closed = true;
    for (const bucket of this.#buckets.values()) {
      for (const ch of [...bucket.channels]) this.#kill(ch, 'the launcher is shutting down');
    }
    this.#buckets.clear();
  }

  #bucketFor(plan) {
    // THE KEY IS THE PLAN'S OWN ARGV — which for docker is
    // (container, user, remoteId), since the rest is invariant across every
    // candidate op. No separate key derivation to keep in step with the plan.
    const key = JSON.stringify([plan.file, ...plan.args]);
    let bucket = this.#buckets.get(key);
    if (!bucket) { bucket = { plan, channels: [], opening: 0 }; this.#buckets.set(key, bucket); }
    return bucket;
  }

  // Lazily, in the background, and ONE AT A TIME: an op that finds nothing idle
  // has already taken the spawn path, so a thundering herd of opens would only
  // multiply `docker exec` invocations against a target that may be gone.
  #grow(bucket) {
    if (this.#closed) return;
    if (bucket.opening > 0) return;
    if (bucket.channels.length + bucket.opening >= this.#maxPerTarget) return;
    bucket.opening += 1;
    void this.#open(bucket).finally(() => { bucket.opening -= 1; });
  }

  async #open(bucket) {
    let proc;
    try {
      proc = spawn(bucket.plan.file, bucket.plan.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: bucket.plan.env ?? undefined,
      });
    } catch { return; }
    const ch = { proc, bucket, ready: false, busy: false, dead: false, op: null, timer: null };
    proc.stdin.on('error', () => { /* a dead far side is reported by the op, not here */ });
    proc.stdout.on('data', b => this.#onData(ch, 'out', b));
    proc.stderr.on('data', b => this.#onData(ch, 'err', b));
    proc.on('error', e => this.#kill(ch, `the channel could not be started: ${e?.message ?? e}`));
    proc.on('close', () => this.#kill(ch, 'the channel ended'));

    // A HANDSHAKE BEFORE THE CHANNEL IS OFFERED, so "ready" means "proved
    // alive". Without it, a channel against a stopped container would be handed
    // an op that then failed `ETRANSPORT` — losing `classifyFailure`'s
    // operator-facing `ENOREMOTE` message, which is the answer that actually
    // tells someone what to do.
    try {
      const res = await this.#dispatch(ch, {
        script: ':', token: randomBytes(12).toString('hex'), collect: false,
      });
      if (res.code !== 0) { this.#kill(ch, `the channel answered ${res.code} to its handshake`); return; }
    } catch { return; }
    if (ch.dead || this.#closed) { this.#kill(ch, 'the launcher is shutting down'); return; }
    ch.ready = true;
    bucket.channels.push(ch);
    this.#opened += 1;
  }

  #dispatch(ch, { script, stdinData = null, token, signal = null, collect = true, onStdout = null, onStderr = null }) {
    const nonce = makeNonce();
    return new Promise((resolve, reject) => {
      const op = {
        nonce,
        collect,
        onStdout,
        onStderr,
        out: new Scan(`\n${END}-${nonce} `),
        err: new Scan(`\n${END}-${nonce}\n`),
        rdy: stdinData ? new Scan(`\n${RDY}-${nonce}\n`) : null,
        stdinData,
        outChunks: [],
        errChunks: [],
        rcBuf: Buffer.alloc(0),
        code: null,
        settled: false,
        // ORPHANED: the caller has gone (a `close`, a `signal`, a timeout) but
        // the far side has not. The channel stays BUSY until the op's sentinel
        // arrives — the reap relay is what kills it, and the idle watchdog is
        // what bounds the wait — because tearing the channel down for a
        // cancellation would cost every other op on it.
        orphaned: false,
        resolve,
        reject,
        onAbort: null,
      };
      ch.busy = true;
      ch.op = op;
      if (signal) {
        op.onAbort = () => {
          if (op.settled || op.orphaned) return;
          op.orphaned = true;
          reject(new Error('operation was closed by the client'));
        };
        if (signal.aborted) { op.onAbort(); }
        else signal.addEventListener('abort', op.onAbort, { once: true });
        op.signal = signal;
      }
      this.#arm(ch);
      try {
        ch.proc.stdin.write(buildOpCommand({
          nonce, token, script, payloadBytes: stdinData ? stdinData.length : null,
        }));
      } catch (e) {
        this.#kill(ch, `the channel could not be written to: ${e?.message ?? e}`);
      }
    });
  }

  // ONE TIMER PER DISPATCHED OP, reset on every byte received on either of its
  // streams. It subsumes the post-reap settle: after a reap no further bytes
  // arrive, so the same watchdog reclaims the channel — which is why there is
  // one constant here and not two.
  #arm(ch) {
    if (ch.timer) clearTimeout(ch.timer);
    ch.timer = setTimeout(() => {
      this.#kill(ch, `no output for ${this.#idleMs}ms — the channel is idle and presumed desynced`);
    }, this.#idleMs);
    ch.timer.unref?.();
  }

  #onData(ch, stream, chunk) {
    if (ch.op) this.#arm(ch);
    const op = ch.op;
    if (!op) return;
    if (stream === 'out') this.#feedOut(ch, op, chunk);
    else this.#feedErr(ch, op, chunk);
  }

  #feedOut(ch, op, chunk) {
    let c = chunk;
    if (op.rdy && !op.rdy.seen) {
      op.rdy.push(c);
      if (!op.rdy.seen) return;
      c = op.rdy.rest;
      // THE HANDSHAKE'S SECOND HALF: the shell has parsed the whole command and
      // its input buffer is empty, so the bytes written now are the ones
      // `head -c <n>` will read.
      try { ch.proc.stdin.write(op.stdinData); }
      catch (e) { this.#kill(ch, `the payload could not be written: ${e?.message ?? e}`); return; }
    }
    if (!op.out.seen) {
      const emit = op.out.push(c);
      if (emit.length > 0) {
        op.onStdout?.(emit);
        if (op.collect) op.outChunks.push(emit);
      }
      if (!op.out.seen) return;
      c = op.out.rest;
    }
    // Everything after the stdout sentinel is the exit code and its newline.
    op.rcBuf = op.rcBuf.length === 0 ? c : Buffer.concat([op.rcBuf, c]);
    const nl = op.rcBuf.indexOf(0x0a);
    if (nl === -1 || op.code !== null) return;
    const parsed = Number.parseInt(op.rcBuf.subarray(0, nl).toString('utf8').trim(), 10);
    op.code = Number.isFinite(parsed) ? parsed : 1;
    this.#maybeSettle(ch, op);
  }

  #feedErr(ch, op, chunk) {
    if (op.err.seen) return;
    const emit = op.err.push(chunk);
    if (emit.length > 0) {
      op.onStderr?.(emit);
      if (op.collect) op.errChunks.push(emit);
    }
    if (op.err.seen) this.#maybeSettle(ch, op);
  }

  // THE AND OF BOTH STREAMS, plus the exit code the stdout sentinel carries.
  // Settling on one stream alone would truncate whichever was still arriving.
  #maybeSettle(ch, op) {
    if (op.settled) return;
    if (!op.out.seen || !op.err.seen || op.code === null) return;
    op.settled = true;
    if (op.signal && op.onAbort) op.signal.removeEventListener('abort', op.onAbort);
    if (ch.timer) { clearTimeout(ch.timer); ch.timer = null; }
    ch.busy = false;
    ch.op = null;
    if (op.orphaned) return;
    op.resolve({
      code: op.code,
      stdout: Buffer.concat(op.outChunks),
      stderr: Buffer.concat(op.errChunks).toString('utf8'),
    });
  }

  // A DEAD CHANNEL IS NOT OFFERED AGAIN, and its in-flight op is NEVER RETRIED —
  // for any op kind. That is the strongest reading of the failure asymmetry and
  // it needs no per-op mutating/idempotent table: a retried exclusive create
  // whose first attempt LANDED would answer `EEXIST` and report a failure that
  // actually succeeded.
  //
  // `ETRANSPORT` is what keeps it out of cc's errno classifier: `#derive` reads
  // it through `spawnErrorCode` and throws `SystemError('ETRANSPORT')` rather
  // than matching the message for an errno.
  #kill(ch, why) {
    if (ch.dead) return;
    ch.dead = true;
    if (ch.timer) { clearTimeout(ch.timer); ch.timer = null; }
    const i = ch.bucket.channels.indexOf(ch);
    if (i !== -1) ch.bucket.channels.splice(i, 1);
    const op = ch.op;
    ch.op = null;
    ch.busy = false;
    if (op && !op.settled) {
      op.settled = true;
      if (op.signal && op.onAbort) op.signal.removeEventListener('abort', op.onAbort);
      if (!op.orphaned) op.reject(new ProtocolError('ETRANSPORT', `the held-open channel failed: ${why}`));
    }
    try { ch.proc.stdin.end(); } catch { /* already gone */ }
    try { ch.proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * The pool for this launcher, or `null` when there is none to build — the kind
 * offers no `channelPlan`, or the operator switched it off.
 *
 * ONE POOL PER LAUNCHER PROCESS, built in main.mjs and handed to `Session`.
 * `src/baseline.mjs` passes none: its probe is one-off, runs in the backend, and
 * has no shutdown path to close a channel on.
 */
export function createChannelPool(transport, { warn = () => {}, env = process.env, idleMs } = {}) {
  if (typeof transport?.channelPlan !== 'function') return null;
  if (!channelEnabled(env)) return null;
  return new ChannelPool({ transport, warn, ...(idleMs === undefined ? {} : { idleMs }) });
}
