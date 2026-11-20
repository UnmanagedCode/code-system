// THE BRIDGE: one far-side command, as a host-side process the launcher can
// spawn, pipe and kill exactly like a `docker exec` client. It connects to the
// broker's unix socket, opens one stream on the remote's agent session, and
// relays stdin, stdout, stderr and the exit status.
//
//   node bridge.mjs --socket S --remote ID --key KEYID --cwd DIR
//                   [--stdin] [--pty] [--env K=V]... -- ARGV...
//
// THE SECRET IS NEVER HERE. `--key` is its public key id (protocol.mjs
// `keyIdOf`), derived from the CURRENT config so a session still on a previous
// secret is refused.
//
// Its OWN outcomes are one stderr line, `code-system-agent: <tag> <message>`,
// with exit 127 for a command that never started and 255 for everything else;
// the kind's classifyFailure reads that line back. Otherwise it exits as the far
// command did: its code, or 128+n for a signal — and in a terminal it re-raises
// the far signal on itself, so the pty helper reports `{code:null, signal}`.
//
// KILLING A BRIDGE KILLS NOTHING ON THE FAR SIDE. The broker tells the agent the
// stream closed; the agent closes its stdin and keeps draining it. A kill is the
// kind's `reap` (its CC_EXEC_TOKEN scan), exactly as on docker.

import { spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readBrokerError } from './client.mjs';
import { fileURLToPath } from 'node:url';
import {
  BRIDGE_EXIT_NEVER_STARTED, BRIDGE_EXIT_OWN, BRIDGE_TAGS, LineDecoder, MARKER_PREFIX, PROTOCOL, decodeLine, encode,
} from './protocol.mjs';

/**
 * ONE STDIN CHUNK AS FRAMES, in the order they must leave: a `resize` FIRST
 * when the terminal's live size differs from the last one sent — the launcher
 * resizes the host terminal before it writes the input that follows, so
 * reading the size before forwarding that input keeps the two in order — then
 * the chunk as `in` frames of at most `chunkBytes`.
 * @param {Buffer} chunk
 * @param {{cols:number, rows:number}|null} size  the last size sent; null when not a terminal
 * @param {() => [number, number]} getWindowSize
 * @returns {{frames:object[], size:{cols:number, rows:number}|null}}
 */
export function inputFrames(chunk, size, getWindowSize) {
  const frames = [];
  let next = size;
  if (size) {
    const [cols, rows] = getWindowSize();
    if (cols !== size.cols || rows !== size.rows) {
      next = { cols, rows };
      frames.push({ t: 'resize', cols, rows });
    }
  }
  for (let i = 0; i < chunk.length; i += PROTOCOL.chunkBytes) {
    frames.push({ t: 'in', b64: chunk.subarray(i, i + PROTOCOL.chunkBytes).toString('base64') });
  }
  return { frames, size: next };
}

function parseArgs(argv) {
  const o = { socket: null, remote: null, key: null, cwd: null, stdin: false, pty: false, env: {}, argv: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.argv = argv.slice(i + 1); break; }
    if (a === '--stdin') o.stdin = true;
    else if (a === '--pty') o.pty = true;
    else if (a === '--env') {
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq <= 0) throw new Error(`--env wants K=V, got ${JSON.stringify(kv)}`);
      o.env[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (['--socket', '--remote', '--key', '--cwd'].includes(a)) o[a.slice(2)] = argv[++i] ?? null;
    else throw new Error(`unknown bridge option: ${a}`);
  }
  for (const k of ['socket', 'remote', 'key', 'cwd']) if (o[k] === null) throw new Error(`--${k} is required`);
  if (o.argv.length === 0) throw new Error('a command is required after --');
  return o;
}

let finishing = false;
// The last byte relayed to stderr, so the marker always starts a line of its own.
let lastErrByte = null;

// The marker is the LAST thing written and carries NO trailing newline: for a
// command that never started it is the whole of stderr, and cc requires the
// streamed stderr and the error message to be the same text.
function finish(code, marker = null) {
  if (finishing) return;
  finishing = true;
  const out = () => {
    const sep = lastErrByte !== null && lastErrByte !== 10 ? '\n' : '';
    if (marker) process.stderr.write(`${sep}${MARKER_PREFIX}${marker}`, () => process.exit(code));
    else process.exit(code);
  };
  // Every `out` already relayed must reach the launcher before the exit does.
  process.stdout.write('', () => process.stderr.write('', out));
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${MARKER_PREFIX}usage ${e.message}\n`); process.exit(BRIDGE_EXIT_OWN); }

  let size = null;
  if (o.pty) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      finish(BRIDGE_EXIT_OWN, 'usage --pty needs a terminal on stdin and stdout');
      return;
    }
    // RAW, INCLUDING OUTPUT: the far side has its own terminal doing the line
    // discipline, and a second one here would echo, buffer lines, turn ^C into
    // a signal for THIS process and double every carriage return. node's
    // setRawMode leaves output processing on, so `stty raw` finishes the job.
    process.stdin.setRawMode(true);
    spawnSync('stty', ['raw', '-echo'], { stdio: [0, 'ignore', 'ignore'] });
    const [cols, rows] = process.stdout.getWindowSize();
    size = { cols, rows };
  }

  const conn = net.createConnection(o.socket);
  const decoder = new LineDecoder(PROTOCOL.maxFrameBytes);
  let started = false;
  let ended = false;
  // A TERMINAL keeps one chunk in flight, not a window: cc credits terminal
  // input as it reaches the host pty, so input this transport has absorbed
  // reads to cc as input the program took. A full window here would absorb cc's
  // whole input window before the program reads a byte.
  let credit = o.pty ? PROTOCOL.ptyInputWindowBytes : PROTOCOL.windowBytes;
  const send = (f) => { if (!conn.destroyed) conn.write(encode(f)); };

  // A resize always goes out BEFORE the input that follows it: the launcher
  // sets the host terminal's size before it writes the next input, so reading
  // the live size before forwarding each chunk preserves that order.
  const getWindowSize = () => process.stdout.getWindowSize();
  const checkSize = () => {
    const r = inputFrames(Buffer.alloc(0), size, getWindowSize);
    size = r.size;
    for (const f of r.frames) send(f);
  };

  // NEVER PAST THE CREDIT: a read can hand over more than is left, so what
  // does not fit is held (with stdin paused) until an ack makes room — the
  // broker ends a stream whose bridge overruns it. `eof` waits for the held
  // bytes, so it is never sent ahead of input.
  let held = Buffer.alloc(0);
  let eofPending = false;
  const flushInput = () => {
    while (held.length > 0 && credit > 0) {
      const part = held.subarray(0, Math.min(credit, held.length));
      held = held.subarray(part.length);
      const r = inputFrames(part, size, getWindowSize);
      size = r.size;
      for (const f of r.frames) send(f);
      credit -= part.length;
    }
    if (held.length > 0 || credit <= 0) process.stdin.pause();
    else if (!eofPending) process.stdin.resume();
    if (eofPending && held.length === 0) { eofPending = false; send({ t: 'eof' }); }
  };

  const pumpStdin = () => {
    if (!(o.stdin || o.pty)) return;
    process.stdin.on('data', (chunk) => {
      held = held.length ? Buffer.concat([held, chunk]) : chunk;
      flushInput();
    });
    process.stdin.on('end', () => { if (!o.pty) { eofPending = true; flushInput(); } });
    process.stdin.on('error', () => {});
    if (o.pty) process.on('SIGWINCH', checkSize);
  };

  const onFrame = (f) => {
    switch (f.t) {
      case 'started':
        started = true;
        pumpStdin();
        return;
      case 'out': {
        const data = Buffer.from(f.b64, 'base64');
        const dest = f.fd === 2 ? process.stderr : process.stdout;
        if (f.fd === 2 && data.length) lastErrByte = data[data.length - 1];
        // CREDIT IS RETURNED ONLY ONCE THE BYTES ARE WRITTEN, so a launcher that
        // stops reading stops the far process, through every buffer between.
        // And this process holds no more than the socket's own buffer: while a
        // destination is backed up, the socket is not read.
        if (!dest.write(data, () => send({ t: 'ack', fd: f.fd, n: data.length }))) {
          conn.pause();
          dest.once('drain', () => conn.resume());
        }
        return;
      }
      case 'ack':
        if (f.fd === 0) {
          credit += f.n;
          if (started) flushInput();
        }
        return;
      case 'exit':
        ended = true;
        conn.end();
        if (f.code !== null) { finish(f.code); return; }
        if (o.pty) { reraise(f.signal); return; }
        finish(128 + (os.constants.signals[f.signal] ?? 0));
        return;
      case 'failed':
        ended = true;
        finish(BRIDGE_EXIT_NEVER_STARTED, `${BRIDGE_TAGS.neverStarted} ${f.errno} ${f.message}`);
        return;
      case 'refused':
      case 'lost':
        ended = true;
        finish(BRIDGE_EXIT_OWN, `${f.tag} ${f.message}`);
        return;
    }
  };

  conn.on('connect', () => {
    send({
      t: 'open', remoteId: o.remote, keyId: o.key, argv: o.argv, cwd: o.cwd, env: o.env,
      stdin: o.stdin || o.pty, ...(size ? { pty: size } : {}),
    });
  });
  conn.on('data', (chunk) => {
    let lines;
    try { lines = decoder.push(chunk); }
    catch (e) { ended = true; finish(BRIDGE_EXIT_OWN, `${BRIDGE_TAGS.lost} ${e.message}`); return; }
    for (const line of lines) {
      if (ended) return;
      let f;
      try { f = decodeLine(line, PROTOCOL.toBridge); }
      catch (e) { ended = true; finish(BRIDGE_EXIT_OWN, `${BRIDGE_TAGS.lost} the agent listener sent a bad frame: ${e.message}`); return; }
      onFrame(f);
    }
  });
  conn.on('error', async (e) => {
    if (ended) return;
    ended = true;
    if (!started && ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(e.code)) {
      const recorded = await readBrokerError(path.dirname(o.socket));
      finish(BRIDGE_EXIT_OWN, `${BRIDGE_TAGS.brokerDown} the agent listener is not running on cc's host`
        + (recorded ? ` — it could not start: ${recorded.message}` : ' — the plugin backend starts it while an agent card exists'));
      return;
    }
    finish(BRIDGE_EXIT_OWN, `${BRIDGE_TAGS.lost} the connection to the agent listener failed: ${e.message}`);
  });
  conn.on('close', () => {
    if (ended) return;
    ended = true;
    finish(BRIDGE_EXIT_OWN, `${BRIDGE_TAGS.lost} the agent listener went away while the command ran`);
  });
}

function reraise(signal) {
  process.removeAllListeners('SIGWINCH');
  process.stdout.write('', () => {
    try { process.kill(process.pid, signal); } catch { /* unknown name */ }
    // A signal whose default action is not to terminate (or one node handles):
    // the status still has to say so.
    setTimeout(() => process.exit(128 + (os.constants.signals[signal] ?? 0)), 200);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
