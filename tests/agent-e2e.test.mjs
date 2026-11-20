// THE agent KIND END TO END: the real launcher (`--kind agent`), the real
// broker and the real Python agent, on loopback. What these pin is the System
// protocol's contract as cc sees it, carried over the dial-in transport — and
// the kill semantics (decisions 8 and 9 of the plan) that make it safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Launcher, writeRecord } from './helpers.mjs';
import {
  BRIDGE, NEEDS_PYTHON, agentEnv, agentRecord, agentStore, agentWorld, alive, connected, newSecret,
  startAgent, startBroker, status, waitFor,
} from './agentFixture.mjs';
import { keyIdOf } from '../src/agent/protocol.mjs';
import { MAX_FILE_BYTES, CHUNK_BYTES } from '../src/launcher/protocol.mjs';

const skip = NEEDS_PYTHON;
const E = ['env', 'LC_ALL=C'];

async function launcher(t, store, extra = {}) {
  const l = new Launcher(['--kind', 'agent'], { ...agentEnv(store), CODE_SYSTEM_CHANNEL: '0', ...extra });
  t.after(() => l.kill());
  await l.hello();
  return l;
}

const textOf = (l, id, type = 'stdout') => l.frames.filter(f => f.type === type && f.id === id)
  .map(f => Buffer.from(f.dataB64, 'base64').toString('utf8')).join('');
const settled = (l, id) => l.waitFor(f => f.id === id && (f.type === 'exit' || f.type === 'error'), { timeoutMs: 15_000 });
const exec = (l, id, remoteId, over) => l.send({ type: 'exec', id, remoteId, cwd: '/tmp', stdin: 'ignore', ...over });

// A far-side pid the command reports itself, as its first stdout line.
async function farPid(l, id) {
  const line = await waitFor(() => /^(\d+)\n/.exec(textOf(l, id))?.[1], { what: `${id} to print its pid` });
  return Number(line);
}

// The bridges the launcher spawned (its direct children running bridge.mjs).
function bridgesOf(pid) {
  return readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number).filter((p) => {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'latin1');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      return ppid === pid && readFileSync(`/proc/${p}/cmdline`, 'latin1').includes(BRIDGE);
    } catch { return false; }
  });
}

const killLater = (t, pid) => t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });

test('exec relays stdout, stderr and the exit code, with CC_REMOTE set', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  exec(l, 'e1', w.remoteId, { argv: ['/bin/sh', '-c', 'echo "out $CC_REMOTE"; echo err >&2; exit 3'] });
  const end = await settled(l, 'e1');
  assert.deepEqual([end.type, end.code, end.signal], ['exit', 3, null]);
  assert.equal(textOf(l, 'e1'), `out ${w.remoteId}\n`);
  assert.equal(textOf(l, 'e1', 'stderr'), 'err\n');
});

// PINS the environment rule across the boundary: `env` absent inherits the
// AGENT's environment (its HOME), an `env` object REPLACES it — and CC_REMOTE
// is overlaid either way.
test('a frame env replaces the agent\'s environment; no env inherits it', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  const show = ['/bin/sh', '-c', 'printf "%s|%s|%s" "${HOME:-none}" "${FOO:-none}" "$CC_REMOTE"'];
  exec(l, 'inherit', w.remoteId, { argv: show });
  exec(l, 'replace', w.remoteId, { argv: show, env: { FOO: 'bar', PATH: '/usr/bin:/bin' } });
  await settled(l, 'inherit');
  await settled(l, 'replace');
  assert.equal(textOf(l, 'inherit'), `${os.homedir()}|none|${w.remoteId}`);
  assert.equal(textOf(l, 'replace'), `none|bar|${w.remoteId}`);
});

test('a missing program is an id-addressed ENOENT error, not an exit', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  exec(l, 'nx', w.remoteId, { argv: ['/definitely/not/here'] });
  const err = await settled(l, 'nx');
  assert.equal(err.type, 'error');
  assert.equal(err.code, 'ENOENT');
  // cc reads a spawn error's diagnostics from the stream AND the message; they must agree.
  assert.equal(textOf(l, 'nx', 'stderr'), err.message);
  exec(l, 'nd', w.remoteId, { argv: ['true'], cwd: '/definitely/not/a/dir' });
  assert.equal((await settled(l, 'nd')).code, 'ENOENT');
});

// PINS that streams are multiplexed per stream id and never cross.
test('five concurrent execs interleave without mixing', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  const ids = ['c0', 'c1', 'c2', 'c3', 'c4'];
  for (const id of ids) {
    exec(l, id, w.remoteId, { argv: ['/bin/sh', '-c', `for i in $(seq 1 200); do echo ${id}-$i; done`] });
  }
  for (const id of ids) assert.equal((await settled(l, id)).code, 0);
  for (const id of ids) {
    const lines = textOf(l, id).trim().split('\n');
    assert.equal(lines.length, 200, id);
    assert.ok(lines.every((x, i) => x === `${id}-${i + 1}`), `${id} saw only its own lines, in order`);
  }
});

// PINS stdin through a bridge, EOF included, and its credit flow: more than
// one window must pass, which it can only if the agent acknowledges what it
// wrote.
test('stdin flows through a bridge to EOF, past one credit window', { skip }, async (t) => {
  const w = await agentWorld(t);
  const payload = randomBytes(3 * 262144 + 17);
  const r = await new Promise((resolve) => {
    const c = execFile(process.execPath, [BRIDGE, '--socket', w.broker.sock, '--remote', w.remoteId, '--key',
      keyIdOf(w.secret), '--cwd', '/', '--stdin', '--', 'sha256sum'], { env: agentEnv(w.store), encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    c.stdin.end(payload);
  });
  assert.equal(r.err, null, r.stderr);
  const { createHash } = await import('node:crypto');
  assert.equal(r.stdout.split(' ')[0], createHash('sha256').update(payload).digest('hex'));
});

// PINS the derived file operations over the agent, at the protocol's largest
// payload: both directions are bounded by credit end to end.
test('writeFile then readFile round-trips MAX_FILE_BYTES', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-e2e-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'big.bin');
  const payload = randomBytes(MAX_FILE_BYTES);
  l.send({ type: 'writeFile', id: 'w', remoteId: w.remoteId, path: target });
  for (let at = 0, seq = 0; at < payload.length; at += CHUNK_BYTES, seq++) {
    l.send({ type: 'data', id: 'w', seq, dataB64: payload.subarray(at, at + CHUNK_BYTES).toString('base64') });
  }
  l.send({ type: 'end', id: 'w' });
  const wr = await l.waitFor(f => f.id === 'w' && (f.type === 'writeFileResult' || f.type === 'error'), { timeoutMs: 60_000 });
  assert.equal(wr.type, 'writeFileResult', JSON.stringify(wr));
  assert.ok((await fs.readFile(target)).equals(payload));

  l.send({ type: 'readFile', id: 'r', remoteId: w.remoteId, path: target });
  await l.waitFor(f => f.id === 'r' && (f.type === 'end' || f.type === 'error'), { timeoutMs: 60_000 });
  const back = Buffer.concat(l.frames.filter(f => f.id === 'r' && f.type === 'data').map(f => Buffer.from(f.dataB64, 'base64')));
  assert.ok(back.equals(payload));
});

// PINS the tooling-baseline probe over the agent, through the backend's own
// card composition: reachable, and the target passes.
test('a card over a connected agent reads connected, and its baseline probes ok', { skip }, async (t) => {
  const w = await agentWorld(t);
  const prior = process.env.CODE_SYSTEM_STORE;
  process.env.CODE_SYSTEM_STORE = w.store;
  t.after(() => { if (prior === undefined) delete process.env.CODE_SYSTEM_STORE; else process.env.CODE_SYSTEM_STORE = prior; });
  const { cardFor } = await import('../src/cards.mjs');
  const { readRemote } = await import('../src/store.mjs');
  const card = await cardFor(await readRemote(w.remoteId));
  assert.equal(card.reachability.connected, true, card.reachability.detail);
  assert.equal(card.reachability.fingerprint, `agent:${w.remoteId}:${w.session}`);
  assert.equal(card.baseline.state, 'ok', JSON.stringify(card.baseline));
  assert.equal(JSON.stringify(card).includes(w.secret), false);
});

// THE NEGATIVE CONTROL for every reap test below: killing a bridge alone kills
// nothing on the far side (decision 8). Without it, "reaped" could be the
// bridge's death doing the work.
test('SIGKILL on a bridge alone leaves the far process running', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  exec(l, 'k', w.remoteId, { argv: ['/bin/sh', '-c', 'echo $$; exec sleep 30'] });
  const pid = await farPid(l, 'k');
  killLater(t, pid);
  const [bridge] = bridgesOf(l.pid);
  assert.ok(bridge, 'the launcher spawned a bridge');
  process.kill(bridge, 'SIGKILL');
  await settled(l, 'k');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(alive(pid), true, 'the far process outlived its bridge');
});

test('close reaps the far process', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  exec(l, 'c', w.remoteId, { argv: ['/bin/sh', '-c', 'echo $$; exec sleep 30'] });
  const pid = await farPid(l, 'c');
  killLater(t, pid);
  l.send({ type: 'close', id: 'c' });
  await waitFor(() => !alive(pid), { what: 'the far process to be reaped' });
});

test('timeoutMs ends the exec with 124 and reaps the far process', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  exec(l, 'to', w.remoteId, { argv: ['/bin/sh', '-c', 'echo $$; exec sleep 30'], timeoutMs: 700 });
  const pid = await farPid(l, 'to');
  killLater(t, pid);
  const end = await settled(l, 'to');
  assert.deepEqual([end.type, end.code, end.timedOut], ['exit', 124, true]);
  await waitFor(() => !alive(pid), { what: 'the timed-out process to be reaped' });
});

// PINS `detach`'s promise across a launcher shutdown: the command, and the
// session it runs in, are left alone.
test('detach leaves the command running, even through launcher shutdown', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  exec(l, 'd', w.remoteId, { argv: ['/bin/sh', '-c', 'echo $$; exec sleep 30'] });
  const pid = await farPid(l, 'd');
  killLater(t, pid);
  l.send({ type: 'detach', id: 'd' });
  l.closeStdin();
  await l.exited;
  await new Promise(r => setTimeout(r, 300));
  assert.equal(alive(pid), true);
  assert.equal((await status(w.broker.sock, w.remoteId)).session, w.session, 'and the session did not move');
});

test('shutdown reaps open execs inside the reap deadline', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  const pids = [];
  for (const id of ['s1', 's2']) {
    exec(l, id, w.remoteId, { argv: ['/bin/sh', '-c', 'echo $$; exec sleep 30'] });
    pids.push(await farPid(l, id));
  }
  for (const p of pids) killLater(t, p);
  const started = Date.now();
  l.closeStdin();
  await l.exited;
  assert.ok(Date.now() - started < 1500 + 500, `the launcher exited in ${Date.now() - started} ms`);
  for (const p of pids) assert.equal(alive(p), false, `far pid ${p} was reaped before the launcher exited`);
});

// PINS decision 9: the agent's session dropping fails the in-flight op as
// ETRANSPORT, id-addressed, AND the agent ends the command's process group.
test('a cut agent link fails the in-flight exec ETRANSPORT and kills its far group', { skip }, async (t) => {
  const store = await agentStore(t);
  const secret = newSecret();
  await writeRecord(store, agentRecord('px', secret));
  const broker = await startBroker(t, store);
  const conns = new Set();
  const proxy = net.createServer((c) => {
    const up = net.createConnection({ host: '127.0.0.1', port: broker.port });
    conns.add(c); conns.add(up);
    c.pipe(up); up.pipe(c);
    c.on('error', () => {}); up.on('error', () => {});
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  startAgent(t, { address: `127.0.0.1:${proxy.address().port}`, remoteId: 'px', secret });
  await connected(broker.sock, 'px');
  const l = await launcher(t, store);
  exec(l, 'cut', 'px', { argv: ['/bin/sh', '-c', 'echo $$; sleep 30 & sleep 30; wait'] });
  const pid = await farPid(l, 'cut');
  killLater(t, pid);
  for (const c of conns) c.destroy();
  const err = await settled(l, 'cut');
  assert.equal(err.type, 'error');
  assert.equal(err.id, 'cut');
  assert.equal(err.code, 'ETRANSPORT');
  assert.match(err.message, /disconnected/);
  await waitFor(() => !alive(pid), { what: 'the agent to kill the dropped session\'s group' });
});

test('no agent connected is ENOREMOTE naming the remote', { skip }, async (t) => {
  const store = await agentStore(t);
  await writeRecord(store, agentRecord('lonely', newSecret()));
  await startBroker(t, store);
  const l = await launcher(t, store);
  exec(l, 'n', 'lonely', { argv: ['true'] });
  const err = await settled(l, 'n');
  assert.equal(err.code, 'ENOREMOTE');
  assert.match(err.message, /'lonely'/);
});

test('no broker is ENOREMOTE saying the listener is not running', { skip }, async (t) => {
  const store = await agentStore(t);
  await writeRecord(store, agentRecord('nobroker', newSecret()));
  const l = await launcher(t, store);
  exec(l, 'n', 'nobroker', { argv: ['true'] });
  const err = await settled(l, 'n');
  assert.equal(err.code, 'ENOREMOTE');
  assert.match(err.message, /listener is not running/);
});

// PINS that the GATE is enforced before any bridge exists: a gate-off remote's
// command never reaches the agent at all.
test('gate off refuses before any bridge spawns', { skip }, async (t) => {
  const w = await agentWorld(t, { enabled: false });
  const l = await launcher(t, w.store);
  const marker = path.join(w.store, 'should-not-exist');
  exec(l, 'g', w.remoteId, { argv: ['/usr/bin/touch', marker] });
  const err = await settled(l, 'g');
  assert.equal(err.type, 'error');
  assert.equal(bridgesOf(l.pid).length, 0);
  await assert.rejects(fs.stat(marker));
});

// PINS rotation: the broker drops a session whose secret changed, and an op
// against the remote is refused by name until an agent with the new secret
// dials — the old one is refused as wrong-secret.
test('a rotated secret drops the stale session and ops are ENOREMOTE', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store);
  await writeRecord(w.store, agentRecord(w.remoteId, newSecret()));
  await waitFor(async () => !(await status(w.broker.sock, w.remoteId)).connected, { what: 'the stale session to drop' });
  exec(l, 'r', w.remoteId, { argv: ['true'] });
  const err = await settled(l, 'r');
  assert.equal(err.code, 'ENOREMOTE');
  const st = await waitFor(async () => { const s = await status(w.broker.sock, w.remoteId); return s.lastRefusal ? s : null; });
  assert.equal(st.lastRefusal.reason, 'wrong-secret', 'the agent still on the old secret is refused');
});

// PINS the channel arm: cc's derivations ride the held-open far shell.
test('with the channel on, derivations ride it (census > 0)', { skip }, async (t) => {
  const w = await agentWorld(t);
  const l = await launcher(t, w.store, { CODE_SYSTEM_CHANNEL: '1' });
  for (let i = 0; i < 12; i++) {
    l.send({ type: 'exec', id: `d${i}`, remoteId: w.remoteId, cwd: '/', stdin: 'ignore', argv: [...E, 'realpath', '-e', '--', '/tmp'] });
    const end = await settled(l, `d${i}`);
    assert.equal(end.code, 0);
    assert.equal(textOf(l, `d${i}`), `${await fs.realpath('/tmp')}\n`);
  }
  l.closeStdin();
  await l.exited;
  const m = /channel carried (\d+) of (\d+) admitted ops/.exec(l.stderr);
  assert.ok(m, l.stderr);
  assert.ok(Number(m[1]) > 0, m[0]);
});

