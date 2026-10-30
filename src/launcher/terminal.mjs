// THE TERMINAL CORE: every pty exec (systems-protocol.md §5, "pty exec"), once,
// for every kind — composed into the frame loop (session.mjs), which routes it
// the `exec` frames carrying `pty` and every `input`, `resize` and `ack`.
//
// A terminal is a chain, and only its two ends are ours:
//
//   launcher ─ python3 ptyHelper.py (host pty) ─ the kind's client ─▶ far side:
//     /bin/sh trampoline (kinds/ptyscript.mjs) ─ exec program
//
// The kind supplies the middle as a PURE `ptyPlan(config, {command, token,
// remoteId})` — `docker exec -i -t …`, `ssh -tt …`, or for `host` the
// trampoline itself — plus `ptyMode` (does the trampoline `exec` the program
// or stay as its parent) and `ptyResizeRelay`.
//
// WHAT THIS MODULE OWNS:
//  - The MARKERS. Everything the terminal prints before the trampoline's
//    `<nonce> STARTED <tty> <sid>` is discarded — a login profile, an MOTD, the
//    echo of nothing — and `ptyStarted` is sent on it. On `<nonce> OVERLAY` the
//    program's environment goes in-band (`overlayBlob`): the overlay is never an
//    argv element anywhere, because /proc/<pid>/cmdline is world-readable. A
//    `<nonce> <CODE>` is an id-addressed error; the client exiting before either
//    goes to the kind's `classifyFailure`, then EUNKNOWN.
//  - OUTPUT CREDIT: at most PTY_WINDOW_BYTES unacked, the remainder held and the
//    helper paused (cc enforces it and fails the terminal EPROTO past it).
//  - INPUT CREDIT: an `inputAck` for exactly the bytes the helper reports
//    written into the host pty (`w`), never on receipt. Input that arrives
//    before the marker, or behind a resize relay, is HELD — unwritten, so
//    uncredited. Past the host pty, the transport's own fixed buffers hold
//    what the far program has not read (docker ~270–300 KiB, ssh its 2 MiB
//    channel window — measured); never this module's queue. What a peer has
//    sent and the helper has not yet written is capped at one
//    PTY_INPUT_WINDOW_BYTES: past it the terminal ends EPROTO, as cc ends one
//    that over-grants.
//  - CLOSE: the helper hangs the host pty up, which ends the client, and the
//    kind's `reap` relays the hang-up into the far session the marker named.
//    The program EXITING is reaped too: docker never forwards a hang-up
//    (measured), so without it a job the program left in its session — or the
//    program itself, when the client died — outlives the `exit`.

import { randomBytes } from 'node:crypto';
import {
  FS_ERROR_CODES, PTY_DIM_MAX, PTY_INPUT_WINDOW_BYTES, PTY_WINDOW_BYTES, classifySpawnError,
} from './protocol.mjs';
import { ENV_NAME_RE, buildResizeScript, findMarker, overlayBlob, ptyTrampolineArgv } from './kinds/ptyscript.mjs';
import { TOKEN_VAR } from './kinds/reapscript.mjs';
import { spawnPty } from './ptyhost.mjs';
import { makeRunner } from './run.mjs';

// The helper's own cwd on cc's host. The frame's cwd is a FAR-SIDE path, which
// the trampoline enters.
const HELPER_CWD = '/';
// Kept of what the terminal printed before the marker: the head for the
// classifier (the size session.mjs keeps for an exec's), and a tail to find a
// marker split across chunks in.
const HEAD_BYTES = 512;
const PRE_TAIL_BYTES = 4096;
// A resize relay is one `stty` on the target; past this it is abandoned and the
// input it held released.
const RELAY_TIMEOUT_MS = 5_000;

const MARKER_MESSAGES = {
  EPTY: 'the target gave the terminal no tty (an sshd with `PermitTTY no` refuses one)',
  'EPTY stty': 'the target\'s `stty` could not make the terminal raw, so its environment was not sent',
  'EPTY overlay': 'the terminal\'s environment did not arrive whole on the target',
  ENOENT: 'the cwd or the program is not there on the target',
  ENOTDIR: 'the cwd is not a directory on the target',
  EACCES: 'the cwd or the program is not accessible on the target',
};

// The refusal text for a trampoline marker; an `EPTY` names which check failed.
function markerMessage(m) {
  if (m.detail?.startsWith('missing-')) {
    return `the target has no \`${m.detail.slice('missing-'.length)}\`, which a terminal needs there`;
  }
  return MARKER_MESSAGES[m.detail ? `${m.code} ${m.detail}` : m.code] ?? MARKER_MESSAGES[m.code];
}

const FS_TOKEN = new RegExp(`\\b(${FS_ERROR_CODES.filter(c => c !== 'EUNKNOWN').join('|')})\\b`, 'g');
// A quoted head carries no bare FS errno token: cc re-parses a refusal's text
// (.wiki/gotchas/refusal-message-errno-tokens.md).
const scrub = (s) => s.replace(FS_TOKEN, (t) => t.toLowerCase());

const dim = (v) => Number.isInteger(v) && v >= 1 && v <= PTY_DIM_MAX;
const errMsg = (e) => (e instanceof Error ? e.message : String(e));

// Why this frame is not a pty exec cc could have sent, or null.
function malformed(f) {
  const p = f.pty;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return '`pty` must be an object';
  if (!dim(p.cols) || !dim(p.rows)) return `a pty exec needs integer cols and rows in 1..${PTY_DIM_MAX}`;
  if (typeof p.term !== 'string' || p.term === '' || p.term.includes('\0')) return 'a pty exec needs a string term';
  if (f.shell !== undefined || f.env !== undefined || f.timeoutMs !== undefined) {
    return 'a pty exec carries argv or nothing — never shell, env or timeoutMs';
  }
  if (typeof f.cwd !== 'string') return 'a pty exec needs a cwd';
  if (f.argv !== undefined && (!Array.isArray(f.argv) || f.argv.length === 0
    || !f.argv.every(a => typeof a === 'string' && !a.includes('\0')))) {
    return 'a pty exec\'s argv is a non-empty array of strings';
  }
  const o = p.envOverlay;
  if (o !== undefined && o !== null) {
    if (typeof o !== 'object' || Array.isArray(o)) return '`envOverlay` must be an object';
    for (const [k, v] of Object.entries(o)) {
      if (!ENV_NAME_RE.test(k) || typeof v !== 'string' || v.includes('\0')) {
        return `envOverlay entry ${JSON.stringify(k)} is not a NAME=string pair`;
      }
    }
  }
  return null;
}

export class Terminals {
  #transport;
  #write;
  #warn;
  #reap;
  #channels;
  #interpreter;
  #open = new Map();

  /**
   * @param {{transport:object, write:(f:object)=>void, warn:(m:string)=>void,
   *          reap:(config:object, handle:object)=>Promise<void>, channels:object|null,
   *          interpreter:string|null}} o
   *   `interpreter` is the probed python3, or null when `pty` is not advertised.
   *   `reap` reports its own failures.
   */
  constructor({ transport, write, warn, reap, channels = null, interpreter }) {
    this.#transport = transport;
    this.#write = write;
    this.#warn = warn;
    this.#reap = reap;
    this.#channels = channels;
    this.#interpreter = interpreter;
  }

  #fail(id, code, message, extra = {}) {
    this.#write({ type: 'error', id, code, message, ...extra });
  }

  open(f, remote) {
    const id = String(f.id);
    if (this.#interpreter === null || typeof this.#transport.ptyPlan !== 'function') {
      this.#fail(id, 'EUNSUPPORTED', 'this provider does not advertise pty');
      return;
    }
    const bad = malformed(f);
    if (bad) { this.#fail(id, 'EPROTO', bad); return; }

    const remoteId = remote?.remoteId ?? null;
    const token = randomBytes(12).toString('hex');
    const nonce = randomBytes(12).toString('hex');
    const { cols, rows, term } = f.pty;
    // The overlay, then the PLUMBING — so the provider's binding beats an
    // overlay value, as `execEnv` makes it for an exec — then TERM, which beats
    // an overlay TERM (§5). In-band, never in argv.
    const blob = overlayBlob([
      ...Object.entries(f.pty.envOverlay ?? {}),
      ...(remoteId !== null ? [['CC_REMOTE', remoteId]] : []),
      [TOKEN_VAR, token],
      ['TERM', term],
    ]);
    if (blob.length > PTY_INPUT_WINDOW_BYTES) {
      this.#fail(id, 'EPROTO', `envOverlay is larger than one input window (${PTY_INPUT_WINDOW_BYTES} bytes)`);
      return;
    }
    const command = ptyTrampolineArgv({
      nonce, cwd: f.cwd, cols, rows, mode: this.#transport.ptyMode ?? 'exec', blobBytes: blob.length, argv: f.argv ?? null,
    });

    let plan;
    try { plan = this.#transport.ptyPlan(remote?.config ?? {}, { command, token, remoteId }); }
    catch (e) { this.#fail(id, classifySpawnError(e), errMsg(e)); return; }

    const t = {
      id,
      nonce,
      config: remote?.config ?? {},
      handle: { pid: null, token, remoteId, sid: null },
      started: false,
      closed: false,
      blob,
      // Bytes the helper will report written that are the blob's, not cc's:
      // they earn no `inputAck`.
      ownBytes: 0,
      // cc's input accepted and not yet reported written — held here, queued in
      // the helper, or in flight. Capped at PTY_INPUT_WINDOW_BYTES.
      unwritten: 0,
      relayAc: null,
      seq: 0,
      credit: PTY_WINDOW_BYTES,
      held: null,
      pre: '',
      head: '',
      quoting: true,
      tty: null,
      input: [],
      relaying: false,
      size: null,
      relayWarned: false,
      proc: null,
    };
    this.#open.set(id, t);
    t.proc = spawnPty({
      interpreter: this.#interpreter,
      argv: [plan.file, ...plan.args],
      // The helper — and so the client — run in the launcher's own environment,
      // or the kind's (a credential). The overlay is in no argv and no env of
      // theirs: it goes in-band as the blob, and the helper's `v` is `{}`.
      env: plan.env ?? process.env,
      programEnv: {},
      cwd: HELPER_CWD,
      cols,
      rows,
      maxQueuedBytes: PTY_INPUT_WINDOW_BYTES + blob.length,
    }, {
      // The CLIENT was exec'd. The PROGRAM's start is the trampoline's marker.
      onStarted: () => {},
      onData: (b) => this.#data(t, b),
      onWritten: (n) => this.#written(t, n),
      onExit: (code, signal) => this.#exit(t, code, signal),
      onFailed: (code, message) => this.#failed(t, code, message),
    });
  }

  #data(t, b) {
    if (t.closed) return;
    if (t.started) { this.#emit(t, b); return; }
    const text = b.toString('latin1');
    if (t.quoting && t.head.length < HEAD_BYTES) t.head = (t.head + text).slice(0, HEAD_BYTES);
    t.pre += text;
    let m = findMarker(t.pre, t.nonce);
    if (m?.kind === 'overlay') {
      // The trampoline is reading the program's environment, raw and `-echo`.
      // NOTHING FROM HERE ON IS QUOTED to cc: the head so far holds the nonce,
      // and a tty that echoed anyway would hand back the blob — the token and
      // every overlay value. A client that dies now reports without a quote.
      t.quoting = false;
      t.head = '';
      t.pre = t.pre.slice(m.end);
      if (t.blob) {
        t.ownBytes += t.blob.length;
        t.proc.write(t.blob);
        t.blob = null;
      }
      m = findMarker(t.pre, t.nonce);
    }
    if (!m || m.kind === 'overlay') {
      if (t.pre.length > PRE_TAIL_BYTES) t.pre = t.pre.slice(-PRE_TAIL_BYTES);
      return;
    }
    if (m.kind === 'error') {
      // The trampoline refused and exits on its own: nothing to reap.
      this.#end(t);
      t.proc.close();
      this.#fail(t.id, m.code, markerMessage(m));
      return;
    }
    const rest = Buffer.from(t.pre.slice(m.end), 'latin1');
    t.started = true;
    t.tty = m.tty;
    t.handle.sid = m.sid || null;
    t.pre = '';
    t.head = '';
    this.#write({ type: 'ptyStarted', id: t.id });
    if (t.size) void this.#relay(t);
    else this.#flushInput(t);
    if (rest.length > 0) this.#emit(t, rest);
  }

  // As much of `chunk` as the credit covers goes out now; the rest is held and
  // the helper paused until an `ack` returns credit (cc's reference provider,
  // `#ptyEmit`).
  #emit(t, chunk) {
    if (t.closed) return;
    const now = chunk.subarray(0, t.credit);
    if (now.length > 0) {
      t.credit -= now.length;
      this.#write({ type: 'stdout', id: t.id, seq: t.seq++, dataB64: now.toString('base64') });
    }
    if (now.length < chunk.length) {
      t.held = chunk.subarray(now.length);
      t.proc.pause();
    } else if (t.credit === 0) {
      t.proc.pause();
    }
  }

  ack(f) {
    const t = this.#open.get(String(f.id));
    if (!t || typeof f.bytes !== 'number' || !(f.bytes > 0)) return;
    t.credit = Math.min(PTY_WINDOW_BYTES, t.credit + f.bytes);
    const held = t.held;
    t.held = null;
    if (held) this.#emit(t, held);
    if (t.held === null && t.credit > 0) t.proc.resume();
  }

  input(f) {
    const t = this.#open.get(String(f.id));
    if (!t) return;
    const b = Buffer.from(String(f.dataB64 ?? ''), 'base64');
    // cc may have at most one window unacknowledged; more is a peer breaking
    // input credit, and it is not let grow this process's memory.
    if (t.unwritten + b.length > PTY_INPUT_WINDOW_BYTES) {
      this.#violate(t, `input past one window: ${t.unwritten + b.length} bytes sent and not yet written`
        + ` (PTY_INPUT_WINDOW_BYTES is ${PTY_INPUT_WINDOW_BYTES})`);
      return;
    }
    t.unwritten += b.length;
    if (!t.started || t.relaying) { t.input.push(b); return; }
    this.#feed(t, b);
  }

  #feed(t, b) {
    if (!t.proc.write(b)) this.#violate(t, 'input past the helper\'s queue');
  }

  #flushInput(t) {
    if (t.closed || !t.started || t.relaying) return;
    for (const b of t.input.splice(0)) this.#feed(t, b);
  }

  // The drain report: the blob's bytes first, then cc's, credited exactly.
  #written(t, n) {
    const own = Math.min(n, t.ownBytes);
    t.ownBytes -= own;
    const theirs = n - own;
    if (theirs === 0 || t.closed) return;
    t.unwritten -= theirs;
    this.#write({ type: 'inputAck', id: t.id, bytes: theirs });
  }

  // A peer broke the input contract: end this terminal EPROTO, id-addressed,
  // and take the far side with it. The connection carries on.
  #violate(t, message) {
    if (t.closed) return;
    this.#end(t);
    t.proc.close();
    void this.#reap(t.config, t.handle);
    this.#fail(t.id, 'EPROTO', message);
  }

  resize(f) {
    const t = this.#open.get(String(f.id));
    if (!t || !dim(f.cols) || !dim(f.rows)) return;
    t.proc.resize(f.cols, f.rows);
    if (this.#transport.ptyResizeRelay !== true) return;
    // Coalesced to the latest: only the size the terminal ends at matters.
    t.size = { cols: f.cols, rows: f.rows };
    if (t.started && !t.relaying) void this.#relay(t);
  }

  // THE RESIZE RELAY: `stty` on the far tty, through the kind's own exec path,
  // holding input until it lands. A failed relay warns once and releases what
  // it held; it never wedges the terminal.
  async #relay(t) {
    t.relaying = true;
    const run = makeRunner(this.#transport, t.config, t.handle.remoteId, { channels: this.#channels });
    while (t.size && !t.closed) {
      const { cols, rows } = t.size;
      t.size = null;
      const ac = new AbortController();
      t.relayAc = ac;
      const timer = setTimeout(() => ac.abort(), RELAY_TIMEOUT_MS);
      try {
        const res = await run({ script: buildResizeScript(t.tty, cols, rows), signal: ac.signal });
        if (res.code !== 0) throw new Error(`exit ${res.code}: ${res.stderr.trim()}`);
      } catch (e) {
        if (t.closed) break;
        if (!t.relayWarned) {
          t.relayWarned = true;
          this.#warn(`code-system launcher: a terminal's resize could not be relayed to remote`
            + ` '${t.handle.remoteId ?? '(unrouted)'}' (${errMsg(e)}) — input no longer waits for it,`
            + ' and the far size may lag');
        }
      } finally {
        clearTimeout(timer);
        t.relayAc = null;
      }
    }
    t.relaying = false;
    this.#flushInput(t);
  }

  #exit(t, code, signal) {
    if (t.closed) return;
    this.#end(t);
    if (t.started) {
      this.#write({ type: 'exit', id: t.id, code, signal, timedOut: false });
      // The session the program led may still hold its jobs — or the program,
      // when it was the client that died.
      void this.#reap(t.config, t.handle);
      return;
    }
    // THE CLIENT ENDED BEFORE ANY MARKER: the transport's own failure — a
    // missing or stopped container, auth, an unreachable host — read through
    // the kind's vocabulary. Under a terminal its stdout and stderr are one
    // stream, CRLF-translated, so the head is handed over as stderr, stripped.
    //
    // The far side is reaped all the same, by the whole token (no session was
    // reported): a client that died mid-open — the daemon or the connection
    // lost, the CLI killed — can leave the trampoline alive, parked in its
    // read or about to exec, and docker never forwards the hang-up (measured).
    void this.#reap(t.config, t.handle);
    const head = t.head.replace(/\r/g, '');
    const verdict = this.#transport.classifyFailure?.(t.config, { code: code ?? 1, stdout: '', stderr: head });
    if (verdict) {
      this.#fail(t.id, verdict.code, verdict.message, verdict.stderr ? { stderr: verdict.stderr } : {});
      return;
    }
    const quoted = scrub(head.trim()).slice(0, 200);
    this.#fail(t.id, 'EUNKNOWN', `the terminal's transport ended (${signal ?? `exit ${code}`}) before the`
      + ` program started${quoted ? `: ${quoted}` : ''}`);
  }

  #failed(t, code, message) {
    if (t.closed) return;
    this.#end(t);
    if (t.started) {
      // The helper died under a running terminal; the far side may not have.
      void this.#reap(t.config, t.handle);
      this.#fail(t.id, code, message);
      return;
    }
    // Reaped by the whole token, as a client death before the marker is.
    void this.#reap(t.config, t.handle);
    if (code === 'EPTY') { this.#fail(t.id, 'EPTY', message); return; }
    // The CLIENT never ran (a missing docker or ssh): not the target's answer,
    // so no FS code.
    this.#fail(t.id, 'EUNKNOWN', `the terminal's transport could not start: ${scrub(message)}`);
  }

  // Also abandons an in-flight resize relay, whose `stty` client is detached
  // and would otherwise outlive the terminal and the launcher.
  #end(t) {
    t.closed = true;
    this.#open.delete(t.id);
    t.relayAc?.abort();
  }

  /** Close the terminal `id` names; answers whether it was one. */
  close(id) {
    const t = this.#open.get(id);
    if (!t) return false;
    this.#end(t);
    t.proc.close();
    void this.#reap(t.config, t.handle);
    return true;
  }

  /** MUST 3: close every terminal. Returns their reaps, for the shutdown race. */
  shutdown() {
    const pending = [];
    for (const t of [...this.#open.values()]) {
      this.#end(t);
      t.proc.close();
      pending.push(this.#reap(t.config, t.handle));
    }
    return pending;
  }
}
