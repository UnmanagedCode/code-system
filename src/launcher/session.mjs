// THE FRAME LOOP: the whole of the System protocol, once, for every kind.
//
// It owns ids, routing, chunking, error codes, timeouts and shutdown. A
// Transport (src/launcher/kinds/) owns only "how do I reach this target", and
// its spawnPlan is a pure function this module spawns — which is what makes
// `host` passing cc's conformance suite a statement about the core that every
// kind inherits.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  CHUNK_BYTES, DEFAULT_KILL_GRACE_MS, MAX_FILE_BYTES, PROTOCOL_VERSION,
  REQUEST_FRAMES, classifySpawnError,
} from './protocol.mjs';
import { readFileOp, writeFileOp } from './fileops.mjs';
import { makeRunner } from './run.mjs';
import { withinRoot } from './remotes.mjs';

// THE ONE CWD A FENCE MUST NOT REFUSE, and it is cc's placeholder, not a
// location: every derived operation (`stat`, `readDir`, `realpath`, `mkdir`,
// `removeTree`, `unlink`, `chmod`) runs at `/` and carries its real target in
// argv. A provider that fenced it would refuse EVERY derivation while `exec`
// and the two file primitives kept working — which reads as cc being broken
// rather than as a fence doing its job (systems-protocol.md §7, "Every derivation is sent with cwd: '/'").
const PLACEHOLDER_CWD = '/';

// Reaping must finish inside cc's own window: cc closes our stdin and SIGKILLs
// us after `DEFAULT_SHUTDOWN_GRACE_MS` = 2000 (code-conductor
// src/systems/providerConnection.ts, :75 at the pin). Past that we are killed
// mid-reap and the orphans survive anyway.
export const REAP_DEADLINE_MS = 1500;

// How much of each stream is retained for `classifyFailure`. The transport
// diagnostics it reads are a single short line arriving before anything else.
const HEAD_BYTES = 512;

const sleep = (ms) => new Promise(r => setTimeout(r, ms).unref?.());

function errMsg(e) { return e instanceof Error ? e.message : String(e); }

export class Session {
  #transport;
  #source;
  #caps;
  #write;
  #onFatal;
  #warn;
  #version;
  #reapDeadlineMs;

  #execs = new Map();
  #writes = new Map();
  // id → {ac, config, handle} for an IN-FLIGHT derived file operation. It is the
  // "is this id still live" check, the kill handle `close` needs, AND the
  // (config, handle) pair `reap` needs: the body runs detached so one round trip
  // does not serialise every other id, so dropping bookkeeping alone would
  // leave the far-side command running. A file operation is as much a far-side
  // process as an `exec` is, so it gets the same reap treatment.
  #fileOps = new Map();
  #greeted = false;
  #chain = Promise.resolve();

  constructor({
    transport, source, capabilities, write, onFatal,
    // DIAGNOSTIC, never fatal and never a frame. Everything but frames goes to
    // stderr, of which cc keeps a bounded tail (MUST 1).
    warn = (msg) => { try { process.stderr.write(`${msg}\n`); } catch { /* nobody listening */ } },
    version = '0.1.0', reapDeadlineMs = REAP_DEADLINE_MS,
  }) {
    this.#transport = transport;
    this.#source = source;
    this.#caps = capabilities;
    this.#write = write;
    this.#onFatal = onFatal;
    this.#warn = warn;
    this.#version = version;
    this.#reapDeadlineMs = reapDeadlineMs;
  }

  // Frames are handled STRICTLY IN ARRIVAL ORDER. Resolving a remote is an
  // await (the store is read fresh from disk), and a `signal` for an id can
  // arrive in the same chunk as the `exec` that opened it — so without this
  // chain the follow-on frame would be processed first and dropped as an
  // unknown id.
  //
  // Only the routing-and-registration phase is serialised: a readFile's round
  // trip runs detached, so one slow operation never serialises cc behind it
  // (MUST 4).
  deliver(frame) {
    this.#chain = this.#chain
      .then(() => this.handle(frame))
      .catch(e => { this.#onFatal(`frame handling failed: ${errMsg(e)}`); });
    return this.#chain;
  }

  #fail(id, code, message, extra = {}) {
    this.#write({ type: 'error', ...(id ? { id } : {}), code, message, ...extra });
  }

  async handle(f) {
    if (!this.#greeted) {
      if (f.type !== 'hello') {
        this.#fail(undefined, 'EPROTO', `expected hello, got '${f.type}'`);
        this.#onFatal('client did not open with hello');
        return;
      }
      this.#greeted = true;
      this.#write(this.hello());
      return;
    }

    // THE ROUTING GATE, on the four REQUESTS only. Every follow-on frame is
    // addressed by an id already bound to a remote, so re-checking one would
    // ask a question the id has already answered.
    let remote = null;
    if (REQUEST_FRAMES.has(f.type)) {
      const named = typeof f.remoteId === 'string' ? f.remoteId : null;
      const res = await this.#source.lookup(named);
      if (!res.ok) {
        // ID-ADDRESSED, always: an id-less error frame is connection-level and
        // would fail every OTHER target's in-flight work
        // (systems-protocol.md §9, "One dead remote is not a dead connection").
        this.#fail(String(f.id), res.code, res.message, res.stderr ? { stderr: res.stderr } : {});
        return;
      }
      remote = res.remote;
      // THE ROOT SCOPE. A path or a cwd belonging to another target is refused,
      // never served.
      if (remote.root) {
        const reach = f.type === 'exec' ? f.cwd : f.path;
        if (typeof reach === 'string'
          && !(f.type === 'exec' && reach === PLACEHOLDER_CWD)
          && !withinRoot(remote.root, reach)) {
          this.#fail(String(f.id), 'EACCES',
            `'${reach}' is not on remote '${remote.remoteId}' (rooted at '${remote.root}')`);
          return;
        }
      }
    }

    switch (f.type) {
      case 'exec': return this.#exec(f, remote);
      case 'signal': return this.#signal(f);
      case 'close': return this.#close(f);
      case 'readFile': return this.#readFileOpen(f, remote);
      case 'writeFile': return this.#writeOpen(f, remote);
      case 'data': return this.#writeData(f);
      case 'end': return this.#writeEnd(f);
      case 'describeRemote': return this.#describeRemote(f, remote);
      // UNKNOWN TYPES ARE IGNORED — the extension point that lets the contract
      // grow without a version bump.
      default: return undefined;
    }
  }

  // NO `system` DESCRIPTOR. cc's HelloProviderFrame is
  // {type, protocol, provider, capabilities?} and nothing reads a descriptor —
  // `shell` was its only ever reader and went with the long-lived shell. We
  // send no key with zero readers.
  hello() {
    return {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      provider: `code-system-${this.#transport.kind}/${this.#version}`,
      capabilities: { ...this.#caps },
    };
  }

  // ── exec ───────────────────────────────────────────────────────────

  #exec(f, remote) {
    const id = String(f.id);
    const stdinMode = f.stdin === 'ignore' ? 'ignore' : 'pipe';
    // THE FRAME'S OWN env, or null. NOT `process.env` when the field is absent:
    // `null` means "inherit the FAR SIDE's environment", which for docker is the
    // container's PATH/HOME/toolchain — cc sends no `env` on ANY `exec` it
    // issues, its own plumbing and a caller's command alike, for exactly that
    // reason (§7). Substituting cc's host
    // environment here would run every derivation inside the container with
    // cc's PATH (measured: `env: 'git': No such file or directory`, exit 127).
    // The kind composes, with `execEnv` (kinds/config.mjs), which is also where
    // CC_REMOTE is overlaid — the POSITIVE ROUTING EVIDENCE cc's conformance
    // suite asserts on, since on a host where every target may be the same
    // filesystem "the command worked" is what a MISROUTE also looks like.
    const env = (f.env && typeof f.env === 'object' && !Array.isArray(f.env)) ? f.env : null;
    const token = randomBytes(12).toString('hex');
    const req = {
      argv: Array.isArray(f.argv) ? f.argv.map(String) : null,
      shell: typeof f.shell === 'string' ? f.shell : null,
      cwd: typeof f.cwd === 'string' ? f.cwd : PLACEHOLDER_CWD,
      env,
      stdinMode,
      remoteId: remote?.remoteId ?? null,
      token,
    };

    let plan;
    try { plan = this.#transport.spawnPlan(remote?.config ?? {}, req); }
    catch (e) { this.#fail(id, classifySpawnError(e), errMsg(e)); return; }

    let child;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env ?? undefined,
        detached: plan.detached === true,
        stdio: [stdinMode, 'pipe', 'pipe'],
      });
    } catch (e) {
      // spawn throws SYNCHRONOUSLY for an invalid argument (a NUL byte in an
      // argv entry). Either way the command NEVER STARTED, which is an `error`
      // frame, not an `exit` frame.
      this.#fail(id, classifySpawnError(e), errMsg(e));
      return;
    }

    const state = {
      child,
      seq: 0,
      timer: null,
      // The SIGTERM→SIGKILL backstop #terminate schedules. Held so the close
      // handler can cancel it: without that it outlives the exec it belonged to.
      killTimer: null,
      timedOut: false,
      orphaned: false,
      closed: false,
      terminated: false,
      // A BOUNDED HEAD of each stream, for `classifyFailure` only. The
      // transport's own diagnostics are one short line and arrive first, so a
      // cap is enough — and it is what stops a chatty command turning this into
      // an unbounded buffer beside the frames we already streamed.
      head: '',
      errHead: '',
      detached: plan.detached === true,
      config: remote?.config ?? {},
      handle: { pid: child.pid ?? null, token, remoteId: remote?.remoteId ?? null },
      killGraceMs: typeof f.killGraceMs === 'number' ? f.killGraceMs : DEFAULT_KILL_GRACE_MS,
    };
    this.#execs.set(id, state);

    child.stdout?.on('data', (b) => {
      if (state.head.length < HEAD_BYTES) state.head = (state.head + b.toString('utf8')).slice(0, HEAD_BYTES);
      if (!state.closed) this.#write({ type: 'stdout', id, seq: state.seq++, dataB64: b.toString('base64') });
    });
    child.stderr?.on('data', (b) => {
      if (state.errHead.length < HEAD_BYTES) state.errHead = (state.errHead + b.toString('utf8')).slice(0, HEAD_BYTES);
      if (!state.closed) this.#write({ type: 'stderr', id, seq: state.seq++, dataB64: b.toString('base64') });
    });
    child.on('error', (e) => {
      if (state.closed) return;
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      if (state.killTimer) clearTimeout(state.killTimer);
      this.#execs.delete(id);
      this.#fail(id, classifySpawnError(e), errMsg(e));
    });
    child.on('close', (code, signal) => {
      if (state.closed) return;
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      if (state.killTimer) clearTimeout(state.killTimer);
      this.#execs.delete(id);
      // THE TRANSPORT'S OWN FAILURE, not the command's: a stopped or missing
      // container is a non-zero exit of the docker CLI and nothing else, so
      // without this it would be reported as the command's `exit`. The kind
      // decides; a null verdict is the common case. §1 MUST 5 only requires the
      // id to TERMINATE in a frame, and an `error` frame is one — the stdout and
      // stderr frames already streamed are not retracted.
      // Not consulted for an exec WE killed: that failure is ours, and reading
      // it through the transport's vocabulary could only mislabel it.
      const verdict = code !== 0 && !state.timedOut && !state.terminated
        ? this.#transport.classifyFailure?.(state.config, { code: code ?? 1, stdout: state.head, stderr: state.errHead })
        : null;
      if (verdict) {
        this.#fail(id, verdict.code, verdict.message, {
          exitCode: code ?? 1,
          ...(verdict.stderr ? { stderr: verdict.stderr } : {}),
        });
      } else {
        this.#write({
          type: 'exit',
          id,
          // 124 on timeout, matching timeout(1) — the convention cc's callers
          // already branch on.
          code: state.timedOut ? 124 : code ?? 1,
          signal: signal ?? null,
          timedOut: state.timedOut,
          ...(state.orphaned ? { descendantsMaySurvive: true } : {}),
        });
      }
      // A command that exited ON ITS OWN is NOT reaped: it has already ended on
      // the far side, and a round trip into the container per command buys
      // nothing. But one WE TERMINATED is exactly the case reap exists for —
      // a `timeoutMs` expiry and a `signal` frame kill the host-side docker
      // client while the container process keeps running, so without this the
      // launcher would report code 124 ("the provider killed it") for a command
      // still running in the container. `close` and shutdown reap on their own
      // paths, which is why they set no `terminated`.
      if (state.terminated) void this.#reap(state);
    });

    if (typeof f.timeoutMs === 'number') {
      state.timer = setTimeout(() => {
        state.timedOut = true;
        this.#terminate(state, 'SIGTERM', true);
      }, f.timeoutMs);
    }
  }

  // SIGTERM now, SIGKILL after the grace — a script that traps or ignores
  // SIGTERM would otherwise never die.
  #terminate(state, signal, group) {
    state.terminated = true;
    const reach = group && state.detached;
    // Without group reach we terminated the direct child only, so grandchildren
    // may still be running and every result we terminated must say so.
    if (!reach) state.orphaned = true;
    const send = (sig) => {
      if (state.closed) return;
      try {
        if (reach && state.child.pid) process.kill(-state.child.pid, sig);
        else state.child.kill(sig);
      } catch { /* already gone */ }
    };
    send(signal);
    if (signal === 'SIGTERM') {
      // One backstop at a time: a second SIGTERM must not strand the first.
      if (state.killTimer) clearTimeout(state.killTimer);
      state.killTimer = setTimeout(() => send('SIGKILL'), state.killGraceMs);
      state.killTimer.unref?.();
    }
  }

  #signal(f) {
    const state = this.#execs.get(String(f.id));
    if (!state) return;
    // A POSIX signal NAME in SIG* form — never a bare name and never a number.
    const sig = typeof f.signal === 'string' ? f.signal : 'SIGTERM';
    this.#terminate(state, sig, f.processGroup === true);
  }

  // cc has stopped listening: kill hard, emit NO further frames for the id, and
  // give the kind its chance to reap what it left on the far side.
  #close(f) {
    const id = String(f.id);
    const state = this.#execs.get(id);
    if (state) {
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      if (state.killTimer) clearTimeout(state.killTimer);
      this.#execs.delete(id);
      this.#terminate({ ...state, closed: false }, 'SIGKILL', true);
      void this.#reap(state);
    }
    this.#writes.delete(id);
    // `close` means cc has stopped listening: kill the command HARD, then let
    // the kind reap whatever it left on the far side. Without this the derived
    // `sh -c` and its whole pipeline keep running.
    this.#cancelFileOp(id);
  }

  // A FAILED REAP IS REPORTED, NOT SWALLOWED. It still must not take the
  // connection with it — one target's leftovers are not a dead session — but a
  // relay that could not be proved to have run is the MUST-3 hazard itself, and
  // a silent catch here makes it indistinguishable from a clean shutdown. The
  // kind decides what counts as failure (kinds/docker.mjs → `reap`).
  async #reap(state) {
    try { await this.#transport.reap(state.config, state.handle); }
    catch (e) {
      this.#warn(`code-system launcher: reap failed for remote`
        + ` '${state.handle?.remoteId ?? '(unrouted)'}': ${errMsg(e)}`);
    }
  }

  // ── the internal exec runner fileops rides on ──────────────────────

  // Registers the operation and returns the runner bound to it. The handle is
  // MUTATED with the child's pid as soon as it spawns, so `reap` is handed the
  // real far-side identity rather than a placeholder.
  #openFileOp(id, remote) {
    const token = randomBytes(12).toString('hex');
    const handle = { pid: null, token, remoteId: remote?.remoteId ?? null };
    const ac = new AbortController();
    const op = { ac, config: remote?.config ?? {}, handle };
    this.#fileOps.set(id, op);
    const runner = makeRunner(this.#transport, op.config, handle.remoteId, {
      token,
      onSpawn: (child) => { handle.pid = child.pid ?? null; },
    });
    return { op, runner };
  }

  // Drop the operation and take the far side with it. Returns whether there was
  // one, so `close` can stay quiet about ids it never had.
  #cancelFileOp(id) {
    const op = this.#fileOps.get(id);
    if (!op) return false;
    this.#fileOps.delete(id);
    op.ac.abort();
    void this.#reap(op);
    return true;
  }

  // ── readFile ───────────────────────────────────────────────────────

  #readFileOpen(f, remote) {
    const id = String(f.id);
    const { op, runner } = this.#openFileOp(id, remote);
    // Detached on purpose: a round trip to a container must not serialise every
    // other id behind it.
    void this.#readFileBody(f, id, runner, op.ac.signal);
  }

  async #readFileBody(f, id, runner, signal) {
    try {
      const res = await readFileOp(runner, {
        path: String(f.path),
        offset: typeof f.offset === 'number' ? f.offset : 0,
        length: typeof f.length === 'number' ? f.length : null,
        signal,
      });
      if (!this.#fileOps.has(id)) return; // cc closed it while we were away
      this.#write({ type: 'readFileResult', id, size: res.size, mode: res.mode, isBinary: res.isBinary });
      // BOTH ENDS MUST CHUNK: a payload riding as one frame breaches the line
      // ceiling and dies EPROTO mid-transfer.
      for (let at = 0, seq = 0; at < res.data.length; at += CHUNK_BYTES, seq++) {
        this.#write({ type: 'data', id, seq, dataB64: res.data.subarray(at, at + CHUNK_BYTES).toString('base64') });
      }
      this.#write({ type: 'end', id });
    } catch (e) {
      if (!this.#fileOps.has(id)) return;
      this.#fail(id, e?.code ?? 'EUNKNOWN', errMsg(e), {
        ...(e?.exitCode !== null && e?.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e?.stderr ? { stderr: e.stderr } : {}),
      });
    } finally {
      this.#fileOps.delete(id);
    }
  }

  // ── writeFile ──────────────────────────────────────────────────────

  #writeOpen(f, remote) {
    this.#writes.set(String(f.id), {
      path: String(f.path),
      mode: typeof f.mode === 'number' ? f.mode : null,
      atomic: f.atomic === true,
      exclusive: f.exclusive === true,
      remote,
      chunks: [],
      bytes: 0,
      failed: false,
    });
  }

  #writeData(f) {
    const w = this.#writes.get(String(f.id));
    if (!w || w.failed) return;
    // The decoder has already proved this payload is canonical base64, so a
    // corrupted chunk never reaches here as a silent truncation.
    const b = Buffer.from(String(f.dataB64 ?? ''), 'base64');
    w.bytes += b.length;
    if (w.bytes > MAX_FILE_BYTES) {
      w.failed = true;
      w.chunks = [];
      this.#fail(String(f.id), 'EFBIG', `write to '${w.path}' exceeds the ${MAX_FILE_BYTES}-byte protocol cap`);
      return;
    }
    w.chunks.push(b);
  }

  #writeEnd(f) {
    const id = String(f.id);
    const w = this.#writes.get(id);
    if (!w) return;
    this.#writes.delete(id);
    if (w.failed) return;
    const { op, runner } = this.#openFileOp(id, w.remote);
    void this.#writeEndBody(w, id, runner, op.ac.signal);
  }

  async #writeEndBody(w, id, runner, signal) {
    try {
      await writeFileOp(runner, {
        path: w.path,
        data: Buffer.concat(w.chunks),
        mode: w.mode,
        atomic: w.atomic,
        exclusive: w.exclusive,
        signal,
      });
      if (!this.#fileOps.has(id)) return;
      this.#write({ type: 'writeFileResult', id, ok: true });
    } catch (e) {
      if (!this.#fileOps.has(id)) return;
      this.#fail(id, e?.code ?? 'EUNKNOWN', errMsg(e), {
        ...(e?.exitCode !== null && e?.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        ...(e?.stderr ? { stderr: e.stderr } : {}),
      });
    } finally {
      this.#fileOps.delete(id);
    }
  }

  // ── describeRemote ─────────────────────────────────────────────────

  #describeRemote(f, remote) {
    const id = String(f.id);
    if (!this.#caps.remoteDescriptors) {
      // cc reads this as "I advertise nothing" rather than failing the session.
      this.#fail(id, 'EUNSUPPORTED', 'this provider advertises no mirror descriptors');
      return;
    }
    const m = this.#source.mirrorFor(remote?.remoteId ?? null);
    this.#write({
      type: 'remoteDescriptor',
      id,
      ...(m.mirrorRoot ? { mirrorRoot: m.mirrorRoot } : {}),
      ...(m.exclude && m.exclude.length > 0 ? { exclude: m.exclude } : {}),
    });
  }

  // ── shutdown: protocol MUST 3 ──────────────────────────────────────

  // Kill everything still running and take the far side's leftovers with it.
  // A `docker exec` child is not our OS descendant at all — the daemon starts it
  // inside the container on our behalf — and an `ssh` slave outlives its parent.
  // Neither dies when we do (measured: .wiki/gotchas/docker-exec-transport.md),
  // and cc has no way to clean up after a provider that does not do this itself.
  async shutdown() {
    const pending = [];
    for (const [, state] of this.#execs) {
      state.closed = true;
      if (state.timer) clearTimeout(state.timer);
      if (state.killTimer) clearTimeout(state.killTimer);
      // The host-side child (its group where the kind detached it) goes first,
      // then the kind reaps whatever it left on the far side.
      try {
        if (state.detached && state.child.pid) process.kill(-state.child.pid, 'SIGKILL');
        else state.child.kill('SIGKILL');
      } catch { /* already gone */ }
      pending.push(this.#reap(state));
    }
    this.#execs.clear();
    this.#writes.clear();
    // A derived file operation is a live child too — MUST 3 takes it with us,
    // reap included.
    for (const [, op] of this.#fileOps) {
      op.ac.abort();
      pending.push(this.#reap(op));
    }
    this.#fileOps.clear();
    if (pending.length === 0) return;
    await Promise.race([Promise.allSettled(pending), sleep(this.#reapDeadlineMs)]);
  }
}
