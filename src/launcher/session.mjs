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
import { admits } from './admission.mjs';
import { readFileOp, shellQuote, writeFileOp } from './fileops.mjs';
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
  // The held-open channel pool, or null for a kind that offers none (and for
  // every launcher run with CODE_SYSTEM_CHANNEL=0). Owned by main.mjs, closed
  // here at shutdown.
  #channels;
  // ONE-SHOT. Admission failing closed is safe and SILENT, and this is a
  // performance change: if cc changes one flag in a derivation, that row
  // de-admits, every op quietly returns to the per-op spawn, and every test
  // still passes. So the first frame that is unambiguously a cc derivation and
  // matches no row says so, once, on the stderr surface cc already tails.
  #driftWarned = false;

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
    version = '0.1.0', reapDeadlineMs = REAP_DEADLINE_MS, channels = null,
  }) {
    this.#transport = transport;
    this.#source = source;
    this.#caps = capabilities;
    this.#write = write;
    this.#onFatal = onFatal;
    this.#warn = warn;
    this.#version = version;
    this.#reapDeadlineMs = reapDeadlineMs;
    this.#channels = channels;
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
      case 'detach': return this.#detach(f);
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

    // THE HELD-OPEN CHANNEL, when this frame is one of cc's own derivations and
    // a channel is idle. Everything else — every user command, every frame
    // carrying a deadline or a real cwd, and `removeTree` — falls through to the
    // per-op spawn below, unchanged.
    if (this.#channels && this.#routeToChannel(f, id, remote, req)) return;

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

  /**
   * Try to put this `exec` frame on a channel. Answers whether it went.
   *
   * REFUSING IS FREE AND IS THE DEFAULT: `admits` fails closed, and a frame the
   * pool has no idle channel for is refused synchronously, so nothing here can
   * ever make a frame slower than the spawn path it falls back to.
   */
  #routeToChannel(f, id, remote, req) {
    const verdict = admits(f);
    if (!verdict.ok) {
      if (verdict.drift) this.#warnDrift(f.argv);
      return false;
    }
    // NO `timer`, `killGraceMs` OR `detached`, and their absence is the
    // admission rule showing through: a frame carrying a `timeoutMs` or a
    // `killGraceMs` fails the envelope, so a channel op can never time out or
    // schedule a SIGTERM→SIGKILL grace, and `detached` is read only on the
    // spawn path this state never takes. The idle watchdog in channel.mjs is
    // what bounds a channel op.
    const state = {
      // What tells every other method on this class that there is no host-side
      // child to signal: the op lives in a shell that is already running, and
      // the only thing that reaches it is the kind's reap relay.
      channel: true,
      seq: 0,
      // ALWAYS, for the same reason `docker`'s spawnPlan is never `detached`:
      // nothing we can signal from here reaches the far side's process tree, so
      // every result we terminated must say descendants may survive.
      orphaned: false,
      closed: false,
      terminated: false,
      head: '',
      errHead: '',
      config: remote?.config ?? {},
      handle: { pid: null, token: req.token, remoteId: remote?.remoteId ?? null },
    };
    // The argv becomes a script through the same quoter fileops.mjs uses, so the
    // channel runner has ONE input shape — identical to `makeRunner`'s
    // `['/bin/sh','-c',script]`. A path containing a quote or a newline is safe:
    // it sits inside the quoted operand.
    const script = verdict.argv.map(shellQuote).join(' ');
    const run = this.#channels.tryRun({
      config: state.config,
      remoteId: state.handle.remoteId,
      script,
      token: req.token,
      // STREAMED, not collected: the frames go out as the bytes arrive, exactly
      // as the spawn path's stream handlers do, so a large `readDir` is not
      // materialised here.
      collect: false,
      onStdout: (b) => this.#channelChunk(id, state, 'stdout', b),
      onStderr: (b) => this.#channelChunk(id, state, 'stderr', b),
    });
    if (!run) return false;
    this.#execs.set(id, state);
    void this.#channelSettle(id, state, run);
    return true;
  }

  #channelChunk(id, state, type, b) {
    const head = type === 'stdout' ? 'head' : 'errHead';
    if (state[head].length < HEAD_BYTES) {
      state[head] = (state[head] + b.toString('utf8')).slice(0, HEAD_BYTES);
    }
    if (!state.closed) this.#write({ type, id, seq: state.seq++, dataB64: b.toString('base64') });
  }

  // The channel's equivalent of the spawn path's `close` handler, and it answers
  // the same three questions in the same order: is the id still ours, is this
  // the TRANSPORT's failure or the command's, and does the far side need reaping.
  async #channelSettle(id, state, run) {
    let res = null;
    let err = null;
    try { res = await run; }
    catch (e) { err = e; }
    if (state.closed) {
      // `close`, `detach` or shutdown got here first. They own the reap.
      return;
    }
    state.closed = true;
    this.#execs.delete(id);
    if (err) {
      // THE CHANNEL DIED WITH THIS OP IN FLIGHT. `ETRANSPORT` and never a
      // retry: cc's `#derive` reads it through `spawnErrorCode` and keeps it out
      // of the errno classifier, which is what stops a mutating derivation that
      // LANDED being re-run and reported as `EEXIST`.
      this.#fail(id, err?.code ?? 'ETRANSPORT', errMsg(err));
      return;
    }
    // Not consulted for an op WE killed: that failure is ours, and reading it
    // through the transport's vocabulary could only mislabel it.
    const verdict = res.code !== 0 && !state.terminated
      ? this.#transport.classifyFailure?.(state.config, {
          code: res.code, stdout: state.head, stderr: state.errHead,
        })
      : null;
    if (verdict) {
      this.#fail(id, verdict.code, verdict.message, {
        exitCode: res.code,
        ...(verdict.stderr ? { stderr: verdict.stderr } : {}),
      });
    } else {
      this.#write({
        type: 'exit',
        id,
        code: res.code,
        signal: null,
        timedOut: false,
        ...(state.orphaned ? { descendantsMaySurvive: true } : {}),
      });
    }
  }

  // ONE LINE, ONCE PER SESSION. A frame that passes the envelope AND opens
  // `['env','LC_ALL=C',…]` is a cc derivation by construction — nothing a user
  // command can produce reaches that shape — so matching no row is unambiguously
  // cc-side drift rather than "something was refused". Silent in the healthy
  // case, and it names the file to edit.
  #warnDrift(argv) {
    if (this.#driftWarned) return;
    this.#driftWarned = true;
    this.#warn('code-system launcher: a derivation-shaped exec matched no admission row and took'
      + ' the per-op spawn path — the table in src/launcher/admission.mjs may no longer match this'
      + ` cc: ${JSON.stringify(argv)}`);
  }

  // SIGTERM now, SIGKILL after the grace — a script that traps or ignores
  // SIGTERM would otherwise never die.
  #terminate(state, signal, group) {
    state.terminated = true;
    // A CHANNEL OP HAS NO HOST-SIDE CHILD AT ALL. It is a command inside a shell
    // that is already running, so there is nothing here to signal and the kill
    // has to go the only way it can: the kind's reap relay, by this op's own
    // token. That relay reaches the op's whole process tree and NOT the channel
    // — which is the whole reason the token rides as the command's env prefix —
    // so the channel survives, the op settles with its sentinel, and the slot is
    // returned to the pool.
    if (state.channel) {
      state.orphaned = true;
      void this.#reap(state);
      return;
    }
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
      // `#terminate` already reaped a CHANNEL op — that relay IS its kill, not a
      // follow-up to one — so a second call here would only cost another round
      // trip into the container.
      if (!state.channel) void this.#reap(state);
    }
    this.#writes.delete(id);
    // `close` means cc has stopped listening: kill the command HARD, then let
    // the kind reap whatever it left on the far side. Without this the derived
    // `sh -c` and its whole pipeline keep running.
    this.#cancelFileOp(id);
  }

  // THE OPPOSITE OF `close`: the operation is over and NOTHING is to be killed
  // — the one thing `close` cannot say (systems-protocol.md §5). cc sends it
  // when a redirected shell command settles on cc's own framing sentinel, which
  // may be long before, or instead of, the `exit` we would have reported.
  //
  // Drop the id, cancel every deadline armed for it, emit no further frames for
  // it, and leave the command AND ANYTHING IT BACKGROUNDED RUNNING.
  //
  // DROPPING IT FROM #execs IS THE SECOND HALF, not bookkeeping: MUST 3's exit
  // reap is scoped to operations still OPEN and `shutdown()` iterates #execs,
  // so leaving the id there would reap at exit the background job this frame
  // exists to spare (§1 MUST 3's carve-out, §11 item 1).
  //
  // THE STREAM HANDLERS STAY ATTACHED, reading and discarding: §5 measured that
  // pausing them blocks a survivor still writing and destroying them kills it
  // with SIGPIPE. `state.closed` is what silences the frames, and `head` /
  // `errHead` are already capped at HEAD_BYTES.
  //
  // `exec` IDS ONLY (§5). A detach naming a file operation or an id we do not
  // have is DROPPED — the same answer §4 gives every frame for a closed id.
  #detach(f) {
    const id = String(f.id);
    const state = this.#execs.get(id);
    if (!state) return;
    state.closed = true;
    // HYGIENE, AND CURRENTLY UNOBSERVABLE: `state.closed` above already neuters
    // both timers — `#terminate`'s `send` and the SIGKILL backstop behind it
    // each early-return on it — so deleting these two lines changes nothing you
    // can measure today. They stay because that masking is incidental: a change
    // that stops setting `closed` first, or that moves the flag, would
    // resurrect an armed deadline on an operation cc has already ended.
    if (state.timer) clearTimeout(state.timer);
    if (state.killTimer) clearTimeout(state.killTimer);
    this.#execs.delete(id);
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
      // ADMITTED BY PROVENANCE, not by inspection. These scripts are authored by
      // fileops.mjs itself — nothing frame-supplied reaches them except as a
      // quoted operand — and they background nothing, so the `exit`-frame hazard
      // (a survivor holding stdout open) cannot arise. `pid` stays null; `reap`
      // works by token, not by pid.
      channels: this.#channels,
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

  // `async` because the store-backed source reads the record; `handle` returns
  // this promise into the serialised frame chain, whose existing catch reports a
  // throw. THE SINGLE PLACE A DESCRIPTOR IS SHAPED: a source that advertises
  // nothing yields a frame with NEITHER field, which §2.1 calls a valid
  // "I advertise nothing".
  async #describeRemote(f, remote) {
    const id = String(f.id);
    if (!this.#caps.remoteDescriptors) {
      // cc reads this as "I advertise nothing" rather than failing the session.
      this.#fail(id, 'EUNSUPPORTED', 'this provider advertises no mirror descriptors');
      return;
    }
    const m = await this.#source.mirrorFor(remote?.remoteId ?? null);
    const frame = { type: 'remoteDescriptor', id };
    // ABSENT vs FALSY, and the distinction is load-bearing. A stored root of
    // `""` or `0` is an INVALID claim, not an absent one, and swallowing it here
    // would turn cc's MIRROR_ADVERTISEMENT_INVALID into a silently different
    // session. Only `null`/`undefined` mean "nothing advertised".
    if (m.mirrorRoot != null) frame.mirrorRoot = m.mirrorRoot;
    // An EMPTY LIST really is the same as none — §2.1's "advertise nothing" —
    // so it is omitted. Anything else present goes on the wire for cc to judge.
    if (m.exclude != null && !(Array.isArray(m.exclude) && m.exclude.length === 0)) {
      frame.exclude = m.exclude;
    }
    this.#write(frame);
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
      // then the kind reaps whatever it left on the far side. A CHANNEL op has
      // no host-side child; the reap is the whole of its kill.
      if (!state.channel) {
        try {
          if (state.detached && state.child.pid) process.kill(-state.child.pid, 'SIGKILL');
          else state.child.kill('SIGKILL');
        } catch { /* already gone */ }
      }
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
    if (this.#channels) {
      // THE CENSUS LINE: one line beside the reap warnings already emitted here,
      // answering "was the channel carrying ops" for any session that ended
      // cleanly. `channels` counts channels that OPENED — a target whose channel
      // could never be started reports 0 and every op took the spawn path.
      const c = this.#channels.stats();
      this.#warn(`code-system launcher: channel carried ${c.carried} of ${c.admitted}`
        + ` admitted ops on ${c.channels} channels`);
      // The channels themselves need no reap token: a shell blocked on a
      // `docker exec`'s stdin dies with its host client (measured), and closing
      // stdin ends it cleanly. In-flight channel OPS are reaped above, by their
      // own per-op tokens.
      this.#channels.close();
    }
    if (pending.length === 0) return;
    await Promise.race([Promise.allSettled(pending), sleep(this.#reapDeadlineMs)]);
  }
}
