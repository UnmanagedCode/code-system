// THE BROKER'S ONLY STARTER, run in the backend. It starts the broker DETACHED
// — its own process group — so cc killing the backend's group cannot reach it,
// and only while the store holds at least one `agent` record. It adopts a live
// broker rather than starting a second, and replaces one that listens on a
// different address or runs different code.
//
// The launcher never starts a broker: its plans are pure, and a broker started
// by cc's child would be bound to cc's lifetime decisions.

import { spawn } from 'node:child_process';
import { openSync, closeSync, statSync, truncateSync } from 'node:fs';
import { listRemotes } from '../store.mjs';
import {
  BROKER_MAIN, agentDir, agentLogPath, agentSocketPath, socketPathDefect,
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
    const child = spawnImpl(process.execPath, [BROKER_MAIN, '--listen', listen], {
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
 * @param {{spawnImpl?:typeof spawn, listen?:string}} [o]
 * @returns {Promise<{running:boolean, pid?:number, address?:string, error?:string, spawned?:boolean}>}
 */
export function ensureBroker(o = {}) {
  const run = chain.then(() => ensureOnce(o));
  chain = run.catch(() => {});
  return run;
}

async function ensureOnce({ spawnImpl = spawn, listen = desiredListen() } = {}) {
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
    // A broker on another address or older code: stop it and start ours.
    try { await queryBroker(sock, { t: 'stop' }, { timeoutMs: 1000 }); } catch { /* it may already be going */ }
    for (let waited = 0; waited < START_BUDGET_MS && (await ping(sock).catch(() => null)) !== null; waited += POLL_MS) {
      await sleep(POLL_MS);
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
