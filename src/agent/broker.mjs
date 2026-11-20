// THE AGENT BROKER: a detached process that owns the TCP listener agents dial
// and every authenticated agent session, so both survive a backend or launcher
// restart — the same reason an ssh ControlMaster is its own process.
//
// Started ONLY by the backend (src/agent/supervisor.mjs), in its own process
// group, so cc killing the backend's group cannot reach it. It stops when told
// to (`stop`), on SIGTERM/SIGINT, or by itself once the store holds no `agent`
// record.
//
// BIND ORDER IS THE MUTEX: TCP first, then the unix socket. Two brokers cannot
// both hold the port, so whoever holds it may safely replace a stale socket
// file, and no pid or lock file exists.
//
//   node broker.mjs --listen <host:port> --store <store root>

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRemote, listRemotes, isValidRemoteId } from '../store.mjs';
import { agentDir, agentErrorPath, agentSocketPath, socketPathDefect } from '../paths.mjs';
import { lineSafe } from '../lineSafe.mjs';
import { ensureAgentDir, queryBroker } from './client.mjs';
import { createControlServer } from './control.mjs';
import { createListener } from './listener.mjs';
import { AGENT_SOURCE, BYE, LABELS, buildId, keyIdOf, parseListen, timings, verifyMac } from './protocol.mjs';

// Unknown-remote refusals the page lists, newest last.
const REFUSALS_KEPT = 10;
const AGENT_KIND = 'agent';

// One line per entry, whatever a peer put in it (a remote id from an
// unauthenticated hello can carry a newline).
const log = (msg) => {
  try { process.stderr.write(`${new Date().toISOString()} broker[${process.pid}]: ${lineSafe(msg)}\n`); } catch { /* no log */ }
};

// Read for an id that cannot name a record, so the unknown-remote path does the
// same store read as the others (see `lookupSecret`).
const DUMMY_REMOTE_ID = '0-no-such-remote';
// MAC'd against when no secret was found, so every refusal costs one HMAC.
const DUMMY_SECRET = 'x'.repeat(43);

export class Broker {
  constructor({ listen, address, build, tim }) {
    this.listen = listen;
    this.address = address;
    this.build = build;
    this.tim = tim;
    this.agentBytes = AGENT_SOURCE;
    this.sessions = new Map();
    this.lastRefusal = new Map();
    this.replacements = new Map();
    this.unknown = [];
    this.onStop = () => {};
  }

  // ── what the listener asks ──

  /**
   * The secret to verify a handshake against, or why there is none. EVERY path
   * does one store read — an id that cannot name a record reads a dummy one —
   * and the caller MACs against a dummy secret when none is found, so the time
   * a refusal takes does not say whether the remote exists.
   */
  async lookupSecret(remoteId) {
    const valid = isValidRemoteId(remoteId);
    const r = await readRemote(valid ? remoteId : DUMMY_REMOTE_ID);
    if (!valid || !r.ok) return { reason: 'unknown-remote' };
    if (r.record.kind !== AGENT_KIND) return { reason: 'not-an-agent-remote' };
    const secret = r.record.config?.secret;
    if (typeof secret !== 'string' || secret === '') return { reason: 'no-secret' };
    return { secret };
  }

  /** Verify an `auth` MAC: always exactly one HMAC, found secret or not. */
  async authenticate({ remoteId, nb, na, mac: got }, verify = verifyMac) {
    const found = await this.lookupSecret(remoteId);
    const ok = verify('secret' in found ? found.secret : DUMMY_SECRET, [LABELS.agent, remoteId, nb, na], got);
    return 'secret' in found && ok ? { ok: true, secret: found.secret } : { ok: false, reason: 'secret' in found ? 'wrong-secret' : found.reason };
  }

  recordRefusal({ remoteId, reason, peer }) {
    const at = new Date().toISOString();
    // A peer chose the id: escaped before it is kept, shown or logged.
    const id = lineSafe(String(remoteId).slice(0, 64));
    log(`refused an agent for '${id}' from ${peer}: ${reason}`);
    if (reason === 'wrong-secret' || reason === 'no-secret') {
      this.lastRefusal.set(remoteId, { reason, peer, at });
      return;
    }
    this.unknown.push({ remoteId: id, reason, peer, at });
    if (this.unknown.length > REFUSALS_KEPT) this.unknown.shift();
  }

  adopt(session) {
    const old = this.sessions.get(session.remoteId);
    this.sessions.set(session.remoteId, session);
    this.lastRefusal.delete(session.remoteId);
    log(`agent for '${session.remoteId}' connected from ${session.peer} (session ${session.sessionId})`);
    if (old) {
      this.replacements.set(session.remoteId, (this.replacements.get(session.remoteId) ?? 0) + 1);
      old.end(BYE.replaced, 'a newer agent authenticated for this remote');
    }
  }

  forget(session) {
    if (this.sessions.get(session.remoteId) === session) this.sessions.delete(session.remoteId);
  }

  // ── what the control socket asks ──

  ping() {
    return { pid: process.pid, listen: this.listen, address: this.address, build: this.build };
  }

  sessionFor(remoteId) { return this.sessions.get(remoteId); }

  refusalNote(remoteId) {
    const r = this.lastRefusal.get(remoteId);
    return r ? ` (the last agent that tried was refused: ${r.reason}, from ${r.peer} at ${r.at})` : '';
  }

  /** NEVER the secret: its key id names which one the session used. */
  status(remoteId) {
    const s = this.sessions.get(remoteId);
    return {
      remoteId,
      connected: !!s,
      ...(s ? {
        session: s.sessionId, keyId: s.keyId, peer: s.peer, since: s.since,
        host: s.info?.host ?? null, agentPid: s.info?.pid ?? null, python: s.info?.python ?? null,
      } : {}),
      lastRefusal: this.lastRefusal.get(remoteId) ?? null,
      replacements: this.replacements.get(remoteId) ?? 0,
    };
  }

  refusals() { return [...this.unknown]; }

  stop() { this.onStop('stop requested'); }

  // ── the tick ──

  /**
   * Re-read the store: drop every session whose remote is gone or whose secret
   * changed, and answer whether any agent remote remains.
   */
  async tick() {
    const records = new Map();
    // A record that cannot be read RIGHT NOW (a writer mid-rename, a hand edit)
    // may be an agent record: it neither ends its session nor lets the broker
    // decide no agent remote is left.
    const unreadable = new Set();
    for (const e of await listRemotes()) {
      if (!e.ok) unreadable.add(e.remoteId);
      else if (e.record.kind === AGENT_KIND) records.set(e.record.remoteId, e.record);
    }
    for (const s of [...this.sessions.values()]) {
      if (unreadable.has(s.remoteId)) continue;
      const rec = records.get(s.remoteId);
      const secret = rec?.config?.secret;
      if (typeof secret !== 'string' || keyIdOf(secret) !== s.keyId) {
        s.end(BYE.staleKey, rec ? 'the remote\'s secret changed' : 'the remote was removed');
      }
    }
    for (const id of [...this.lastRefusal.keys()]) {
      if (!records.has(id) && !unreadable.has(id)) this.lastRefusal.delete(id);
    }
    return records.size > 0 || unreadable.size > 0;
  }
}

function parseArgs(argv) {
  let listen = null;
  let store = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--listen') listen = argv[++i] ?? '';
    else if (argv[i] === '--store') store = argv[++i] ?? '';
    else throw new Error(`unknown broker option: ${argv[i]}`);
  }
  if (!listen) throw new Error('--listen <host:port> is required');
  // REQUIRED, and on the command line rather than only in the environment: it
  // is what lets a supervisor prove a pid is this store's broker before it
  // signals it (supervisor.mjs `brokerPidDefect`).
  if (!store || !store.startsWith('/')) throw new Error('--store <absolute store root> is required');
  return { listen, store };
}

async function writeError(dir, message) {
  try {
    await fs.writeFile(agentErrorPath(dir), `${JSON.stringify({ at: new Date().toISOString(), message })}\n`,
      { mode: 0o600 });
  } catch { /* the log still says it */ }
}

async function anotherBrokerAnswers(sock) {
  for (let i = 0; i < 40; i++) {
    try { await queryBroker(sock, { t: 'ping' }, { timeoutMs: 250 }); return true; }
    catch { await new Promise(r => setTimeout(r, 50)); }
  }
  return false;
}

const listenOn = (server, opts) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(opts, () => { server.off('error', reject); resolve(); });
});

export async function runBroker(argv) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { log(e.message); process.exit(2); }
  process.env.CODE_SYSTEM_STORE = opts.store;
  const dir = agentDir();
  const dirDefect = await ensureAgentDir(dir);
  if (dirDefect) { log(dirDefect); process.exit(1); }
  const sockPath = agentSocketPath(dir);
  const pathDefect = socketPathDefect(sockPath);
  if (pathDefect) { log(pathDefect); await writeError(dir, pathDefect); process.exit(1); }

  let tim;
  let where;
  try {
    tim = timings();
    where = parseListen(opts.listen);
  } catch (e) { log(e.message); await writeError(dir, e.message); process.exit(1); }

  const broker = new Broker({ listen: opts.listen, address: null, build: buildId(), tim });
  const tcp = createListener({ broker, tim, log });
  try { await listenOn(tcp, { host: where.host, port: where.port }); }
  catch (e) {
    // LOST A RACE, not a failure: another broker took the port. If one answers
    // on our socket within the start budget, leave no error file behind it.
    if (e.code === 'EADDRINUSE' && await anotherBrokerAnswers(agentSocketPath(dir))) {
      log(`another broker already listens on ${opts.listen}; exiting`);
      process.exit(0);
    }
    const message = `cannot listen on ${opts.listen}: ${e.code === 'EADDRINUSE'
      ? 'the port is already in use by another process' : e.message}`;
    log(message);
    await writeError(dir, message);
    process.exit(1);
  }
  const a = tcp.address();
  broker.address = `${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port}`;

  // We hold the port, so no other broker is alive: any socket file is stale.
  await fs.rm(sockPath, { force: true });
  const control = createControlServer({ broker, log });
  try { await listenOn(control, { path: sockPath }); }
  catch (e) {
    const message = `cannot bind the control socket ${sockPath}: ${e.message}`;
    log(message);
    await writeError(dir, message);
    process.exit(1);
  }
  await fs.chmod(sockPath, 0o600).catch(() => {});
  const ino = (await fs.stat(sockPath)).ino;
  await fs.rm(agentErrorPath(dir), { force: true });
  log(`listening on ${broker.address} (asked for ${opts.listen}), control ${sockPath}, build ${broker.build}`);

  let stopping = false;
  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    clearInterval(ticker);
    tcp.close();
    control.close();
    for (const s of [...broker.sessions.values()]) s.end(BYE.shutdown, 'the agent listener is stopping');
    // Only OUR socket: a newer broker may already have replaced the file.
    try { if ((await fs.stat(sockPath)).ino === ino) await fs.rm(sockPath, { force: true }); }
    catch { /* already gone */ }
    setTimeout(() => process.exit(0), 100);
  };
  broker.onStop = why => { void shutdown(why); };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGHUP', () => {});

  const ticker = setInterval(async () => {
    try {
      if (!(await broker.tick())) void shutdown('the store holds no agent remote');
    } catch (e) { log(`tick failed: ${e.message}`); }
  }, tim.brokerTickMs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runBroker(process.argv.slice(2));
}
