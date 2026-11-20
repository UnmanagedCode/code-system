// THE BROKER'S PRE-AUTH SURFACE, driven by a protocol peer WRITTEN HERE, with
// no import from src/agent/: the labels, the MAC construction and the frame
// shapes are restated on purpose, so a change on both sides of src/ at once
// still fails. Plus the real agent against a fake broker that cannot prove the
// secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  AGENT_PY, FAST, NEEDS_PYTHON, agentStore, connected, newSecret, startAgent, startBroker, status, waitFor,
  writeAgentRecord,
} from './agentFixture.mjs';
import { queryBroker } from '../src/agent/client.mjs';
import { writeRecord, record } from './helpers.mjs';

const LABEL_AGENT = 'code-system-agent/1 agent';
const LABEL_BROKER = 'code-system-agent/1 broker';
const H = (secret, fields) => createHmac('sha256', Buffer.from(secret, 'utf8')).update(fields.join('\n')).digest('hex');
const nonce = () => randomBytes(32).toString('hex');

// A raw line-oriented TCP peer.
async function peer(port) {
  const sock = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  let buf = '';
  let all = '';
  const lines = [];
  const waiters = [];
  let closed = false;
  sock.on('data', (b) => {
    buf += b.toString('utf8');
    all += b.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    for (const w of waiters.splice(0)) w();
  });
  sock.on('close', () => { closed = true; for (const w of waiters.splice(0)) w(); });
  sock.on('error', () => {});
  return {
    sock,
    send: f => sock.write(`${JSON.stringify(f)}\n`),
    raw: s => sock.write(s),
    get closed() { return closed; },
    async next(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!lines.length) {
        if (closed) throw new Error('closed');
        if (Date.now() > deadline) throw new Error('no line');
        await new Promise(r => { waiters.push(r); setTimeout(r, 50); });
      }
      return JSON.parse(lines.shift());
    },
    async rest(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!closed && Date.now() < deadline) await new Promise(r => { waiters.push(r); setTimeout(r, 50); });
      return all;
    },
    async waitClosed(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!closed && Date.now() < deadline) await new Promise(r => { waiters.push(r); setTimeout(r, 50); });
      return closed;
    },
  };
}

async function handshake(port, remoteId, secret, { na = nonce() } = {}) {
  const p = await peer(port);
  p.send({ t: 'hello', v: 1, remoteId, nonce: na });
  const ch = await p.next();
  assert.equal(ch.t, 'challenge');
  const auth = { t: 'auth', mac: H(secret, [LABEL_AGENT, remoteId, ch.nonce, na]) };
  p.send(auth);
  return { p, nb: ch.nonce, na, auth, answer: await p.next() };
}

async function world(t) {
  const store = await agentStore(t);
  const secret = newSecret();
  await writeAgentRecord(store, 'box', secret);
  const broker = await startBroker(t, store);
  return { store, secret, broker };
}

// PINS: the right secret is welcomed, and the broker PROVES it knows the
// secret too (a MAC over a different label, bound to the session id).
test('a peer with the right secret is welcomed with a MAC only the secret could make', async (t) => {
  const { secret, broker } = await world(t);
  const { p, nb, na, answer } = await handshake(broker.port, 'box', secret);
  assert.equal(answer.t, 'welcome');
  assert.equal(answer.mac, H(secret, [LABEL_BROKER, 'box', nb, na, answer.session]));
  p.send({ t: 'info', host: 'peerhost', python: '3.x', pid: 42, agentVersion: '1' });
  const st = await waitFor(async () => { const s = await status(broker.sock, 'box'); return s.host ? s : null; });
  assert.equal(st.connected, true);
  assert.equal(st.session, answer.session);
  assert.equal(st.host, 'peerhost');
  assert.equal(JSON.stringify(st).includes(secret), false, 'a status answer never carries the secret');
  p.sock.destroy();
});

// PINS: a wrong secret and an unknown remote answer IDENTICALLY on the wire —
// no remote-id oracle — while the true reason is kept locally: `wrong-secret`
// on that remote (with the peer), `unknown-remote` in the page-level list.
test('wrong secret and unknown remote are the same refusal on the wire, different locally', async (t) => {
  const { store, broker } = await world(t);
  await writeRecord(store, record('dock', { kind: 'docker', config: { container: 'c' } }));
  const wrong = await handshake(broker.port, 'box', newSecret());
  const unknown = await handshake(broker.port, 'nobody-here', newSecret());
  const notAgent = await handshake(broker.port, 'dock', newSecret());
  for (const r of [wrong, unknown, notAgent]) {
    assert.equal(r.answer.t, 'refused');
    assert.equal(await r.p.waitClosed(), true, 'and the connection is closed');
  }
  assert.deepEqual(unknown.answer, wrong.answer, 'byte-identical refusal');
  assert.deepEqual(notAgent.answer, wrong.answer);
  assert.equal(wrong.answer.code, 'auth_failed');

  const st = await status(broker.sock, 'box');
  assert.equal(st.connected, false);
  assert.equal(st.lastRefusal.reason, 'wrong-secret');
  assert.match(st.lastRefusal.peer, /^127\.0\.0\.1:\d+$/);
  const { items } = await queryBroker(broker.sock, { t: 'refusals' });
  assert.deepEqual(items.map(i => [i.remoteId, i.reason]), [['nobody-here', 'unknown-remote'], ['dock', 'not-an-agent-remote']]);
});

// PINS: a captured `auth` is useless on a new connection — the broker's nonce
// is fresh per connection, even when the peer reuses its own.
test('a replayed auth is refused', async (t) => {
  const { secret, broker } = await world(t);
  const first = await handshake(broker.port, 'box', secret);
  assert.equal(first.answer.t, 'welcome');
  first.p.sock.destroy();

  const p = await peer(broker.port);
  p.send({ t: 'hello', v: 1, remoteId: 'box', nonce: first.na });
  const ch = await p.next();
  assert.notEqual(ch.nonce, first.nb, 'a fresh challenge');
  p.send(first.auth);
  const ans = await p.next();
  assert.equal(ans.t, 'refused');
  assert.equal(ans.code, 'auth_failed');
});

// PINS: the hello's version is checked first, and the refusal says how to fix it.
test('a different protocol version is refused with version_mismatch, naming the fetch', async (t) => {
  const { broker } = await world(t);
  const p = await peer(broker.port);
  p.send({ t: 'hello', v: 999, remoteId: 'box', nonce: nonce() });
  const ans = await p.next();
  assert.equal(ans.code, 'version_mismatch');
  assert.match(ans.message, /agent\.py/);
});

// PINS the pre-auth bounds: a malformed or over-long first line is
// `bad_frame`, an idle connection is dropped at the handshake deadline, and at
// most maxPendingHandshakes may be mid-handshake at once.
test('pre-auth: bad frames, the handshake deadline and the pending cap', async (t) => {
  const { broker } = await world(t);
  const junk = await peer(broker.port);
  junk.raw('{"t":"hello"}\n');
  assert.equal((await junk.next()).code, 'bad_frame');

  const long = await peer(broker.port);
  long.raw('x'.repeat(5000));
  assert.equal((await long.next()).code, 'bad_frame');

  const idle = await peer(broker.port);
  const started = Date.now();
  assert.equal((await idle.next(FAST.handshakeTimeoutMs + 2000)).code, 'timeout');
  assert.ok(Date.now() - started >= FAST.handshakeTimeoutMs - 50);

  const held = [];
  for (let i = 0; i < 32; i++) held.push(await peer(broker.port));
  const over = await peer(broker.port);
  assert.equal((await over.next()).code, 'busy');
  for (const h of held) h.sock.destroy();
});

async function httpGet(port, request) {
  const p = await peer(port);
  p.raw(request);
  return p.rest();
}

// PINS: the listener's port serves the agent itself (the copy command's
// curl), byte for byte the file in this checkout, and nothing else.
test('GET /agent.py serves the agent\'s exact bytes; any other path is 404, any other method 405', async (t) => {
  const { broker } = await world(t);
  const res = await httpGet(broker.port, 'GET /agent.py HTTP/1.1\r\nHost: x\r\nUser-Agent: curl\r\n\r\n');
  const split = res.indexOf('\r\n\r\n');
  assert.match(res.slice(0, split), /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(res.slice(0, split), /Content-Type: text\/x-python/);
  assert.equal(res.slice(split + 4), readFileSync(AGENT_PY, 'utf8'));
  assert.match(await httpGet(broker.port, 'GET /etc/passwd HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 404 /);
  assert.match(await httpGet(broker.port, 'POST /agent.py HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 405 /);
});

// PINS: the secret never crosses the wire, in either direction, for a whole
// real session — handshake, commands, output. Captured by an in-test proxy
// between the real agent and the real broker.
test('no byte on the wire, either direction, contains the secret', { skip: NEEDS_PYTHON }, async (t) => {
  const { secret, broker, store } = await world(t);
  const toBroker = [];
  const toAgent = [];
  const proxy = net.createServer((c) => {
    const up = net.createConnection({ host: '127.0.0.1', port: broker.port });
    c.on('data', b => { toBroker.push(b); up.write(b); });
    up.on('data', b => { toAgent.push(b); c.write(b); });
    c.on('error', () => {}); up.on('error', () => {});
    c.on('close', () => up.destroy()); up.on('close', () => c.destroy());
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const agent = startAgent(t, { address: `127.0.0.1:${proxy.address().port}`, remoteId: 'box', secret });
  await connected(broker.sock, 'box');

  const { execFile } = await import('node:child_process');
  const { keyIdOf } = await import('../src/agent/protocol.mjs');
  // ASYNC: the proxy runs in this process, and a blocked loop would starve it.
  const r = await new Promise(resolve => execFile(process.execPath, [path.join(path.dirname(AGENT_PY), '..', 'src', 'agent', 'bridge.mjs'),
    '--socket', broker.sock, '--remote', 'box', '--key', keyIdOf(secret), '--cwd', '/', '--',
    '/bin/sh', '-c', 'env; echo done'], { encoding: 'utf8', env: { ...process.env, CODE_SYSTEM_STORE: store } },
  (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /done/);
  assert.equal(r.stdout.includes('CODE_SYSTEM_AGENT_SECRET'), false, 'the agent removed the secret from what its commands inherit');
  const all = Buffer.concat([...toBroker, ...toAgent]);
  assert.ok(all.length > 0);
  assert.equal(all.includes(Buffer.from(secret)), false);
  // C11: nor is it ever logged, by either side of a whole real session.
  assert.match(broker.log(), /connected from/, 'the broker log was captured');
  assert.match(agent.stderr(), /connected to/, 'and the agent\'s');
  assert.equal(broker.log().includes(secret), false, 'the broker log never carries the secret');
  assert.equal(agent.stderr().includes(secret), false, 'nor does the agent\'s stderr');
});

// PINS: the agent authenticates the BROKER too. A listener that cannot produce
// the welcome MAC gets nothing run, even if it goes on to send `open`.
test('the real agent runs nothing for a broker that cannot prove the secret', { skip: NEEDS_PYTHON }, async (t) => {
  const store = await agentStore(t);
  const marker = path.join(store, 'ran');
  let sawInfo = false;
  let handshakes = 0;
  const fake = net.createServer((c) => {
    let buf = '';
    c.on('error', () => {});
    c.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const f = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (f.t === 'hello') c.write(`${JSON.stringify({ t: 'challenge', nonce: nonce() })}\n`);
        if (f.t === 'auth') {
          handshakes += 1;
          c.write(`${JSON.stringify({ t: 'welcome', session: 'ab'.repeat(16), mac: 'cd'.repeat(32) })}\n`);
          c.write(`${JSON.stringify({ t: 'open', s: 1, argv: ['/usr/bin/touch', marker], cwd: '/', env: {}, stdin: false })}\n`);
        }
        if (f.t === 'info') sawInfo = true;
      }
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  const agent = startAgent(t, { address: `127.0.0.1:${fake.address().port}`, remoteId: 'box', secret: newSecret() });
  await waitFor(() => handshakes >= 2 && /could not prove/.test(agent.stderr()), { what: 'the agent to refuse twice' });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(existsSync(marker), false, 'nothing ran');
  assert.equal(sawInfo, false, 'and the agent never entered a session');
  await fs.rm(marker, { force: true });
});
