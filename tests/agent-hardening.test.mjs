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
  BRIDGE, BROKER, FAST, NEEDS_PYTHON, PY, agentEnv, agentRecord, agentStore, connected, controlClient, fakeAgent,
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
// is told why, and no more than one window ever reaches the bridge.
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
  assert.ok((await status(w.broker.sock, w.remoteId)).connected === false, 'the session is gone');
});

// C7. PINS the AGENT's output credit: a reader that never acknowledges gets
// exactly one window of a larger output, and then nothing more (aligned reads).
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

// Item 7 (round 3). PINS the credit REMAINDER: a producer whose writes do not
// align with the window (1000 bytes at a time, paced) is read only up to the
// credit left — never a whole chunk past it — so the broker sees no overrun:
// no `lost`, the session stays up, and exactly one window arrives.
test('a non-aligned producer is read only up to the credit left', { skip }, async (t) => {
  const w = await world(t);
  startAgent(t, { address: w.broker.address, remoteId: w.remoteId, secret: w.secret });
  const before = await connected(w.broker.sock, w.remoteId);
  const producer = 'import sys,time\nfor i in range(1000):\n sys.stdout.buffer.write(b"x"*1000);sys.stdout.flush();time.sleep(0.002)';
  assert.notEqual(PROTOCOL.windowBytes % 1000, 0, 'the writes really are not aligned with the window');
  const ctl = await controlClient(t, w.broker.sock, openFrame(w.remoteId, w.secret, [PY.python, '-c', producer]));
  await waitFor(() => decoded(ctl.frames) >= PROTOCOL.windowBytes || ctl.frames.some(f => f.t === 'lost'),
    { what: 'one window', timeoutMs: 15000 });
  await new Promise(r => setTimeout(r, 500));
  assert.equal(ctl.frames.some(f => f.t === 'lost'), false, JSON.stringify(ctl.frames.find(f => f.t === 'lost')));
  assert.equal(decoded(ctl.frames), PROTOCOL.windowBytes);
  const after = await status(w.broker.sock, w.remoteId);
  assert.equal(after.connected, true);
  assert.equal(after.session, before.session);
});

// Item 1a (round 3). PINS the agent socket's backpressure: an authenticated
// agent that returns input credit (acks) for input it never reads off its
// socket cannot make the broker queue that input — the sending bridge stops
// being read. Far less than the bridge offered leaves it, the stream is not
// ended for it, and the broker's memory does not grow with what was offered.
test('an agent that acks input it never reads pauses the sending bridge', async (t) => {
  const w = await world(t);
  const agent = await fakeAgent(t, { port: w.broker.port, remoteId: w.remoteId, secret: w.secret });
  await connected(w.broker.sock, w.remoteId);
  const ctl = await controlClient(t, w.broker.sock, openFrame(w.remoteId, w.secret, ['x'], { stdin: true }));
  const open = await agent.waitFor(f => f.t === 'open', { what: 'the open' });
  agent.send({ t: 'started', s: open.s, pid: 0 });
  await ctl.waitFor(f => f.t === 'started', { what: 'started' });
  agent.sock.pause();
  // Alive by its own pings (the broker's keepalive counts any frame), while it
  // reads nothing.
  const pinger = setInterval(() => agent.send({ t: 'ping' }), 100);
  t.after(() => clearInterval(pinger));
  const rss = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${w.broker.pid}/status`, 'utf8'))[1]);
  const rssBefore = rss();
  const frame = `${JSON.stringify({ t: 'in', b64: Buffer.alloc(PROTOCOL.chunkBytes, 0x63).toString('base64') })}\n`;
  const OFFERED = 640 * PROTOCOL.chunkBytes;
  let sent = 0;
  while (sent < OFFERED) {
    // The credit back for input the agent never read — sent AHEAD of each
    // frame, so the broker has read it before the frame and the stream stays
    // within its credit: what is under test is the agent SOCKET, not credit.
    agent.send({ t: 'ack', s: open.s, fd: 0, n: Number.MAX_SAFE_INTEGER });
    await new Promise(r => setTimeout(r, 2));
    const flushed = await Promise.race([
      new Promise(r => ctl.sock.write(frame, () => r(true))),
      new Promise(r => setTimeout(() => r(false), 2000)),
    ]);
    if (!flushed) break;
    sent += PROTOCOL.chunkBytes;
  }
  assert.equal(ctl.closed, false, 'the stream was paused, not ended (so not stopped by its credit)');
  assert.ok(sent < OFFERED, `the bridge was stopped: ${sent} of ${OFFERED} bytes left it`);
  assert.ok(sent >= PROTOCOL.windowBytes, `but not before a window had passed: ${sent}`);
  assert.ok(rss() - rssBefore < 32 * 1024, `broker RSS grew ${rss() - rssBefore} kB for ${sent} bytes offered`);
  assert.equal((await status(w.broker.sock, w.remoteId)).connected, true);

  // Round 4, item 3. PINS that the pause is LIFTED when the agent's socket
  // drains: once the agent reads again, a uniquely marked frame queued behind
  // the stall reaches it. Without the resume, input would deadlock for good.
  const mark = Buffer.from(`MARK-${newNonce()}`).toString('base64');
  ctl.send({ t: 'in', b64: mark });
  agent.send({ t: 'ack', s: open.s, fd: 0, n: Number.MAX_SAFE_INTEGER });
  agent.sock.resume();
  const got = await agent.waitFor(f => f.t === 'in' && f.b64 === mark, { what: 'the marked frame', timeoutMs: 8000 });
  assert.equal(got.s, open.s);
  assert.equal(agent.frames.filter(f => f.t === 'in' && f.b64 === mark).length, 1, 'exactly once');
});

// Item 1b (round 3). PINS the broker's INPUT credit check: a bridge that sends
// more than a window of input to a command that never reads it has its stream
// ended — and only its stream: the agent's session stays up.
test('a bridge overrunning its input credit loses its stream, not the session', { skip }, async (t) => {
  const w = await world(t);
  startAgent(t, { address: w.broker.address, remoteId: w.remoteId, secret: w.secret });
  const before = await connected(w.broker.sock, w.remoteId);
  const ctl = await controlClient(t, w.broker.sock, openFrame(w.remoteId, w.secret, ['sleep', '30'], { stdin: true }));
  await ctl.waitFor(f => f.t === 'started', { what: 'started' });
  const b64 = Buffer.alloc(PROTOCOL.chunkBytes, 0x64).toString('base64');
  for (let i = 0; i < 8; i++) ctl.send({ t: 'in', b64 });
  assert.equal(await ctl.waitClosed(5000), true, 'the stream was ended');
  const after = await status(w.broker.sock, w.remoteId);
  assert.equal(after.connected, true);
  assert.equal(after.session, before.session);
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
        // Answered, so the agent's keepalive never ends a session here: a
        // redial can only come from what the test sends.
        if (f.t === 'ping') st.send({ t: 'pong' });
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
  const sentAt = Date.now();
  first.send({ t: 'open', s: 2, argv: [], cwd: '/', env: {}, stdin: false });
  await waitFor(() => fb.conns.length >= 2, { what: 'the agent to redial after the bad frame' });
  assert.ok(Date.now() - sentAt < FAST.keepaliveTimeoutMs,
    'the redial is the bad frame\'s doing, well within the keepalive');
  assert.equal(first.frames.some(f => f.t === 'failed' && f.s === 2), false, 'an empty argv is refused as a frame, never started');
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
// Item 3 (rounds 3-4). PINS that the WORK matches on every handshake path —
// valid, wrong secret, unknown, another kind, an invalid id: exactly one
// SUCCESSFUL read (the record, or the record-sized handshake dummy), exactly one
// FAILING read (the twin that never exists, or the missing record), one parse
// and one HMAC. Counted through the broker's read/parse seams, over real files.
test('authenticate does one good read, one failing read, one parse and one HMAC on every path', async (t) => {
  const store = await pinTestEnv(t);
  const secret = newSecret();
  await writeRecord(store.dir, agentRecord('ag', secret));
  await writeRecord(store.dir, record('dk', { kind: 'docker', config: { container: 'c' } }));
  const { Broker, writeHandshakeDummy } = await import('../src/agent/broker.mjs');
  const { verifyMac } = await import('../src/agent/protocol.mjs');
  const { readRemoteText, parseRemote } = await import('../src/store.mjs');
  const { promises: fsp } = await import('node:fs');
  const agentDir = path.join(store.dir, 'agent');
  await fsp.mkdir(agentDir, { mode: 0o700 });
  await writeHandshakeDummy(agentDir);
  const count = { ok: 0, fail: 0, parse: 0 };
  const tally = r => { count[r.ok ? 'ok' : 'fail'] += 1; return r; };
  const real = new Broker({ listen: 'x', address: 'x', build: 'x', tim: FAST });
  const b = new Broker({
    listen: 'x', address: 'x', build: 'x', tim: FAST,
    readImpl: async id => tally(await readRemoteText(id)),
    readHandshakeImpl: async which => tally(await real.readHandshakeImpl(which)),
    parseImpl: (id, text) => { count.parse += 1; return parseRemote(id, text); },
  });
  const nb = newNonce();
  const na = newNonce();
  const good = mac(secret, [LABELS.agent, 'ag', nb, na]);
  for (const [remoteId, m, ok] of [['ag', good, true], ['ag', 'ab', false], ['nobody', good, false],
    ['dk', good, false], ['NOT VALID!', good, false]]) {
    let calls = 0;
    Object.assign(count, { ok: 0, fail: 0, parse: 0 });
    const verify = (...a) => { calls += 1; return verifyMac(...a); };
    const r = await b.authenticate({ remoteId, nb, na, mac: m }, verify);
    assert.equal(r.ok, ok, remoteId);
    assert.deepEqual({ ...count, hmac: calls }, { ok: 1, fail: 1, parse: 1, hmac: 1 }, remoteId);
  }
});

// Item 1 (round 4). PINS the wall-clock result: over interleaved samples, the
// median handshake check for an absent and for an invalid remote id is within
// a coarse band of the median for one that exists. The band is far wider than
// the measured spread (all within 3%) and far narrower than the gap it guards
// against (a missing file's failing open alone is ~0.5-0.8x a present one's
// successful read): interleaving makes system load hit every class alike.
test('authenticate takes about as long for an absent or invalid remote as for an existing one', async (t) => {
  const store = await pinTestEnv(t);
  await writeRecord(store.dir, agentRecord('ag', newSecret()));
  const { Broker, writeHandshakeDummy } = await import('../src/agent/broker.mjs');
  const { promises: fsp } = await import('node:fs');
  const agentDir = path.join(store.dir, 'agent');
  await fsp.mkdir(agentDir, { mode: 0o700 });
  await writeHandshakeDummy(agentDir);
  const b = new Broker({ listen: 'x', address: 'x', build: 'x', tim: FAST });
  const nb = newNonce();
  const na = newNonce();
  const classes = { existing: 'ag', absent: 'nobody', invalid: 'NOT VALID!' };
  const samples = { existing: [], absent: [], invalid: [] };
  for (let i = 0; i < 1500; i++) {
    for (const [k, remoteId] of Object.entries(classes)) {
      const at = process.hrtime.bigint();
      await b.authenticate({ remoteId, nb, na, mac: 'ab' });
      samples[k].push(Number(process.hrtime.bigint() - at));
    }
  }
  const median = v => v.sort((x, y) => x - y)[v.length >> 1];
  const base = median(samples.existing);
  for (const k of ['absent', 'invalid']) {
    const ratio = median(samples[k]) / base;
    assert.ok(ratio > 0.85 && ratio < 1.18, `${k}/existing median ratio ${ratio.toFixed(2)}`);
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
  // BOUNDED: a bridge that hangs is a failed assertion, not a hung suite.
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const done = new Promise(r => child.on('close', (code) => { clearTimeout(timer); r({ code, stderr }); }));
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

// Round 4, item 6. PINS the broker's end of no-Nagle: every agent session's
// socket has TCP_NODELAY set (frames are small and interactive).
test('an agent session disables Nagle on its socket', async () => {
  const { EventEmitter } = await import('node:events');
  const { AgentSession } = await import('../src/agent/session.mjs');
  const { LineDecoder } = await import('../src/agent/protocol.mjs');
  const calls = [];
  const sock = Object.assign(new EventEmitter(), {
    setKeepAlive: () => {}, setNoDelay: v => calls.push(v), write: () => true, end: () => {}, destroy: () => {},
    writableNeedDrain: false,
  });
  const s = new AgentSession({
    socket: sock, decoder: new LineDecoder(1), remoteId: 'r', sessionId: 'ab', keyId: 'cd', peer: 'p',
    tim: FAST, log: () => {}, onEnd: () => {},
  });
  s.end('shutdown', 'test over');
  assert.deepEqual(calls, [true]);
});
