// Pins the HTTP app (src/http.mjs) over a fixture dist: what it serves, what it
// refuses, and that every response — 200, 404, 503, 500, API JSON — carries the
// CSP and nosniff. No real build needed: tests/dist.test.mjs checks the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { NOT_BUILT } from '../src/http.mjs';
import { PINNED_CSP, withHttpApp } from './helpers.mjs';

async function fixtureDist(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-dist-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'assets'));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>fixture</title>');
  await fs.writeFile(path.join(dir, 'assets', 'index-x.js'), 'export {};');
  return dir;
}

function assertHeaders(res, what) {
  assert.equal(res.headers.get('content-security-policy'), PINNED_CSP, `${what}: CSP`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${what}: nosniff`);
}

// Invariant: a built UI is served at / and under assets/; every other path is
// a plain-text 404 (no SPA fallback, so the host URLs 404 standalone); the API
// and its JSON router tail still answer; each response carries the headers.
test('built: serves the UI, 404s the rest as text, and every response carries the CSP', async (t) => {
  const { base } = await withHttpApp(t, { distDir: await fixtureDist(t), log: () => {} });

  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type'), /^text\/html/);
  assert.match(await root.text(), /fixture/);
  assertHeaders(root, '/');

  const asset = await fetch(`${base}/assets/index-x.js`);
  assert.equal(asset.status, 200);
  assertHeaders(asset, 'asset');

  for (const p of ['/pluginBridge.js', '/pluginTheme.css', '/nope', '/assets', '/assets/missing.js', '/index.htm']) {
    const res = await fetch(`${base}${p}`, { redirect: 'manual' });
    assert.equal(res.status, 404, p);
    assert.match(res.headers.get('content-type'), /^text\/plain/, p);
    assert.equal(await res.text(), 'Not found', p);
    assertHeaders(res, p);
  }

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assertHeaders(health, '/api/health');

  const malformed = await fetch(`${base}/api/remotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get('content-type'), /^application\/json/, 'the API router tail answers JSON');
  assert.equal(typeof (await malformed.json()).error, 'string');
  assertHeaders(malformed, 'malformed POST');
});

// Invariant: an error escaping the API reaches the app's tail as a plain-text
// 500 that leaks no detail, with the headers, and is logged.
test('an error past the API is a plain-text 500 with the headers', async (t) => {
  const api = express.Router();
  api.get('/boom', () => { throw new Error('secret detail'); });
  const logged = [];
  const { base } = await withHttpApp(t, { api, distDir: await fixtureDist(t), log: m => logged.push(m) });
  const res = await fetch(`${base}/api/boom`);
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await res.text(), 'Internal error');
  assertHeaders(res, '500');
  assert.ok(logged.some(m => m.includes('secret detail')), 'the cause is logged, not sent');
});

// Invariant: unbuilt, the backend still starts and logs the missing entry file
// once; every UI path answers a readable non-HTML 503; the API stays up.
test('unbuilt: UI paths are a plain-text 503, the API still answers, and the gap is logged once', async (t) => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-nodist-'));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const logged = [];
  const { base } = await withHttpApp(t, { distDir: empty, log: m => logged.push(m) });

  for (const p of ['/', '/assets/index-x.js', '/pluginBridge.js']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 503, p);
    assert.match(res.headers.get('content-type'), /^text\/plain/, p);
    assert.equal(await res.text(), NOT_BUILT, p);
    assertHeaders(res, p);
  }
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assertHeaders(health, 'unbuilt /api/health');

  assert.equal(logged.length, 1);
  assert.match(logged[0], /^UI not built: .*index\.html is missing — run npm install$/);
  assert.ok(logged[0].includes(path.join(empty, 'index.html')), 'it names the missing file');
});
