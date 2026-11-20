// SEVERAL AGENTS, ONE LISTENER: each remote's commands land on its own agent,
// one agent dropping touches nothing of another's, and a second agent dialling
// with the same secret REPLACES the first (and the count says so).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Launcher, writeRecord } from './helpers.mjs';
import {
  NEEDS_PYTHON, agentEnv, agentRecord, agentStore, connected, newSecret, startAgent, startBroker, status, waitFor,
} from './agentFixture.mjs';

const skip = NEEDS_PYTHON;

async function twoAgents(t) {
  const store = await agentStore(t);
  const secrets = { one: newSecret(), two: newSecret() };
  for (const id of ['one', 'two']) await writeRecord(store, agentRecord(id, secrets[id]));
  const broker = await startBroker(t, store);
  const agents = {};
  for (const id of ['one', 'two']) agents[id] = startAgent(t, { address: broker.address, remoteId: id, secret: secrets[id] });
  for (const id of ['one', 'two']) await connected(broker.sock, id);
  const l = new Launcher(['--kind', 'agent'], { ...agentEnv(store), CODE_SYSTEM_CHANNEL: '0' });
  t.after(() => l.kill());
  await l.hello();
  return { store, secrets, broker, agents, l };
}

const textOf = (l, id) => l.frames.filter(f => f.type === 'stdout' && f.id === id)
  .map(f => Buffer.from(f.dataB64, 'base64').toString('utf8')).join('');
const settled = (l, id) => l.waitFor(f => f.id === id && (f.type === 'exit' || f.type === 'error'), { timeoutMs: 15_000 });

// PINS routing by remote: the far command's parent is THAT remote's agent.
test('concurrent execs on two remotes each land on their own agent', { skip }, async (t) => {
  const { agents, l } = await twoAgents(t);
  for (let i = 0; i < 4; i++) {
    for (const id of ['one', 'two']) {
      l.send({ type: 'exec', id: `${id}${i}`, remoteId: id, cwd: '/', stdin: 'ignore', argv: ['/bin/sh', '-c', 'echo $PPID'] });
    }
  }
  for (let i = 0; i < 4; i++) {
    for (const id of ['one', 'two']) {
      assert.equal((await settled(l, `${id}${i}`)).code, 0);
      assert.equal(Number(textOf(l, `${id}${i}`).trim()), agents[id].pid, `${id}${i} ran under agent '${id}'`);
    }
  }
});

// PINS isolation: one agent's session ending fails only ITS in-flight ops.
test('one agent dropping does not touch the other\'s streams', { skip }, async (t) => {
  const { agents, l } = await twoAgents(t);
  l.send({ type: 'exec', id: 'a', remoteId: 'one', cwd: '/', stdin: 'ignore', argv: ['/bin/sh', '-c', 'echo up; sleep 30'] });
  l.send({ type: 'exec', id: 'b', remoteId: 'two', cwd: '/', stdin: 'ignore', argv: ['/bin/sh', '-c', 'echo up; sleep 1; echo still'] });
  await waitFor(() => textOf(l, 'a') && textOf(l, 'b'), { what: 'both to start' });
  agents.one.child.kill('SIGTERM');
  const a = await settled(l, 'a');
  assert.equal(a.type, 'error');
  assert.equal(a.code, 'ETRANSPORT');
  const b = await settled(l, 'b');
  assert.deepEqual([b.type, b.code], ['exit', 0]);
  assert.equal(textOf(l, 'b'), 'up\nstill\n');
});

// PINS replacement: a half-open old connection never blocks a reconnect — the
// newer session wins and the older one's in-flight command is ended — and,
// because the replaced agent keeps dialling, two agents on one secret keep
// replacing each other: the count GROWS, which is what makes that visible.
test('a second agent with the same secret replaces the first; the count shows them fighting', { skip }, async (t) => {
  const { broker, secrets, l } = await twoAgents(t);
  l.send({ type: 'exec', id: 'old', remoteId: 'one', cwd: '/', stdin: 'ignore', argv: ['/bin/sh', '-c', 'echo up; sleep 30'] });
  await waitFor(() => textOf(l, 'old'), { what: 'the first command to start' });
  const second = startAgent(t, { address: broker.address, remoteId: 'one', secret: secrets.one });
  const won = await waitFor(async () => {
    const s = await status(broker.sock, 'one');
    return s.agentPid === second.pid ? s : null;
  }, { what: 'the second agent to hold the session' });
  assert.ok(won.replacements >= 1);
  const old = await settled(l, 'old');
  assert.deepEqual([old.type, old.code], ['error', 'ETRANSPORT'], 'the replaced session\'s command ended');
  await waitFor(async () => (await status(broker.sock, 'one')).replacements >= 3, { what: 'the count to keep growing' });
});
