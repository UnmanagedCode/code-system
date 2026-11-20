// THE BROKER'S STARTER (src/agent/supervisor.mjs): when it starts one, when it
// adopts one, when it replaces one, and how a broker that cannot start says
// why — on the card's probe and on GET /api/agent/broker. Real broker
// processes on ephemeral loopback ports; a spy spawn where the point is that
// nothing is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pinTestEnv, withApi, writeRecord } from './helpers.mjs';
import { FAST, agentRecord, newSecret, removeRecord, waitFor } from './agentFixture.mjs';
import { ensureBroker, stopBroker } from '../src/agent/supervisor.mjs';
import { queryBroker } from '../src/agent/client.mjs';
import { createAgentTransport } from '../src/launcher/kinds/agent.mjs';

const ENV = { CODE_SYSTEM_AGENT_LISTEN: '127.0.0.1:0', CODE_SYSTEM_AGENT_TIMINGS: JSON.stringify(FAST) };
const sockIn = store => path.join(store.dir, 'agent', 'broker.sock');
const ping = store => queryBroker(sockIn(store), { t: 'ping' }, { timeoutMs: 500 });
const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };

// Stop whatever broker this test left, and wait until it is gone.
function cleanup(t) {
  const pids = new Set();
  t.after(async () => {
    await stopBroker();
    for (const pid of pids) {
      await waitFor(() => gone(pid), { what: `broker ${pid} to exit` }).catch(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
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
  const track = cleanup(t);
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
  const track = cleanup(t);
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

// PINS: a broker running different code (a stale build) is asked to stop and
// replaced. A fake control socket stands in for the old broker.
test('a broker with a different build is told to stop, then replaced', async (t) => {
  const store = await pinTestEnv(t, ENV);
  const track = cleanup(t);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  await fs.mkdir(path.join(store.dir, 'agent'), { mode: 0o700 });
  const seen = [];
  const fake = net.createServer((c) => {
    c.on('data', (b) => {
      const f = JSON.parse(String(b).trim());
      seen.push(f.t);
      if (f.t === 'ping') c.end(`${JSON.stringify({ t: 'pong', pid: 1, listen: '127.0.0.1:0', build: 'stale', address: 'x' })}\n`);
      if (f.t === 'stop') { c.end(`${JSON.stringify({ t: 'stopping' })}\n`); fake.close(); }
    });
  });
  await new Promise(r => fake.listen(sockIn(store), r));
  const r = await ensureBroker();
  track(r.pid);
  assert.ok(seen.includes('stop'), `the stale broker was told to stop: ${seen}`);
  assert.equal(r.running, true, r.error);
  assert.notEqual((await ping(store)).build, 'stale');
});

test('a stale socket file is reclaimed', async (t) => {
  const store = await pinTestEnv(t, ENV);
  const track = cleanup(t);
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
  const track = cleanup(t);
  await writeRecord(store.dir, agentRecord('a', newSecret()));
  const r = await ensureBroker();
  track(r.pid);
  await removeRecord(store.dir, 'a');
  await waitFor(() => gone(r.pid), { what: 'the broker to exit' });
  assert.equal(existsSync(sockIn(store)), false, 'and it removed its socket');
});

test('GET /agent/broker reports a running listener, its dial default and unknown-remote refusals', async (t) => {
  const { call, store } = await withApi(t, {}, ENV);
  const track = cleanup(t);
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
