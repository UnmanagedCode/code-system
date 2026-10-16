// Pins the shipped entry point's bind: `node server.mjs` listens on 127.0.0.1
// only. The API has no authentication, so any other interface would let the
// network drive it. Spawns the real server over a temp store, with no conductor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { REPO, tempStore } from './helpers.mjs';

async function freePort() {
  const probe = net.createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise(r => probe.close(r));
  return port;
}

const connectError = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.setTimeout(2000, () => { s.destroy(); resolve('ETIMEDOUT'); });
  s.once('connect', () => { s.destroy(); resolve('connected'); });
  s.once('error', e => resolve(e.code));
});

// Invariant: the backend answers on loopback, and refuses every other IPv4
// address this machine has.
test('node server.mjs listens on 127.0.0.1 only', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), CODE_SYSTEM_STORE: store.dir };
  delete env.CONDUCTOR_URL;
  delete env.PROJECTS_ROOT;
  const child = spawn(process.execPath, [path.join(REPO, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise(r => child.once('exit', r));
  t.after(async () => { child.kill('SIGTERM'); await exited; });

  const deadline = Date.now() + 5000;
  let health = null;
  while (Date.now() < deadline && health === null) {
    try { health = await fetch(`http://127.0.0.1:${port}/api/health`); }
    catch { await new Promise(r => setTimeout(r, 50)); }
  }
  assert.ok(health, `the server never answered on 127.0.0.1:${port}; output: ${out}`);
  assert.equal(health.status, 200);
  assert.match(out, new RegExp(`on 127\\.0\\.0\\.1:${port} `), 'its log names the loopback bind');

  const others = Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
  if (others.length === 0) { t.skip('this machine has no non-internal IPv4 address to try'); return; }
  for (const address of others) {
    assert.equal(await connectError(address, port), 'ECONNREFUSED', `${address}:${port} must refuse`);
  }
});
