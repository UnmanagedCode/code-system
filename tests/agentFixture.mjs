// Real broker and real Python agent subprocesses, on loopback, over a fresh
// temp store per test. Every deadline is shrunk through the test-only
// CODE_SYSTEM_AGENT_TIMINGS seam so nothing waits out a production timeout.
//
// The agent needs Python >= 3.9. Without one the suites that use it SKIP,
// loudly, naming CODE_SYSTEM_PYTHON — and `agentRoster` proves by count that
// they really ran when one is present.

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO, tempStore, writeRecord, record } from './helpers.mjs';
import { queryBroker } from '../src/agent/client.mjs';

export const AGENT_PY = path.join(REPO, 'agent', 'agent.py');
export const BROKER = path.join(REPO, 'src', 'agent', 'broker.mjs');
export const BRIDGE = path.join(REPO, 'src', 'agent', 'bridge.mjs');

export const FAST = {
  handshakeTimeoutMs: 1000,
  pingIntervalMs: 200,
  keepaliveTimeoutMs: 1200,
  brokerTickMs: 100,
  backoffBaseMs: 50,
  backoffCapMs: 300,
  backoffStableMs: 500,
};

/** A python3 >= 3.9, or {python:null, reason}. */
export function findPython() {
  const python = process.env.CODE_SYSTEM_PYTHON?.trim() || 'python3';
  try {
    const v = execFileSync(python, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' }).trim();
    const [maj, min] = v.split('.').map(Number);
    if (maj > 3 || (maj === 3 && min >= 9)) return { python, version: v, reason: null };
    return { python: null, reason: `${python} is Python ${v}; the agent needs 3.9 or later (set CODE_SYSTEM_PYTHON)` };
  } catch (e) {
    return { python: null, reason: `${python} cannot run (${e.message.split('\n')[0]}); set CODE_SYSTEM_PYTHON to a Python 3.9+` };
  }
}

export const PY = findPython();
// The `skip` option every agent test passes: a string names why it skipped.
export const NEEDS_PYTHON = PY.python ? false : `no usable Python for the agent: ${PY.reason}`;
if (NEEDS_PYTHON) process.stderr.write(`SKIPPING agent suites — ${NEEDS_PYTHON}\n`);

export const newSecret = () => randomBytes(32).toString('base64url');

export function agentRecord(remoteId, secret, over = {}) {
  return record(remoteId, { kind: 'agent', config: { secret }, ...over });
}

export async function waitFor(fn, { timeoutMs = 8000, stepMs = 25, what = 'a condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; }
    catch (e) { last = e; }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise(r => setTimeout(r, stepMs));
  }
}

export const sockOf = store => path.join(store, 'agent', 'broker.sock');

/** The environment every agent-side process in a test runs under. */
export function agentEnv(store, extra = {}) {
  const { CONDUCTOR_URL: _never, ...inherited } = process.env;
  return {
    ...inherited,
    CODE_SYSTEM_STORE: store,
    CODE_SYSTEM_AGENT_TIMINGS: JSON.stringify(FAST),
    CODE_SYSTEM_DOCKER: '["/definitely-not-docker-xyz"]',
    CODE_SYSTEM_SSH: '["/definitely-not-ssh-xyz"]',
    ...extra,
  };
}

const live = new Set();
process.on('exit', () => { for (const c of live) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } } });

// `graceful`: SIGTERM first — an agent ends every command of its session on
// SIGTERM, while a SIGKILLed agent strands them (the documented hole) — then
// SIGKILL whatever is left.
function track(t, child, { graceful = false } = {}) {
  live.add(child);
  let exited = false;
  child.on('exit', () => { exited = true; live.delete(child); });
  t.after(async () => {
    if (graceful && !exited) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 40 && !exited; i++) await new Promise(r => setTimeout(r, 25));
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  });
  return child;
}

/** A fresh store, removed after the test. */
export async function agentStore(t) {
  const s = await tempStore();
  t.after(() => s.cleanup());
  return s.dir;
}

/**
 * A real broker on an ephemeral loopback port. Resolves once it answers.
 * @returns {Promise<{pid:number, address:string, port:number, sock:string, child, log:()=>string}>}
 */
export async function startBroker(t, store, { listen = '127.0.0.1:0', env = {} } = {}) {
  let log = '';
  const child = track(t, spawn(process.execPath, [BROKER, '--listen', listen], {
    env: agentEnv(store, env), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  }));
  child.stdout.on('data', b => { log += b; });
  child.stderr.on('data', b => { log += b; });
  const sock = sockOf(store);
  const pong = await waitFor(() => queryBroker(sock, { t: 'ping' }, { timeoutMs: 300 }), { what: `the broker to answer (log: ${log})` });
  const port = Number(pong.address.split(':').pop());
  return { pid: pong.pid, address: pong.address, port, sock, child, log: () => log };
}

/**
 * A real agent.py. `env` may override CODE_SYSTEM_AGENT_SECRET.
 * @returns {{child, pid:number, stderr:()=>string}}
 */
export function startAgent(t, { address, remoteId, secret, env = {}, args = [] }) {
  let stderr = '';
  const child = track(t, spawn(PY.python, [AGENT_PY, '--connect', address, '--remote', remoteId, ...args], {
    env: { ...process.env, CODE_SYSTEM_AGENT_SECRET: secret, CODE_SYSTEM_AGENT_TIMINGS: JSON.stringify(FAST), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  }), { graceful: true });
  child.stderr.on('data', b => { stderr += b; });
  return { child, pid: child.pid, stderr: () => stderr };
}

export function status(sock, remoteId) {
  return queryBroker(sock, { t: 'status', remoteId }, { timeoutMs: 1000 });
}

/** Resolves the status once `remoteId` has a session (optionally a NEW one). */
export function connected(sock, remoteId, { not = null } = {}) {
  return waitFor(async () => {
    const s = await status(sock, remoteId);
    return s.connected && s.session !== not && s.host !== null ? s : null;
  }, { what: `an agent session for '${remoteId}'` });
}

/** A store with one enabled agent remote, a broker, and a connected agent. */
export async function agentWorld(t, { remoteId = 'ag', enabled = true } = {}) {
  const store = await agentStore(t);
  const secret = newSecret();
  await writeRecord(store, agentRecord(remoteId, secret, { enabled }));
  const broker = await startBroker(t, store);
  const agent = startAgent(t, { address: broker.address, remoteId, secret });
  const st = await connected(broker.sock, remoteId);
  return { store, secret, broker, agent, remoteId, session: st.session };
}

/** Pids whose environment carries CC_EXEC_TOKEN=<token> (this machine's /proc). */
export function pidsWithToken(token) {
  const needle = `CC_EXEC_TOKEN=${token}`;
  const out = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/environ`, 'latin1').split('\0').includes(needle)) out.push(Number(d));
    } catch { /* gone or not ours */ }
  }
  return out;
}

/** Pids whose environment carries NAME=value. */
export function pidsWithEnv(name, value) {
  const needle = `${name}=${value}`;
  const out = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/environ`, 'latin1').split('\0').includes(needle)) out.push(Number(d));
    } catch { /* gone */ }
  }
  return out;
}

export const alive = (pid) => {
  try {
    const st = readFileSync(`/proc/${pid}/stat`, 'latin1');
    return !/\) [ZX] /.test(st);
  } catch { return false; }
};

export async function writeAgentRecord(store, remoteId, secret, over = {}) {
  return writeRecord(store, agentRecord(remoteId, secret, over));
}

export async function removeRecord(store, remoteId) {
  await fs.rm(path.join(store, 'remotes', `${remoteId}.json`), { force: true });
}
