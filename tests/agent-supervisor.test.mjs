// THE BROKER'S STARTER (src/agent/supervisor.mjs): when it starts one, when it
// adopts one, when it replaces one, and how a broker that cannot start says
// why — on the card's probe and on GET /api/agent/broker. Real broker
// processes on ephemeral loopback ports; a spy spawn where the point is that
// nothing is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pinTestEnv, withApi, writeRecord } from './helpers.mjs';
import {
  FAST, agentRecord, agentStore, newSecret, removeRecord, startBroker, waitFor,
} from './agentFixture.mjs';
import { brokerPidDefect, ensureBroker, isAlive, retire, stopBroker } from '../src/agent/supervisor.mjs';
import { queryBroker } from '../src/agent/client.mjs';
import { createAgentTransport } from '../src/launcher/kinds/agent.mjs';

const ENV = { CODE_SYSTEM_AGENT_LISTEN: '127.0.0.1:0', CODE_SYSTEM_AGENT_TIMINGS: JSON.stringify(FAST) };
const sockIn = store => path.join(store.dir, 'agent', 'broker.sock');
const ping = store => queryBroker(sockIn(store), { t: 'ping' }, { timeoutMs: 500 });
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };

// A pid no process can have: above the kernel's pid_max. Signalling it could
// reach nothing, and the tests below assert nothing tries.
const IMPOSSIBLE_PID = Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()) + 1;

// A kill that records and never signals: the only kind a test hands to code
// that signals a pid it was TOLD.
function recordingKill() {
  const calls = [];
  const fn = (pid, sig) => { calls.push([pid, sig]); };
  fn.calls = calls;
  return fn;
}

// Stop whatever broker this test left, and wait until it is gone. A pid here
// came from a `pong` — data — so it is SIGKILLed only if it is provably this
// store's broker.
function cleanup(t, storeDir) {
  const pids = new Set();
  t.after(async () => {
    await stopBroker();
    for (const pid of pids) {
      await waitFor(() => gone(pid), { what: `broker ${pid} to exit` }).catch(() => {
        if (brokerPidDefect(pid, { store: storeDir }) === null) process.kill(pid, 'SIGKILL');
      });
    }
  });
  return pid => { pids.add(pid); return pid; };
}

const spy = () => {
  const calls = [];
  const fn = (...args) => { calls.push(args); return spawn(...args); };
  fn.calls = calls;
  return fn;
};

test('no agent record: nothing is started', async (t) => {
  await pinTestEnv(t, ENV);
  const s = spy();
  const r = await ensureBroker({ spawnImpl: s });
  assert.equal(r.running, false);
  assert.equal(s.calls.length, 0);
});

// PINS: a dead socket starts one, DETACHED in its own process group; a live
// matching one is adopted with no second spawn.
test('a dead socket starts a detached broker; a live, matching one is adopted', async (t) => {
  const store = await pinTestEnv(t, ENV);
  const track = cleanup(t, store.dir);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  const s = spy();
  const first = await ensureBroker({ spawnImpl: s });
  assert.equal(first.running, true, first.error);
  track(first.pid);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][2].detached, true, 'its own process group: a kill of the backend\'s group cannot reach it');
  assert.equal((await ping(store)).pid, first.pid);

  const again = await ensureBroker({ spawnImpl: s });
  assert.equal(s.calls.length, 1, 'adopted, not respawned');
  assert.equal(again.pid, first.pid);
});

// PINS: a broker on a different listen address is stopped and replaced.
test('a broker listening elsewhere is stopped and replaced', async (t) => {
  const store = await pinTestEnv(t, ENV);
  const track = cleanup(t, store.dir);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  const old = await ensureBroker({ listen: 'localhost:0' });
  track(old.pid);
  const now = await ensureBroker({ listen: '127.0.0.1:0' });
  track(now.pid);
  assert.equal(now.running, true, now.error);
  assert.notEqual(now.pid, old.pid);
  await waitFor(() => gone(old.pid), { what: 'the old broker to exit' });
  assert.equal((await ping(store)).listen, '127.0.0.1:0');
});

// PINS that a pid which arrives as DATA is never signalled: a socket answering
// `pong` for a pid that is not provably this store's broker is neither told to
// stop nor signalled nor replaced, and the error names the pid and why. The
// fake reports a pid no process can have, and the kill only records.
test('a stale broker whose pid is not provably ours is refused, never signalled or replaced', async (t) => {
  const store = await pinTestEnv(t, ENV);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  await fs.mkdir(path.join(store.dir, 'agent'), { mode: 0o700 });
  const seen = [];
  const fake = net.createServer((c) => {
    c.on('data', (b) => {
      const f = JSON.parse(String(b).trim());
      seen.push(f.t);
      if (f.t === 'ping') c.end(`${JSON.stringify({ t: 'pong', pid: IMPOSSIBLE_PID, listen: '127.0.0.1:0', build: 'stale', address: 'x' })}\n`);
      if (f.t === 'stop') c.end(`${JSON.stringify({ t: 'stopping' })}\n`);
    });
  });
  await new Promise(r => fake.listen(sockIn(store), r));
  t.after(() => new Promise(r => fake.close(r)));
  const kill = recordingKill();
  const s = spy();
  const r = await ensureBroker({ killImpl: kill, spawnImpl: s });
  assert.equal(r.running, false);
  assert.match(r.error, new RegExp(`pid ${IMPOSSIBLE_PID}`));
  assert.match(r.error, /not running/);
  assert.deepEqual(kill.calls, [], 'no signal was sent');
  assert.equal(seen.includes('stop'), false, 'and no stop either');
  assert.equal(s.calls.length, 0, 'and no replacement was started');
});

// PINS the guard itself: pid 1 (the container's init), this process, its
// parent, and a live process that is not a broker are each refused before any
// signal — with a recording kill, so nothing real is ever sent.
test('retire refuses pid 1, this process, its parent and a live non-broker', async (t) => {
  const store = await pinTestEnv(t, ENV);
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await new Promise(r => other.once('spawn', r));
  for (const pid of [1, process.pid, process.ppid, other.pid, 0, -1, IMPOSSIBLE_PID]) {
    const kill = recordingKill();
    const r = await retire(sockIn(store), pid, { killImpl: kill, budgetMs: 50 });
    assert.equal(r.gone, false, `pid ${pid}`);
    assert.match(r.refused, /pid/, `pid ${pid}: ${r.refused}`);
    assert.deepEqual(kill.calls, [], `pid ${pid}: no signal`);
  }
  assert.match(brokerPidDefect(other.pid), /not this store's agent broker/);
  assert.match(brokerPidDefect(process.ppid), /ancestors/);
});

// PINS A8's escalation, on a SIMULATED process (every seam injected, nothing
// real signalled): a broker ignoring `stop` gets SIGTERM, one ignoring that
// gets SIGKILL, and one that survives everything is reported not gone.
test('retire escalates stop → SIGTERM → SIGKILL, and reports a survivor', async () => {
  const run = async (diesOn) => {
    const kill = recordingKill();
    const aliveImpl = () => !kill.calls.some(([, sig]) => sig === diesOn);
    const r = await retire('/nonexistent.sock', 4242, { killImpl: kill, defectOf: () => null, aliveImpl, budgetMs: 60 });
    return { r, sigs: kill.calls.map(([pid, sig]) => `${pid}:${sig}`) };
  };
  assert.deepEqual(await run('SIGTERM'), { r: { gone: true }, sigs: ['4242:SIGTERM'] });
  assert.deepEqual(await run('SIGKILL'), { r: { gone: true }, sigs: ['4242:SIGTERM', '4242:SIGKILL'] });
  assert.deepEqual(await run('never'), { r: { gone: false }, sigs: ['4242:SIGTERM', '4242:SIGKILL'] });
});

test('a stale socket file is reclaimed', async (t) => {
  const store = await pinTestEnv(t, ENV);
  const track = cleanup(t, store.dir);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  await fs.mkdir(path.join(store.dir, 'agent'), { mode: 0o700 });
  await fs.writeFile(sockIn(store), 'not a socket');
  const r = await ensureBroker();
  track(r.pid);
  assert.equal(r.running, true, r.error);
});

// PINS: an agent directory with a group/other bit is REFUSED, not repaired.
test('an agent directory others can reach is refused by name', async (t) => {
  const store = await pinTestEnv(t, ENV);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  await fs.mkdir(path.join(store.dir, 'agent'), { mode: 0o755 });
  await fs.chmod(path.join(store.dir, 'agent'), 0o755);
  const r = await ensureBroker({ spawnImpl: spy() });
  assert.equal(r.running, false);
  assert.match(r.error, /must be 700/);
});

// PINS the startup-failure path end to end: port in use → the broker writes
// broker-error.json and exits → ensure, the card's probe and the API route all
// name it.
test('a port in use is named by ensure, by the card\'s probe and by GET /agent/broker', async (t) => {
  const busy = net.createServer();
  await new Promise(r => busy.listen(0, '127.0.0.1', r));
  t.after(() => busy.close());
  const listen = `127.0.0.1:${busy.address().port}`;
  const { call, store } = await withApi(t, {}, { ...ENV, CODE_SYSTEM_AGENT_LISTEN: listen });
  const secret = newSecret();
  await writeRecord(store.dir, agentRecord('a', secret));
  const r = await ensureBroker();
  assert.equal(r.running, false);
  assert.match(r.error, /already in use/);
  assert.ok(existsSync(path.join(store.dir, 'agent', 'broker-error.json')));

  const reach = await createAgentTransport().reachability({ secret }, { remoteId: 'a' });
  assert.equal(reach.connected, false);
  assert.match(reach.detail, /listener not running: .*already in use/);

  const api = await call('GET', '/agent/broker');
  assert.equal(api.status, 200);
  assert.equal(api.body.running, false);
  assert.equal(api.body.listen, listen);
  assert.match(api.body.error, /already in use/);

  const card = await call('POST', '/remotes/a/connect');
  assert.equal(card.status, 502, 'Connect refuses while the listener cannot run');
  assert.match(card.body.error, /already in use/);
});

// PINS the broker's own stop: once the last agent remote is gone it exits by
// itself, on its tick, and removes its socket.
test('the broker exits by itself once the last agent remote is deleted', async (t) => {
  const store = await pinTestEnv(t, ENV);
  const track = cleanup(t, store.dir);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  const r = await ensureBroker();
  track(r.pid);
  await removeRecord(store.dir, 'a');
  await waitFor(() => gone(r.pid), { what: 'the broker to exit' });
  assert.equal(existsSync(sockIn(store)), false, 'and it removed its socket');
});

test('GET /agent/broker reports a running listener, its dial default and unknown-remote refusals', async (t) => {
  const { call, store } = await withApi(t, {}, ENV);
  const track = cleanup(t, store.dir);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  const r = await ensureBroker();
  track(r.pid);
  const port = Number(r.address.split(':').pop());
  const c = net.createConnection({ host: '127.0.0.1', port });
  await new Promise(res => c.once('connect', res));
  c.write(`${JSON.stringify({ t: 'hello', v: 1, remoteId: 'who-is-this', nonce: 'ab' })}\n`);
  await new Promise(res => c.once('data', res));
  c.write(`${JSON.stringify({ t: 'auth', mac: 'cd' })}\n`);
  await new Promise(res => c.once('close', res));

  const body = (await call('GET', '/agent/broker')).body;
  assert.equal(body.running, true);
  assert.equal(body.pid, r.pid);
  assert.equal(body.dialDefault, `127.0.0.1:${port}`);
  assert.deepEqual(body.refusals.map(x => [x.remoteId, x.reason]), [['who-is-this', 'unknown-remote']]);
});

// Item 6 (round 3). PINS the `--store` half of the guard: a REAL broker serving
// another store is a live `node <BROKER_MAIN>` — and still not this store's, so
// it is refused by name and `retire` sends it nothing. (It is cleaned up through
// the child handle the fixture spawned.)
test('a real broker of another store is refused and never signalled', async (t) => {
  await pinTestEnv(t, ENV);
  const other = await agentStore(t);
  await writeRecord(other, agentRecord('o', newSecret()));
  const b = await startBroker(t, other, { env: { CODE_SYSTEM_AGENT_TIMINGS: JSON.stringify({ ...FAST, brokerTickMs: 60000 }) } });
  assert.match(brokerPidDefect(b.pid), /not this store's agent broker/);
  assert.equal(brokerPidDefect(b.pid, { store: other }), null, 'the same pid IS the other store\'s broker');
  const kill = recordingKill();
  const r = await retire(b.sock, b.pid, { killImpl: kill, budgetMs: 50 });
  assert.equal(r.gone, false);
  assert.match(r.refused, /not this store's agent broker/);
  assert.deepEqual(kill.calls, []);
  assert.equal(gone(b.pid), false, 'and it is untouched');
});

// Item 4 (round 3). PINS that the guard tells three cases apart, each a refusal
// naming its reason: a host with no /proc, a command line that cannot be read,
// and a pid that is not running.
test('brokerPidDefect names a missing /proc, an unreadable cmdline and a gone pid apart', async (t) => {
  await pinTestEnv(t, ENV);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-fakeproc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.match(brokerPidDefect(4242424, { procDir: dir }), /this host has no .*no broker can be proved/);
  await fs.mkdir(path.join(dir, 'self'));
  await fs.mkdir(path.join(dir, '4242424', 'cmdline'), { recursive: true });
  assert.match(brokerPidDefect(4242424, { procDir: dir }), /command line is unreadable \(EISDIR\)/);
  assert.match(brokerPidDefect(4242425, { procDir: dir }), /is not running/);
});

// Round 4, item 4. PINS isAlive's "can't tell" branch: with the probe saying
// the pid exists, a missing stat entry is GONE only where /proc exists; with no
// /proc at all, or an entry that cannot be read, it is ALIVE — so the
// supervisor never takes "can't tell" for "gone" and starts a second broker.
// The probe is injected: nothing is sent to the fabricated pids.
test('isAlive reads "cannot tell" as alive, and only a confirmed absence as gone', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-fakeproc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const probe = () => {};
  assert.equal(isAlive(4242424, { procDir: dir, probe }), true, 'no /proc: cannot tell, so alive');
  await fs.mkdir(path.join(dir, 'self'));
  assert.equal(isAlive(4242424, { procDir: dir, probe }), false, '/proc present, no entry: gone');
  await fs.mkdir(path.join(dir, '4242425'));
  await fs.writeFile(path.join(dir, '4242425', 'stat'), '4242425 (node) S 1 1 1');
  await fs.chmod(path.join(dir, '4242425', 'stat'), 0);
  // Root reads a mode-0 file anyway, so the EACCES case needs an ordinary user.
  if (process.getuid() !== 0) assert.equal(isAlive(4242425, { procDir: dir, probe }), true, 'unreadable entry (EACCES): alive');
  await fs.chmod(path.join(dir, '4242425', 'stat'), 0o600);
  await fs.writeFile(path.join(dir, '4242425', 'stat'), '4242425 (node) Z 1 1 1');
  assert.equal(isAlive(4242425, { procDir: dir, probe }), false, 'a zombie: gone');
  assert.equal(isAlive(4242425, { procDir: dir, probe: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); } }), false);
});
