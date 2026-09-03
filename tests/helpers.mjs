// Shared test fixtures. Nothing here touches docker, ssh or the network, and
// every store is a fresh mkdtemp so tests pass in any order.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NdjsonDecoder, encodeFrame } from '../src/launcher/protocol.mjs';

export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const LAUNCHER = path.join(REPO, 'src', 'launcher', 'main.mjs');
export const FAKE_TRANSPORT = path.join(REPO, 'tests', 'fakeTransport.mjs');

export async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-test-'));
  return { dir, async cleanup() { await fs.rm(dir, { recursive: true, force: true }); } };
}

// Drives the real launcher as a child over pipes, HOLDING STDIN OPEN — which is
// what cc does, and without which MUST 3 would fire before an async operation
// could answer.
export class Launcher {
  #child;
  #decoder = new NdjsonDecoder();
  #frames = [];
  #waiters = [];
  stderr = '';
  exited = null;

  constructor(args, env = {}) {
    this.#child = spawn(process.execPath, [LAUNCHER, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.on('data', (chunk) => {
      for (const f of this.#decoder.push(chunk)) {
        this.#frames.push(f);
        for (const w of this.#waiters.splice(0)) w();
      }
    });
    this.#child.stderr.on('data', (b) => { this.stderr += b.toString('utf8'); });
    this.exited = new Promise((resolve) => {
      this.#child.on('close', (code, signal) => {
        for (const w of this.#waiters.splice(0)) w();
        resolve({ code, signal });
      });
    });
  }

  get frames() { return this.#frames; }
  get pid() { return this.#child.pid; }

  send(frame) { this.#child.stdin.write(encodeFrame(frame)); }
  sendRaw(text) { this.#child.stdin.write(text); }
  closeStdin() { this.#child.stdin.end(); }
  kill(sig = 'SIGKILL') { try { this.#child.kill(sig); } catch { /* gone */ } }

  async hello() {
    this.send({ type: 'hello', protocol: 1, client: 'code-conductor' });
    return this.waitFor(f => f.type === 'hello');
  }

  // Waits for the first frame matching `pred`. Rejects if the child exits
  // first, so a hang surfaces as a named failure rather than a timeout.
  async waitFor(pred, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.#frames.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a frame; saw ${JSON.stringify(this.#frames)} stderr=${this.stderr}`);
      }
      const done = await Promise.race([
        new Promise(r => { this.#waiters.push(() => r('frame')); }),
        this.exited.then(() => 'exited'),
        new Promise(r => setTimeout(() => r('tick'), 50)),
      ]);
      if (done === 'exited' && !this.#frames.find(pred)) {
        throw new Error(`launcher exited before the expected frame; saw ${JSON.stringify(this.#frames)} stderr=${this.stderr}`);
      }
    }
  }
}

// A remote record on disk, at the current schema.
export async function writeRecord(storeDir, record) {
  const dir = path.join(storeDir, 'remotes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${record.remoteId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function record(remoteId, over = {}) {
  return {
    schema: 1,
    remoteId,
    kind: 'fake',
    label: remoteId,
    config: {},
    baseline: { state: 'unknown', fingerprint: null, missing: [], checkedAt: null },
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...over,
  };
}

// A scripted cc: an http server that records every request and answers from a
// per-path script. Asserted on the recorded log, never on timing.
export async function fakeConductor(handler) {
  const http = await import('node:http');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const entry = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
    requests.push(entry);
    const out = handler(entry, requests) ?? { status: 500, body: { error: 'unscripted' } };
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() { await new Promise(r => server.close(r)); },
  };
}
