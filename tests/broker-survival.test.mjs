// WHY THE BROKER IS ITS OWN PROCESS: agent sessions survive the plugin backend
// being killed the way cc kills it (SIGKILL to its whole PROCESS GROUP), a
// restarted backend ADOPTS the running broker instead of starting a second,
// and a launcher dying mid-command moves nothing either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { Launcher, REPO, writeRecord } from './helpers.mjs';
import {
  NEEDS_PYTHON, agentEnv, agentRecord, agentStore, connected, newSecret, startAgent, status, waitFor,
} from './agentFixture.mjs';
import { queryBroker } from '../src/agent/client.mjs';

const skip = NEEDS_PYTHON;

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}

// The backend, as cc runs it: its own process group.
async function startBackend(t, store) {
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, [path.join(REPO, 'server.mjs')], {
    env: { ...agentEnv(store), PORT: String(port), CODE_SYSTEM_AGENT_LISTEN: '127.0.0.1:0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', b => { log += b; });
  child.stderr.on('data', b => { log += b; });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const base = `http://127.0.0.1:${port}/api`;
  const body = await waitFor(async () => {
    const r = await fetch(`${base}/agent/broker`).then(x => x.json()).catch(() => null);
    return r?.running ? r : null;
  }, { what: `the backend's broker to run (log: ${log})` });
  return { child, base, broker: body, log: () => log };
}

test('a backend killed by process group leaves the broker and its sessions; a restart adopts it', { skip }, async (t) => {
  const store = await agentStore(t);
  const secret = newSecret();
  await writeRecord(store, agentRecord('sv', secret));
  const first = await startBackend(t, store);
  const sock = path.join(store, 'agent', 'broker.sock');
  t.after(async () => { await queryBroker(sock, { t: 'stop' }).catch(() => {}); });
  startAgent(t, { address: first.broker.address, remoteId: 'sv', secret });
  const before = await connected(sock, 'sv');

  // EXACTLY what cc's supervisor does to a plugin backend.
  process.kill(-first.child.pid, 'SIGKILL');
  await new Promise(r => first.child.once('exit', r));
  const pong = await queryBroker(sock, { t: 'ping' });
  assert.equal(pong.pid, first.broker.pid, 'the broker survived its starter');
  assert.equal((await status(sock, 'sv')).session, before.session, 'and so did the agent session');

  const second = await startBackend(t, store);
  assert.equal(second.broker.pid, first.broker.pid, 'the restarted backend adopted the running broker');
  assert.doesNotMatch(second.log(), /agent listener started/, 'and spawned none');

  // A fresh launcher runs over the same session.
  const l = new Launcher(['--kind', 'agent'], { ...agentEnv(store), CODE_SYSTEM_CHANNEL: '0' });
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'exec', id: 'x', remoteId: 'sv', cwd: '/', stdin: 'ignore', argv: ['/bin/echo', 'still here'] });
  const end = await l.waitFor(f => f.id === 'x' && (f.type === 'exit' || f.type === 'error'));
  assert.equal(end.code, 0);
  assert.equal((await status(sock, 'sv')).session, before.session);
});

test('a launcher killed mid-command does not move the session', { skip }, async (t) => {
  const store = await agentStore(t);
  const secret = newSecret();
  await writeRecord(store, agentRecord('lk', secret));
  const backend = await startBackend(t, store);
  const sock = path.join(store, 'agent', 'broker.sock');
  t.after(async () => { await queryBroker(sock, { t: 'stop' }).catch(() => {}); });
  startAgent(t, { address: backend.broker.address, remoteId: 'lk', secret });
  const before = await connected(sock, 'lk');
  const l = new Launcher(['--kind', 'agent'], { ...agentEnv(store), CODE_SYSTEM_CHANNEL: '0' });
  await l.hello();
  l.send({ type: 'exec', id: 'x', remoteId: 'lk', cwd: '/', stdin: 'ignore', argv: ['/bin/sh', '-c', 'echo go; sleep 30'] });
  await l.waitFor(f => f.id === 'x' && f.type === 'stdout');
  l.kill('SIGKILL');
  await l.exited;
  await new Promise(r => setTimeout(r, 500));
  const after = await status(sock, 'lk');
  assert.equal(after.connected, true);
  assert.equal(after.session, before.session);
});
