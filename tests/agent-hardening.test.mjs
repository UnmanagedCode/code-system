// THE AGENT TRANSPORT AGAINST PEERS THAT MISBEHAVE: a fake agent that ignores
// its credit, a fake broker that sends what a broker never sends, raw control
// clients that never acknowledge — and the bounds and refusals each must meet.
// Each test pins one review finding; its comment names the invariant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, openSync, closeSync, constants as FS } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Launcher, pinTestEnv, writeRecord, record } from './helpers.mjs';
import {
  BRIDGE, BROKER, FAST, NEEDS_PYTHON, agentEnv, agentRecord, agentStore, connected, controlClient, fakeAgent,
  newSecret, startAgent, startBroker, status, waitFor,
} from './agentFixture.mjs';
import { LABELS, PROTOCOL, keyIdOf, mac, newNonce, newSessionId } from '../src/agent/protocol.mjs';

const skip = NEEDS_PYTHON;
const decoded = frames => frames.filter(f => f.t === 'out').reduce((n, f) => n + Buffer.from(f.b64, 'base64').length, 0);
const openFrame = (remoteId, secret, argv, over = {}) => ({
  t: 'open', remoteId, keyId: keyIdOf(secret), argv, cwd: '/', env: {}, stdin: false, ...over,
});

async function world(t, { remoteId = 'hd', timings = {} } = {}) {
  const store = await agentStore(t);
  const secret = newSecret();
  await writeRecord(store, agentRecord(remoteId, secret));
  const env = { CODE_SYSTEM_AGENT_TIMINGS: JSON.stringify({ ...FAST, ...timings }) };
  const broker = await startBroker(t, store, { env });
  return { store, secret, broker, remoteId, env };
}

// Point this process's store at `dir` for the test (the kind reads it).
function useStore(t, dir) {
  const prior = process.env.CODE_SYSTEM_STORE;
  process.env.CODE_SYSTEM_STORE = dir;
  t.after(() => { if (prior === undefined) delete process.env.CODE_SYSTEM_STORE; else process.env.CODE_SYSTEM_STORE = prior; });
}

// A1. PINS: the broker enforces output credit itself. An agent that sends far
// past its window has its session ended by name (`bye credit`), the bridge side
// is told why, no more than one window ever reaches the bridge, and the broker's
// memory stays bounded.
test('an agent that ignores its output credit loses its session by name; the broker relays at most a window', async (t) => {
  const w = await world(t);
  const agent = await fakeAgent(t, { port: w.broker.port, remoteId: w.remoteId, secret: w.secret });
  await connected(w.broker.sock, w.remoteId);
  const ctl = await controlClient(t, w.broker.sock, openFrame(w.remoteId, w.secret, ['x']));
  const open = await agent.waitFor(f => f.t === 'open', { what: 'the open' });
  agent.send({ t: 'started', s: open.s, pid: 0 });
  const chunk = Buffer.alloc(PROTOCOL.chunkBytes, 0x61).toString('base64');
  for (let i = 0; i < 64; i++) agent.send({ t: 'out', s: open.s, fd: 1, b64: chunk });
  const bye = await agent.waitFor(f => f.t === 'bye', { what: 'bye' });
  assert.equal(bye.code, 'credit');
  const lost = await ctl.waitFor(f => f.t === 'lost', { what: 'lost' });
  assert.match(lost.message, /credit/);
  assert.ok(decoded(ctl.frames) <= PROTOCOL.windowBytes, `relayed ${decoded(ctl.frames)} bytes`);
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${w.broker.pid}/status`, 'utf8'))[1]);
  assert.ok(rssKb < 200 * 1024, `broker RSS ${rssKb} kB`);
  assert.ok((await status(w.broker.sock, w.remoteId)).connected === false, 'the session is gone');
});

// C7. PINS the AGENT's output credit: a reader that never acknowledges gets
// exactly one window of a larger output, and then nothing more.
test('a stream that is never acknowledged receives exactly one window', { skip }, async (t) => {
  const w = await world(t);
  startAgent(t, { address: w.broker.address, remoteId: w.remoteId, secret: w.secret });
  await connected(w.broker.sock, w.remoteId);
  const ctl = await controlClient(t, w.broker.sock, openFrame(w.remoteId, w.secret, ['head', '-c', '2000000', '/dev/zero']));
  await waitFor(() => decoded(ctl.frames) >= PROTOCOL.windowBytes, { what: 'one window' });
  await new Promise(r => setTimeout(r, 600));
  assert.equal(decoded(ctl.frames), PROTOCOL.windowBytes);
  assert.equal(ctl.frames.some(f => f.t === 'exit'), false);
});

// A real-handshake fake BROKER on a TCP port, for what a broker never sends.
async function fakeBroker(t, { remoteId, secret }) {
  const conns = [];
  const server = net.createServer((c) => {
    let buf = '';
    let na = null;
    let nb = null;
    const st = { frames: [], send: f => c.write(`${JSON.stringify(f)}\n`), sock: c };
    c.on('error', () => {});
    c.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const f = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        st.frames.push(f);
        if (f.t === 'hello') { na = f.nonce; nb = newNonce(); st.send({ t: 'challenge', nonce: nb }); }
        if (f.t === 'auth') {
          const session = newSessionId();
          st.send({ t: 'welcome', session, mac: mac(secret, [LABELS.broker, remoteId, nb, na, session]) });
        }
        if (f.t === 'info') conns.push(st);
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const c of conns) c.sock.destroy(); server.close(); });
  return { port: server.address().port, conns };
}

// A3. PINS: starting one stream can only fail THAT stream. An `open` that makes
// Popen raise something other than OSError is a `failed` frame, the session
// carries on; an empty argv is refused by the shape check (the session ends
// and the agent redials) — the agent process survives both.
test('a bad open fails its stream or the session, never the agent', { skip }, async (t) => {
  const secret = newSecret();
  const fb = await fakeBroker(t, { remoteId: 'ba', secret });
  const agent = startAgent(t, { address: `127.0.0.1:${fb.port}`, remoteId: 'ba', secret });
  await waitFor(() => fb.conns.length >= 1, { what: 'a session' });
  const first = fb.conns[0];
  first.send({ t: 'open', s: 1, argv: ['a\u0000b'], cwd: '/', env: {}, stdin: false });
  const failed = await waitFor(() => first.frames.find(f => f.t === 'failed'), { what: 'failed' });
  assert.deepEqual([failed.s, failed.errno], [1, 'EINVAL']);
  first.send({ t: 'ping' });
  await waitFor(() => first.frames.find(f => f.t === 'pong'), { what: 'the session still answers' });
  first.send({ t: 'open', s: 2, argv: [], cwd: '/', env: {}, stdin: false });
  await waitFor(() => fb.conns.length >= 2, { what: 'the agent to redial after the bad frame' });
  assert.equal(agent.child.exitCode, null, 'the agent process is alive');
});

// A6. PINS: the direct child is reaped as soon as it exits, while a background
// job holding its output keeps the stream open (no `exit` yet) — and such
// streams count toward maxStreamsPerSession, the documented bound: past it an
// open is refused by name.
test('a background job holding output leaves no zombie, and such streams count toward the cap', { skip }, async (t) => {
  const w = await world(t);
  startAgent(t, { address: w.broker.address, remoteId: w.remoteId, secret: w.secret });
  await connected(w.broker.sock, w.remoteId);
  const holder = ['/bin/sh', '-c', 'sleep 60 & exit 0'];
  const first = await controlClient(t, w.broker.sock, openFrame(w.remoteId, w.secret, holder));
  const started = await first.waitFor(f => f.t === 'started', { what: 'started' });
  await waitFor(() => {
    try { return !/\) Z /.test(readFileSync(`/proc/${started.pid}/stat`, 'latin1')); } catch { return true; }
  }, { what: 'the exited shell to be reaped', timeoutMs: 3000 });
  assert.equal(first.frames.some(f => f.t === 'exit'), false, 'exit waits for the output to close');

  const clients = [first];
  for (let i = 1; i < PROTOCOL.maxStreamsPerSession; i++) {
    clients.push(await controlClient(t, w.broker.sock, openFrame(w.remoteId, w.secret, holder)));
  }
  await Promise.all(clients.map(c => c.waitFor(f => f.t === 'started', { what: 'started' })));
  const over = await controlClient(t, w.broker.sock, openFrame(w.remoteId, w.secret, ['true']));
  const refused = await over.waitFor(f => f.t === 'refused', { what: 'the refusal' });
  assert.equal(refused.tag, 'too-many-streams');
});

// A7. PINS: a record that cannot be read RIGHT NOW (here: garbage for several
// ticks) neither drops its agent's session nor stops the broker.
test('an unreadable agent record keeps its session and the broker', { skip }, async (t) => {
  const w = await world(t);
  startAgent(t, { address: w.broker.address, remoteId: w.remoteId, secret: w.secret });
  const before = await connected(w.broker.sock, w.remoteId);
  const file = path.join(w.store, 'remotes', `${w.remoteId}.json`);
  const good = await fs.readFile(file);
  await fs.writeFile(`${file}.tmp`, 'not json');
  await fs.rename(`${file}.tmp`, file);
  await new Promise(r => setTimeout(r, FAST.brokerTickMs * 8));
  const during = await status(w.broker.sock, w.remoteId);
  assert.equal(during.connected, true);
  assert.equal(during.session, before.session);
  await fs.writeFile(`${file}.tmp`, good);
  await fs.rename(`${file}.tmp`, file);
});

// A9. PINS: a broker that loses the port to a LIVE broker of the same store
// exits quietly, leaving no error file to contradict the running one.
test('a broker that loses the bind race to a live one leaves no error file', async (t) => {
  const w = await world(t);
  const loser = spawn(process.execPath, [BROKER, '--listen', `127.0.0.1:${w.broker.port}`, '--store', w.store], {
    env: agentEnv(w.store), stdio: 'ignore',
  });
  const code = await new Promise(r => loser.on('exit', r));
  assert.equal(code, 0);
  assert.equal(existsSync(path.join(w.store, 'agent', 'broker-error.json')), false);
  assert.equal((await status(w.broker.sock, w.remoteId)).remoteId, w.remoteId, 'the winner still answers');
});

// A10. PINS: every authentication failure costs the same work — one HMAC —
// whether the remote exists, is another kind, is not a valid id, or has a
// different secret. The success path costs the same one.
test('authenticate runs exactly one HMAC on every path', async (t) => {
  const store = await pinTestEnv(t);
  const secret = newSecret();
  await writeRecord(store.dir, agentRecord('ag', secret));
  await writeRecord(store.dir, record('dk', { kind: 'docker', config: { container: 'c' } }));
  const { Broker } = await import('../src/agent/broker.mjs');
  const { verifyMac } = await import('../src/agent/protocol.mjs');
  const b = new Broker({ listen: 'x', address: 'x', build: 'x', tim: FAST });
  const nb = newNonce();
  const na = newNonce();
  const good = mac(secret, [LABELS.agent, 'ag', nb, na]);
  for (const [remoteId, m, ok] of [['ag', good, true], ['ag', 'ab', false], ['nobody', good, false],
    ['dk', good, false], ['NOT VALID!', good, false]]) {
    let calls = 0;
    const verify = (...a) => { calls += 1; return verifyMac(...a); };
    const r = await b.authenticate({ remoteId, nb, na, mac: m }, verify);
    assert.equal(r.ok, ok, remoteId);
    assert.equal(calls, 1, `${remoteId}: one HMAC`);
  }
});

// A11. PINS: a remote id from an unauthenticated hello is escaped before it is
// kept or logged — a newline cannot forge a refusal entry or a log line.
test('a peer-chosen remote id cannot forge a log line or a refusal entry', async (t) => {
  const w = await world(t);
  const c = net.createConnection({ host: '127.0.0.1', port: w.broker.port });
  await new Promise(r => c.once('connect', r));
  c.on('error', () => {});
  c.write(`${JSON.stringify({ t: 'hello', v: 1, remoteId: 'evil\nFORGED-LINE broker: owned\u2028x', nonce: 'ab' })}\n`);
  await new Promise(r => c.once('data', r));
  c.write(`${JSON.stringify({ t: 'auth', mac: 'cd' })}\n`);
  await new Promise(r => c.once('close', r));
  const { queryBroker } = await import('../src/agent/client.mjs');
  const { items } = await waitFor(async () => {
    const r = await queryBroker(w.broker.sock, { t: 'refusals' });
    return r.items.length ? r : null;
  });
  assert.equal(/[\n\r\u2028]/.test(items[0].remoteId), false, JSON.stringify(items[0]));
  assert.equal(w.broker.log().split('\n').some(l => l.startsWith('FORGED-LINE')), false, w.broker.log());
  assert.match(w.broker.log(), /evil\\nFORGED-LINE/);
});

// A fake BROKER on a unix socket, for a real bridge to talk to.
async function fakeControl(t, onOpen) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-fakectl-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sock = path.join(dir, 'broker.sock');
  const server = net.createServer((c) => {
    c.on('error', () => {});
    let buf = '';
    const send = f => c.write(`${JSON.stringify(f)}\n`);
    const acks = [];
    c.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const f = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (f.t === 'open') onOpen({ send, end: () => c.end(), acks, c });
        if (f.t === 'ack') acks.push(f);
      }
    });
  });
  await new Promise(r => server.listen(sock, r));
  t.after(() => server.close());
  return sock;
}

function runBridge(sock, argv = ['true'], { stdio = ['ignore', 'pipe', 'pipe'] } = {}) {
  const child = spawn(process.execPath, [BRIDGE, '--socket', sock, '--remote', 'r', '--key', 'ab', '--cwd', '/', '--', ...argv],
    { stdio });
  let stderr = '';
  child.stderr?.on('data', (b) => { stderr += b; });
  const done = new Promise(r => child.on('close', code => r({ code, stderr })));
  return { child, done };
}

// A14. PINS: the bridge shape-checks the broker's frames as every other side
// does: a malformed one ends it as a lost link, by name, not a crash or a
// mis-relay.
test('the bridge refuses a malformed frame from the broker by name', async (t) => {
  const sock = await fakeControl(t, ({ send }) => {
    send({ t: 'started', pid: 0 });
    send({ t: 'out', fd: '1', b64: 'aGk=' });
  });
  const r = await runBridge(sock).done;
  assert.equal(r.code, 255);
  assert.match(r.stderr, /code-system-agent: lost .*bad frame/);
});

// C4. PINS: a reap is proved only by `CCREAP ok` — a far command that exits 0
// and prints nothing is NOT a proof, and `reap` says so.
test('reap requires CCREAP ok, not just exit 0', async (t) => {
  const store = await agentStore(t);
  useStore(t, store);
  await fs.mkdir(path.join(store, 'agent'), { mode: 0o700 });
  let say = '';
  const dir = path.join(store, 'agent');
  const server = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', () => {
      c.write(`${JSON.stringify({ t: 'started', pid: 0 })}\n`);
      if (say) c.write(`${JSON.stringify({ t: 'out', fd: 1, b64: Buffer.from(say).toString('base64') })}\n`);
      c.end(`${JSON.stringify({ t: 'exit', code: 0, signal: null })}\n`);
    });
  });
  await new Promise(r => server.listen(path.join(dir, 'broker.sock'), r));
  t.after(() => server.close());
  const { createAgentTransport } = await import('../src/launcher/kinds/agent.mjs');
  const k = createAgentTransport();
  const handle = { pid: null, token: 'tok', remoteId: 'r' };
  await assert.rejects(k.reap({ secret: 'A'.repeat(43) }, handle), /could not be proved/);
  say = 'CCREAP ok 0 3\n';
  await k.reap({ secret: 'A'.repeat(43) }, handle);
});

// C8. PINS: the bridge acknowledges output only once it is WRITTEN: with its
// stdout a pipe nobody reads, the acks stop at the pipe's capacity — an ack
// sent on receipt would credit at least one frame more.
test('the bridge acks only bytes written to its stdout', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-fifo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fifo = path.join(dir, 'out');
  execFileSync('mkfifo', [fifo]);
  const rd = openSync(fifo, FS.O_RDONLY | FS.O_NONBLOCK);
  const wr = openSync(fifo, 'w');
  t.after(() => { closeSync(rd); });
  const FRAME = 1024;
  const TOTAL = 1600 * FRAME;
  let acks = null;
  const sock = await fakeControl(t, (ctx) => {
    acks = ctx.acks;
    ctx.send({ t: 'started', pid: 0 });
    const b64 = Buffer.alloc(FRAME, 0x62).toString('base64');
    for (let i = 0; i < TOTAL / FRAME; i++) ctx.send({ t: 'out', fd: 1, b64 });
  });
  const { child } = runBridge(sock, ['x'], { stdio: ['ignore', wr, 'pipe'] });
  closeSync(wr);
  t.after(() => child.kill('SIGKILL'));
  const PIPE = 65536;
  await waitFor(() => acks && acks.reduce((n, a) => n + a.n, 0) > 0, { what: 'the first acks' }).catch(() => {});
  await new Promise(r => setTimeout(r, 800));
  const acked = (acks ?? []).reduce((n, a) => n + a.n, 0);
  assert.ok(acked <= PIPE, `acked ${acked} with a ${PIPE}-byte pipe unread`);
  assert.ok(acked < TOTAL);
});

// C5 + C6. PINS the KEY ID checks that hold BETWEEN broker ticks: right after a
// rotation (and long before the broker's tick drops the stale session), an exec
// is refused naming the previous secret, and `reachability` with the new secret
// reads not connected — while the old one still reads connected.
test('between ticks, a rotated secret is refused per open and not reachable', { skip }, async (t) => {
  const w = await world(t, { timings: { brokerTickMs: 60000 } });
  startAgent(t, { address: w.broker.address, remoteId: w.remoteId, secret: w.secret });
  await connected(w.broker.sock, w.remoteId);
  const fresh = newSecret();
  await writeRecord(w.store, agentRecord(w.remoteId, fresh));
  const l = new Launcher(['--kind', 'agent'], { ...agentEnv(w.store, w.env), CODE_SYSTEM_CHANNEL: '0' });
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'exec', id: 'x', remoteId: w.remoteId, cwd: '/', stdin: 'ignore', argv: ['true'] });
  const err = await l.waitFor(f => f.id === 'x' && (f.type === 'error' || f.type === 'exit'));
  assert.equal(err.code, 'ENOREMOTE');
  assert.match(err.message, /previous secret/);

  useStore(t, w.store);
  const { createAgentTransport } = await import('../src/launcher/kinds/agent.mjs');
  const k = createAgentTransport();
  const now = await k.reachability({ secret: fresh }, { remoteId: w.remoteId });
  assert.equal(now.connected, false);
  assert.match(now.detail, /previous secret/);
  assert.equal((await k.reachability({ secret: w.secret }, { remoteId: w.remoteId })).connected, true);
});
