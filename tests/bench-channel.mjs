#!/usr/bin/env node
// WHAT THE HELD-OPEN CHANNEL IS WORTH, re-derived on the reader's own host
// rather than quoted from someone's terminal.
//
//   node tests/bench-channel.mjs            # skips loudly with no daemon
//   CODE_SYSTEM_DOCKER='["sudo","-n","docker"]' node tests/bench-channel.mjs
//
// It drives the SHIPPED launcher — the same argv a cc System row carries —
// against a fixture container, replaying the frames cc's own `#derive` sends,
// once with `CODE_SYSTEM_CHANNEL=1` and once with `=0`. Nothing here is a
// micro-benchmark of the framing: every number is a full frame round trip
// through main.mjs, the store lookup, the session and the transport.
//
// NEVER PART OF `npm test`: it needs a daemon, and a timing number is not a
// pass/fail claim. The pass/fail claims live in tests/docker-live.test.mjs.
//
// THE FIXTURE CREATES AND DESTROYS A CONTAINER; THE PROVIDER NEVER DOES.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHANNEL_ENV } from '../src/launcher/channel.mjs';
import { SCHEMA } from '../src/store.mjs';
import { Launcher } from './helpers.mjs';
import { SKIP_REASON, resolveDockerCli, withContainer } from './dockerFixture.mjs';

const SCRIPT = 'bench-channel';
const REMOTE = 'bench';
// Enough samples that the median is not one scheduling accident, few enough
// that the slow arm (≈85 ms/op) stays under a minute.
const REPS = 15;
// Frames run once per arm before the clock starts: they pay the channel's lazy
// open, and on the off arm they cost the same as any other op.
const WARMUP = 6;

const cleanups = [];
const lifecycle = { after: (fn) => cleanups.push(fn) };

const E = ['env', 'LC_ALL=C'];
const FIND_FIELDS = '%y\\t%m\\t%s\\t%T@\\t%l';

// EXACTLY the argv cc's `#derive` catalogue sends, so what is measured is what
// a worker actually pays. Each entry answers about `/usr/lib` — a real
// directory in the fixture image, with enough entries that `readDir` is not
// trivially empty.
const OPS = [
  { name: 'stat', frame: (id) => derive(id, [...E, 'stat', '-L', '-c', '%f %s %.3Y', '--', '/usr/lib']) },
  { name: 'lstat', frame: (id) => derive(id, [...E, 'find', '/usr/lib', '-maxdepth', '0', '-printf', `${FIND_FIELDS}\\n`]) },
  { name: 'readDir', frame: (id) => derive(id, [...E, 'find', '/usr/lib/.', '-mindepth', '1', '-maxdepth', '1', '-printf', `${FIND_FIELDS}\\t%f\\n`]) },
  { name: 'realpath', frame: (id) => derive(id, [...E, 'realpath', '-e', '--', '/usr/lib']) },
  { name: 'liveness', frame: (id) => derive(id, ['true']) },
  { name: 'readFile', frame: (id) => ({ type: 'readFile', id, remoteId: REMOTE, path: '/etc/hostname' }), settle: 'end' },
];

const derive = (id, argv) => ({ type: 'exec', id, remoteId: REMOTE, cwd: '/', stdin: 'ignore', argv });

function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, min: s[0], median: at(0.5), p90: at(0.9) };
}

const fmt = (v) => `${v.toFixed(1)} ms`;

/** One arm: a fresh launcher with the channel on or off, timed op by op. */
async function runArm(cli, storeDir, on) {
  const l = new Launcher(['--kind', 'docker'], {
    CODE_SYSTEM_STORE: storeDir,
    CODE_SYSTEM_DOCKER: JSON.stringify(cli),
    [CHANNEL_ENV]: on ? '1' : '0',
  });
  cleanups.push(() => l.kill());
  await l.hello();

  const settleOn = (op, id) => (op.settle === 'end'
    ? (f) => (f.type === 'end' || f.type === 'error') && f.id === id
    : (f) => (f.type === 'exit' || f.type === 'error') && f.id === id);

  const results = new Map();
  let seq = 0;
  for (const op of OPS) {
    for (let i = 0; i < WARMUP; i++) {
      const id = `w${seq++}`;
      l.send(op.frame(id));
      await l.waitFor(settleOn(op, id));
    }
    const samples = [];
    for (let i = 0; i < REPS; i++) {
      const id = `m${seq++}`;
      const started = process.hrtime.bigint();
      l.send(op.frame(id));
      const f = await l.waitFor(settleOn(op, id));
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      if (f.type === 'error') throw new Error(`${op.name} failed: ${JSON.stringify(f)}`);
    }
    results.set(op.name, stats(samples));
  }
  l.closeStdin();
  await l.exited;
  return { results, stderr: l.stderr };
}

async function main() {
  const found = await resolveDockerCli();
  if (!found) { console.log(`${SCRIPT}: SKIPPED — ${SKIP_REASON}`); return 0; }
  const { cli, serverVersion } = found;
  console.log(`${SCRIPT}: docker ${JSON.stringify(cli)} → server ${serverVersion}`);

  const container = await withContainer(lifecycle, cli, { stem: 'bench' });
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-bench-'));
  cleanups.push(() => fs.rm(storeDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(storeDir, 'remotes'), { recursive: true });
  await fs.writeFile(path.join(storeDir, 'remotes', `${REMOTE}.json`), `${JSON.stringify({
    schema: SCHEMA,
    remoteId: REMOTE,
    kind: 'docker',
    label: REMOTE,
    config: { container },
    enabled: true,
    mirror: null,
    baseline: { state: 'ok', fingerprint: null, missing: [], checkedAt: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  console.log(`${SCRIPT}: container ${container}, store ${storeDir}`);
  console.log(`${SCRIPT}: ${REPS} samples per op after ${WARMUP} warm-up frames, per arm\n`);

  // OFF FIRST, so the "before" number is taken on a cold daemon rather than one
  // the other arm has already warmed.
  const off = await runArm(cli, storeDir, false);
  const on = await runArm(cli, storeDir, true);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('op', 12)}${pad('per-op spawn (off)', 40)}${pad('held-open channel (on)', 40)}speed-up`);
  for (const { name } of OPS) {
    const a = off.results.get(name);
    const b = on.results.get(name);
    const cell = (s) => `${fmt(s.median)} med (min ${fmt(s.min)}, p90 ${fmt(s.p90)})`;
    console.log(`${pad(name, 12)}${pad(cell(a), 40)}${pad(cell(b), 40)}${(a.median / b.median).toFixed(1)}x`);
  }
  const census = /channel carried .*/.exec(on.stderr);
  console.log(`\n${SCRIPT}: on arm — ${census ? census[0] : 'NO CENSUS LINE: the channel never ran'}`);
  const offCensus = /channel carried .*/.test(off.stderr);
  console.log(`${SCRIPT}: off arm — ${offCensus ? 'A CENSUS LINE: the kill switch did not work' : 'no pool at all, as expected'}`);
  return 0;
}

let code = 1;
try { code = await main(); }
catch (e) { console.error(`\n${SCRIPT}: ABORTED — ${e?.stack ?? e}`); }
finally {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch (e) { console.error(`${SCRIPT}: cleanup failed: ${e?.message ?? e}`); }
  }
}
process.exitCode = code;
