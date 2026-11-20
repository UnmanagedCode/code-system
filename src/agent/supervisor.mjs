// THE BROKER'S ONLY STARTER, run in the backend. It starts the broker DETACHED
// — its own process group — so cc killing the backend's group cannot reach it,
// and only while the store holds at least one `agent` record. It adopts a live
// broker rather than starting a second, and replaces one that listens on a
// different address or runs different code.
//
// The launcher never starts a broker: its plans are pure, and a broker started
// by cc's child would be bound to cc's lifetime decisions.

import { spawn } from 'node:child_process';
import { openSync, closeSync, existsSync, readFileSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';
import { listRemotes } from '../store.mjs';
import {
  BROKER_MAIN, agentDir, agentLogPath, agentSocketPath, socketPathDefect, storeRoot,
} from '../paths.mjs';
import { BrokerDown, ensureAgentDir, queryBroker, readBrokerError } from './client.mjs';
import { buildId, desiredListen, parseListen } from './protocol.mjs';

const AGENT_KIND = 'agent';
// How long a started broker gets to answer its first ping.
const START_BUDGET_MS = 3000;
const POLL_MS = 50;
// A log past this is truncated when the next broker starts.
const LOG_MAX_BYTES = 1024 * 1024;
const DEFAULT_TICK_MS = 10_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function hasAgentRecords() {
  return (await listRemotes()).some(e => e.ok && e.record.kind === AGENT_KIND);
}

async function ping(sock) {
  try { return await queryBroker(sock, { t: 'ping' }, { timeoutMs: 1000 }); }
  catch (e) { if (e instanceof BrokerDown) return null; throw e; }
}

function startDetached(spawnImpl, listen) {
  const logPath = agentLogPath();
  try { if (statSync(logPath).size > LOG_MAX_BYTES) truncateSync(logPath, 0); } catch { /* absent */ }
  const fd = openSync(logPath, 'a', 0o600);
  try {
    // `--store` is on the command line so /proc/<pid>/cmdline PROVES which
    // store a broker serves before anything signals it (`brokerPidDefect`).
    const child = spawnImpl(process.execPath, [BROKER_MAIN, '--listen', listen, '--store', storeRoot()], {
      detached: true, stdio: ['ignore', fd, fd], env: process.env,
    });
    child.unref?.();
    return child;
  } finally { closeSync(fd); }
}

let chain = Promise.resolve();

/**
 * Make the broker run if it should. SERIALISED: the startup call, the tick and
 * a card's Connect may all ask at once, and two concurrent starts would race
 * for the port.
 *
 * @param {{spawnImpl?:typeof spawn, listen?:string, killImpl?:typeof process.kill}} [o]
 * @returns {Promise<{running:boolean, pid?:number, address?:string, error?:string, spawned?:boolean}>}
 */
export function ensureBroker(o = {}) {
  const run = chain.then(() => ensureOnce(o));
  chain = run.catch(() => {});
  return run;
}

const PROC = '/proc';
const readProc = (pid, file, procDir = PROC) => readFileSync(`${procDir}/${pid}/${file}`, 'latin1');

// This process and every ancestor up to (and including) pid 1.
function ancestry(self = process.pid, procDir = PROC) {
  const out = new Set([self]);
  let p = self;
  for (let i = 0; i < 64 && p > 1; i++) {
    try {
      const st = readProc(p, 'stat', procDir);
      p = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
    out.add(p);
  }
  return out;
}

/**
 * Why `pid` must NOT be signalled as this store's broker, or null.
 *
 * A pid that arrives as DATA — a `pong` on the socket — is never trusted: the
 * socket may answer for anything (a fake, a stale file, a test). Only a live
 * process that is provably `node <BROKER_MAIN> … --store <this store>`, and is
 * neither pid 1 nor this process nor any of its ancestors, may be signalled.
 */
export function brokerPidDefect(pid, { store = storeRoot(), self = process.pid, procDir = PROC } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return `pid ${JSON.stringify(pid)} is not a process this plugin started`;
  if (ancestry(self, procDir).has(pid)) return `pid ${pid} is this process or one of its ancestors`;
  let argv;
  try { argv = readProc(pid, 'cmdline', procDir).split('\0'); }
  catch (e) {
    // THREE DIFFERENT ANSWERS, each refused: only a readable command line proves anything.
    if (!existsSync(`${procDir}/self`)) {
      return `pid ${pid}'s command line cannot be read: this host has no ${procDir}, so no broker can be proved`
        + ' to be this store\'s, and none is ever signalled';
    }
    if (e.code === 'ENOENT') return `pid ${pid} is not running`;
    return `pid ${pid}'s command line is unreadable (${e.code}), so it cannot be proved to be this store's broker`;
  }
  const at = argv.indexOf('--store');
  if (!path.basename(argv[0] ?? '').startsWith('node') || argv[1] !== BROKER_MAIN
    || at < 0 || argv[at + 1] !== store) {
    return `pid ${pid} is not this store's agent broker (its command line is ${JSON.stringify(argv.join(' ').trim().slice(0, 120))})`;
  }
  return null;
}

/**
 * Whether `pid` is still running. A zombie answers kill(pid, 0) — a probe;
 * signal 0 delivers nothing — but holds no port and no socket: gone. Where
 * /proc cannot say (no /proc on this host, an unreadable entry), it is ALIVE:
 * "can't tell" must never read as "gone", which would start a second broker.
 * `procDir` and `probe` are seams for tests.
 */
export function isAlive(pid, { procDir = PROC, probe = p => process.kill(p, 0) } = {}) {
  try { probe(pid); } catch (e) { return e.code === 'EPERM'; }
  try { return !/\) Z /.test(readProc(pid, 'stat', procDir)); }
  catch (e) { return e.code !== 'ENOENT' || !existsSync(`${procDir}/self`); }
}

/**
 * Stop the broker at `pid`: `stop` on the socket, then SIGTERM, then SIGKILL,
 * each given time to land — and ONLY after `defectOf(pid)` proves it is this
 * store's broker, re-proved before every signal (a pid that stops being one
 * has exited, and may already belong to someone else). `killImpl`, `defectOf`
 * and `aliveImpl` are seams for tests, which must never pass a real kill
 * toward a fabricated pid.
 * @returns {Promise<{gone:boolean, refused?:string}>}
 */
export async function retire(sock, pid, {
  killImpl = process.kill, defectOf = brokerPidDefect, aliveImpl = isAlive, budgetMs = START_BUDGET_MS,
} = {}) {
  const refused = defectOf(pid);
  if (refused) return { gone: false, refused };
  try { await queryBroker(sock, { t: 'stop' }, { timeoutMs: 1000 }); } catch { /* it may already be going */ }
  for (const sig of [null, 'SIGTERM', 'SIGKILL']) {
    if (sig) {
      if (!aliveImpl(pid) || defectOf(pid)) return { gone: true };
      try { killImpl(pid, sig); } catch { /* gone */ }
    }
    for (let waited = 0; waited < budgetMs; waited += POLL_MS) {
      if (!aliveImpl(pid)) return { gone: true };
      await sleep(POLL_MS);
    }
  }
  return { gone: !aliveImpl(pid) };
}

async function ensureOnce({ spawnImpl = spawn, listen = desiredListen(), killImpl = process.kill } = {}) {
  if (!(await hasAgentRecords())) return { running: false, error: 'no agent remote exists' };
  try { parseListen(listen); } catch (e) { return { running: false, error: e.message }; }
  const dir = agentDir();
  const defect = (await ensureAgentDir(dir)) ?? socketPathDefect(agentSocketPath(dir));
  if (defect) return { running: false, error: defect };
  const sock = agentSocketPath(dir);
  const build = buildId();

  let pong;
  try { pong = await ping(sock); }
  catch (e) { return { running: false, error: `the agent listener does not answer: ${e.message}` }; }
  if (pong && pong.listen === listen && pong.build === build) {
    return { running: true, pid: pong.pid, address: pong.address };
  }
  if (pong) {
    // A broker on another address or older code: stop it, and START NOTHING
    // until it is confirmed gone — a second broker beside it would hold the
    // old address open, or lose the port and look like a failure.
    const r = await retire(sock, pong.pid, { killImpl });
    if (r.refused) {
      return {
        running: false,
        error: `the agent listener answering on ${sock} reported pid ${pong.pid}, which was not signalled`
          + ` or replaced: ${r.refused}`,
      };
    }
    if (!r.gone) {
      return {
        running: false,
        error: `the agent listener (pid ${pong.pid}) on ${pong.listen} would not stop, so it was not replaced`
          + ` with one on ${listen}`,
      };
    }
  }

  const child = startDetached(spawnImpl, listen);
  let exited = false;
  child.once?.('exit', () => { exited = true; });
  for (let waited = 0; waited < START_BUDGET_MS; waited += POLL_MS) {
    await sleep(POLL_MS);
    const p = await ping(sock).catch(() => null);
    if (p) return { running: true, pid: p.pid, address: p.address, spawned: true };
    if (exited) break;
  }
  // Ours may have exited because ANOTHER broker won the port: that is a
  // running listener, not a failure, whatever an error file says.
  const winner = await ping(sock).catch(() => null);
  if (winner) return { running: true, pid: winner.pid, address: winner.address };
  const recorded = await readBrokerError(dir);
  return {
    running: false,
    spawned: true,
    error: recorded?.message ?? `the agent listener did not start within ${START_BUDGET_MS} ms (see ${agentLogPath(dir)})`,
  };
}

/** Ask a running broker to stop. Resolves whether one answered. */
export async function stopBroker() {
  try { await queryBroker(agentSocketPath(), { t: 'stop' }, { timeoutMs: 1000 }); return true; }
  catch { return false; }
}

/**
 * What `GET /api/agent/broker` serves: never a secret.
 * @returns {Promise<{listen:string, dialDefault:string, running:boolean, pid?:number,
 *          address?:string, error?:string, refusals:object[]}>}
 */
export async function brokerStatus() {
  const listen = desiredListen();
  let port = null;
  try { port = parseListen(listen).port; } catch { /* reported as the error below */ }
  const sock = agentSocketPath();
  const out = { listen, dialDefault: `127.0.0.1:${port ?? ''}`, running: false, refusals: [] };
  try {
    const pong = await queryBroker(sock, { t: 'ping' }, { timeoutMs: 1000 });
    const actual = Number(String(pong.address ?? '').split(':').pop());
    if (actual > 0) out.dialDefault = `127.0.0.1:${actual}`;
    out.running = true;
    out.pid = pong.pid;
    out.address = pong.address;
    const r = await queryBroker(sock, { t: 'refusals' }, { timeoutMs: 1000 });
    out.refusals = Array.isArray(r.items) ? r.items : [];
  } catch (e) {
    if (!(await hasAgentRecords())) out.error = 'no agent remote exists, so the listener is not running';
    else out.error = (await readBrokerError(agentDir()))?.message
      ?? (e instanceof BrokerDown ? 'the agent listener is not running' : e.message);
  }
  return out;
}

/**
 * The backend's one call: ensure now, then on a tick, never blocking startup.
 * Returns a stop function (tests).
 */
export function initAgentBroker({ tickMs = DEFAULT_TICK_MS, log = console.log } = {}) {
  let last = null;
  const once = async () => {
    try {
      const r = await ensureBroker();
      const note = r.running ? (r.spawned ? `agent listener started on ${r.address} (pid ${r.pid})` : null)
        : (r.error !== 'no agent remote exists' ? `agent listener not running: ${r.error}` : null);
      if (note && note !== last) log(note);
      last = note;
    } catch (e) { log(`agent listener check failed: ${e.message}`); }
  };
  void once();
  const timer = setInterval(once, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
