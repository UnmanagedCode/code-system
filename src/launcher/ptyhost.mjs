// THE HOST-SIDE PTY: cc's own pty helper, driven over its stdio protocol.
//
// A terminal on any kind is a pseudo-terminal on cc's HOST, owned by
// src/launcher/ptyHelper.py — a BYTE-FOR-BYTE copy of code-conductor's
// src/systems/ptyHelper.py, whose stdio protocol is a contract cc owns
// (systems-protocol.md §5, "The pty helper"). Never edit the copy: re-copy it.
// tests/protocol-constants.test.mjs compares the two hashes whenever
// CC_CHECKOUT is set, and both conformance runners abort on drift.
//
// The program the helper runs is the TRANSPORT CLIENT — `docker exec -i -t …`,
// `ssh -tt …` — or, for `host`, the far-side trampoline itself. The helper's
// `w` drain report counts bytes written into THIS pty's master, which is the
// terminal device the provider owns and what every `inputAck` is granted from.
//
// A port of cc's src/systems/ptyHost.ts, with two differences:
//  - NO CWD CHECK. The frame's cwd is a FAR-SIDE path, entered by the
//    trampoline (kinds/ptyscript.mjs); the helper runs at a host cwd the caller
//    names.
//  - NO START TIMEOUT. cc bounds a terminal's open itself (§5).

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PTY_HELPER_PATH = fileURLToPath(new URL('./ptyHelper.py', import.meta.url));

// The operator seam for the interpreter that runs the helper — and the test
// seam for "no python3". An ENV VAR, never a store field, for the reason
// CODE_SYSTEM_DOCKER is one (kinds/docker.mjs): a stored executable would be an
// HTTP-writable program on cc's host.
export const PYTHON_ENV = 'CODE_SYSTEM_PYTHON';

// Above the helper's own CLOSE_GRACE_S, so a healthy helper finishes its own
// hang-up and kill first.
const HELPER_KILL_GRACE_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;
const STDERR_TAIL = 2 * 1024;
const WRITE_CHUNK = 64 * 1024;
// The most `d` bytes sent to the helper and not yet reported written (`w`):
// the helper reads its stdin eagerly, so this is what bounds its own queue.
const HELPER_INPUT_WINDOW_BYTES = 64 * 1024;

export function pythonName(env = process.env) {
  return env[PYTHON_ENV]?.trim() || 'python3';
}

const probes = new Map();

/**
 * Can this host run the helper? Once per process per interpreter name. The
 * answer is the interpreter's ABSOLUTE path, which every terminal then spawns.
 * @returns {Promise<{ok:true, interpreter:string}|{ok:false, reason:string}>}
 */
export function probePtyHelper({ python = pythonName() } = {}) {
  let p = probes.get(python);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(python, ['-I', '-c', 'import pty,termios,fcntl,select,sys; print(sys.executable)'],
        { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
          if (err) {
            resolve({
              ok: false,
              reason: err.code === 'ENOENT'
                ? `${python} not found (set ${PYTHON_ENV} to a python3)`
                : `${python} cannot run the pty helper: ${(stderr || err.message).trim().slice(-STDERR_TAIL)}`,
            });
            return;
          }
          const interpreter = stdout.trim();
          resolve(path.isAbsolute(interpreter)
            ? { ok: true, interpreter }
            : { ok: false, reason: `${python} reported no usable sys.executable (${JSON.stringify(interpreter)})` });
        });
    });
    probes.set(python, p);
  }
  return p;
}

export function encodeHelperFrame(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 1, 'latin1');
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export class HelperFrameDecoder {
  #buf = Buffer.alloc(0);

  push(chunk) {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out = [];
    let at = 0;
    while (this.#buf.length - at >= 5) {
      const len = this.#buf.readUInt32BE(at + 1);
      if (this.#buf.length - at - 5 < len) break;
      out.push({ type: this.#buf.toString('latin1', at, at + 1), payload: this.#buf.subarray(at + 5, at + 5 + len) });
      at += 5 + len;
    }
    this.#buf = this.#buf.subarray(at);
    return out;
  }
}

function parseJson(b) {
  try {
    const v = JSON.parse(b.toString('utf8'));
    return typeof v === 'object' && v !== null ? v : {};
  } catch { return {}; }
}

/**
 * One program under a host pty.
 *
 * @param {{interpreter:string, argv:string[], env:Record<string,string|undefined>,
 *          programEnv:Record<string,string>, cwd:string, cols:number, rows:number}} spec
 *   `env` is the HELPER's environment; `programEnv` is merged over it for the
 *   program only (the helper's first frame, `v`).
 * @param {{onStarted():void, onData(b:Buffer):void, onWritten(n:number):void,
 *          onExit(code:number|null, signal:string|null):void,
 *          onFailed(code:string, message:string):void}} h
 *   Exactly one of `onExit`/`onFailed`, and nothing after `close()`.
 *   `onWritten` is the drain report: n more bytes of `write` are in the pty.
 * @returns {{write(b:Buffer):void, resize(cols:number, rows:number):void,
 *            pause():void, resume():void, close():void}}
 */
export function spawnPty(spec, h) {
  let done = false;
  let started = false;
  let paused = false;
  let killTimer = null;
  let stderrTail = '';
  const queue = [];
  const decoder = new HelperFrameDecoder();
  const input = [];
  let inFlight = 0;
  let failAfterQueue = null;

  const finish = (fn) => {
    if (done) return;
    done = true;
    fn();
  };

  let child = null;
  const send = (b) => {
    if (done || !child) return;
    if (child.stdin?.writable) child.stdin.write(b);
  };

  const sendInput = () => {
    while (!done && child && input.length > 0 && inFlight < HELPER_INPUT_WINDOW_BYTES) {
      const head = input[0];
      const n = Math.min(head.length, WRITE_CHUNK, HELPER_INPUT_WINDOW_BYTES - inFlight);
      send(encodeHelperFrame('d', head.subarray(0, n)));
      inFlight += n;
      if (n === head.length) input.shift();
      else input[0] = head.subarray(n);
    }
  };

  // Frame-granular, so a pause lands between two frames of one pipe chunk.
  const pump = () => {
    while (!paused && !done && queue.length > 0) {
      const f = queue.shift();
      if (f.type === 'S') { started = true; h.onStarted(); }
      else if (f.type === 'o') h.onData(f.payload);
      else if (f.type === 'w' && f.payload.length === 4) {
        const n = f.payload.readUInt32BE(0);
        inFlight -= n;
        h.onWritten(n);
        sendInput();
      } else if (f.type === 'x') {
        const r = parseJson(f.payload);
        finish(() => h.onExit(typeof r.code === 'number' ? r.code : null, typeof r.signal === 'string' ? r.signal : null));
      } else if (f.type === 'e') {
        const r = parseJson(f.payload);
        finish(() => h.onFailed(
          typeof r.code === 'string' && r.code !== '' ? r.code : 'EPTY',
          typeof r.message === 'string' ? r.message : 'the pty helper failed',
        ));
      }
    }
    if (!paused && queue.length === 0) failAfterQueue?.();
  };

  try {
    child = spawn(spec.interpreter, ['-I', PTY_HELPER_PATH, String(spec.cols), String(spec.rows), '--', ...spec.argv], {
      cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // A NUL in an argv entry or the env. Reported on the next tick, so the
    // caller always holds the handle before any handler runs.
    const message = e instanceof Error ? e.message : String(e);
    queueMicrotask(() => finish(() => h.onFailed('EINVAL', message)));
    child = null;
  }
  if (child) {
    const c = child;
    c.stdin?.on('error', () => { /* the helper is gone; its exit reports it */ });
    c.stdout?.on('data', (chunk) => {
      queue.push(...decoder.push(chunk));
      pump();
    });
    c.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    c.on('error', (e) => finish(() => h.onFailed('EPTY', `cannot start the pty helper: ${e.message}`)));
    c.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      failAfterQueue = () => finish(() => h.onFailed(started ? 'ETRANSPORT' : 'EPTY',
        `the pty helper exited (${signal ? `signal ${signal}` : `code ${code}`}) without reporting`
        + (stderrTail.trim() ? `: ${stderrTail.trim()}` : '')));
      pump();
    });
    // The overlay is the FIRST frame: the helper starts nothing before it.
    send(encodeHelperFrame('v', Buffer.from(JSON.stringify(spec.programEnv), 'utf8')));
  }

  return {
    write(data) {
      if (done || data.length === 0) return;
      input.push(data);
      sendInput();
    },
    resize(cols, rows) {
      const p = Buffer.alloc(4);
      p.writeUInt16BE(cols, 0);
      p.writeUInt16BE(rows, 2);
      send(encodeHelperFrame('r', p));
    },
    pause() {
      paused = true;
      child?.stdout?.pause();
    },
    resume() {
      if (!paused) return;
      paused = false;
      child?.stdout?.resume();
      pump();
    },
    close() {
      if (done) return;
      done = true;
      const c = child;
      if (!c) return;
      // Drain and discard, so a helper blocked writing to a paused pipe reaches
      // the stdin EOF that is its instruction to hang up.
      c.stdout?.removeAllListeners('data');
      c.stdout?.resume();
      try { c.stdin?.end(); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* already gone */ } }, HELPER_KILL_GRACE_MS);
      killTimer.unref();
    },
  };
}
