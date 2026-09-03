// PINS the tooling-baseline probe: that busybox's three failures are each
// named with the probe that caught them, that the `stat` precision case is
// caught from OUTPUT SHAPE while the command exits 0, that the fingerprint
// cache re-probes exactly when the target changed and not otherwise, and that
// the launcher refuses an `unsupported` remote while still serving an
// `unknown` one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PROBE_SCRIPT, needsProbe, parseProbeOutput, refreshBaseline, unknownBaseline,
} from '../src/baseline.mjs';
import { makeRunner } from '../src/launcher/run.mjs';
import { createHostTransport } from '../src/launcher/kinds/host.mjs';
import { FAKE_TRANSPORT, Launcher, record, tempStore, writeRecord } from './helpers.mjs';

// What a GNU coreutils target answers.
const GNU_OUT = [
  'OK\treadDir', 'OK\trealpath', 'OK\tstat', 'OK\tbase64', 'OK\tshell', '',
].join('\n');

// What BusyBox v1.38.0 answers, with the error text quoted verbatim from
// code-conductor's systems-protocol.md §11, item 3.
const BUSYBOX_OUT = [
  'FAIL\treadDir\tfind -printf\tfind: unrecognized: -printf',
  'FAIL\trealpath\trealpath -e --\trealpath: -e: No such file or directory',
  "FAIL\tstat\tstat -L -c %.3Y\tmtime has no sub-second precision: 81a4 2 1788194735",
  'OK\tbase64',
  'OK\tshell',
  '',
].join('\n');

test('a GNU target answers ok; a busybox target is unsupported and names every missing capability', () => {
  assert.deepEqual(parseProbeOutput({ stdout: GNU_OUT, code: 0 }), { state: 'ok', missing: [] });

  const bb = parseProbeOutput({ stdout: BUSYBOX_OUT, code: 0 });
  assert.equal(bb.state, 'unsupported');
  assert.deepEqual(bb.missing.map(m => m.capability), ['readDir', 'realpath', 'stat']);
  const readDir = bb.missing.find(m => m.capability === 'readDir');
  assert.equal(readDir.probe, 'find -printf', 'the refusal names the probe, not just the capability');
  assert.equal(readDir.detail, 'find: unrecognized: -printf', "and carries the TARGET's own words");
  // base64 and /bin/bash were fine on that target — busybox is a PARTIAL
  // failure, which is exactly what makes refusing whole worth stating.
  assert.equal(bb.missing.some(m => m.capability === 'base64'), false);
});

// THE DANGEROUS ONE: busybox `stat` implements -c but ignores the `.3`, so it
// SUCCEEDS and is wrong. Caught on output shape, with exit code 0 throughout.
test('the stat mtime-precision degradation is caught from output shape, not exit code', async () => {
  const run = makeRunner(createHostTransport({}), {}, null);
  const gnu = await run({ script: `stat -L -c '%f %s %.3Y' -- / ` });
  assert.equal(gnu.code, 0);
  assert.match(gnu.stdout.toString(), /\d+\.\d{3}/, 'GNU really does answer sub-second precision here');

  // The same command shape, answered the way busybox answers it: exit 0, no dot.
  const parsed = parseProbeOutput({
    stdout: ['OK\treadDir', 'OK\trealpath',
      'FAIL\tstat\tstat -L -c %.3Y\tmtime has no sub-second precision: 81a4 2 1788194735',
      'OK\tbase64', 'OK\tshell'].join('\n'),
    code: 0,
  });
  assert.equal(parsed.state, 'unsupported', 'exit 0 must not be read as a pass');
  assert.match(parsed.missing[0].detail, /sub-second/);
});

test('this host really passes its own probe — the script is valid POSIX sh and answers every capability', async () => {
  const run = makeRunner(createHostTransport({}), {}, null);
  const res = await run({ script: PROBE_SCRIPT });
  const parsed = parseProbeOutput(res);
  assert.deepEqual(parsed, { state: 'ok', missing: [] },
    `probe stdout was:\n${res.stdout.toString()}\nstderr:\n${res.stderr}`);
});

test('a target that cannot run the probe at all is unsupported, naming the shell', () => {
  const p = parseProbeOutput({ stdout: '', stderr: 'exec: /bin/sh: not found', code: 127 });
  assert.equal(p.state, 'unsupported');
  assert.equal(p.missing[0].capability, 'shell');
  assert.match(p.missing[0].detail, /not found/);
});

test('a partial answer is unsupported, naming what did not answer', () => {
  const p = parseProbeOutput({ stdout: 'OK\treadDir\nOK\trealpath\n', code: 0 });
  assert.equal(p.state, 'unsupported');
  assert.deepEqual(p.missing.map(m => m.capability), ['stat', 'base64', 'shell']);
  assert.equal(p.missing[0].detail, 'the target did not answer this probe');
});

test('needsProbe: never probed → yes; same fingerprint → no; changed → yes', () => {
  const never = record('a', { baseline: unknownBaseline() });
  assert.equal(needsProbe(never, 'fp1'), true);
  const probed = record('a', { baseline: { state: 'ok', fingerprint: 'fp1', missing: [], checkedAt: 'x' } });
  assert.equal(needsProbe(probed, 'fp1'), false);
  assert.equal(needsProbe(probed, 'fp2'), true, 'a restarted container is a new fingerprint');
  const unsupported = record('a', { baseline: { state: 'unsupported', fingerprint: 'fp1', missing: [], checkedAt: 'x' } });
  assert.equal(needsProbe(unsupported, 'fp1'), false, 'a verdict is not re-derived per card refresh');
  assert.equal(needsProbe(unsupported, 'fp2'), true,
    'and a target that got fixed clears itself on the next refresh, with no restart');
});

// Asserted on the RECORDED CALL LOG: without this the caching claim is
// untested and every card render would silently cost a round trip.
test('refreshBaseline probes exactly once per fingerprint change', async () => {
  const calls = [];
  const run = async ({ script }) => { calls.push(script); return { code: 0, stdout: Buffer.from(GNU_OUT), stderr: '' }; };
  const transport = createHostTransport({});
  let rec = record('a', { kind: 'host', baseline: unknownBaseline() });

  const first = await refreshBaseline(transport, rec, { connected: true, fingerprint: 'fp1' }, { run });
  assert.equal(first.probed, true, 'never probed → probe');
  assert.equal(first.record.baseline.state, 'ok');
  assert.equal(first.record.baseline.fingerprint, 'fp1');
  rec = first.record;

  const second = await refreshBaseline(transport, rec, { connected: true, fingerprint: 'fp1' }, { run });
  assert.equal(second.probed, false, 'same fingerprint → NO re-probe');
  assert.equal(calls.length, 1, 'and no second round trip was made');

  const third = await refreshBaseline(transport, rec, { connected: true, fingerprint: 'fp2' }, { run });
  assert.equal(third.probed, true, 'changed fingerprint → re-probe');
  assert.equal(calls.length, 2);

  // Unreachable targets are never probed: the probe goes INTO the target.
  const offline = await refreshBaseline(transport, rec, { connected: false, fingerprint: 'fp9' }, { run });
  assert.equal(offline.probed, false);
  assert.equal(calls.length, 2);
});

test('a probe that cannot run leaves the stored verdict exactly as it was', async () => {
  const rec = record('a', { kind: 'host', baseline: { state: 'ok', fingerprint: 'fp1', missing: [], checkedAt: 'x' } });
  const run = async () => { throw new Error('transport is down'); };
  const out = await refreshBaseline(createHostTransport({}), rec, { connected: true, fingerprint: 'fp2' }, { run });
  assert.equal(out.probed, false);
  assert.deepEqual(out.record.baseline, rec.baseline, '"we could not look" is not the claim "unsupported"');
});

// ── the launcher gate ────────────────────────────────────────────────

test('the launcher REFUSES every request frame for an unsupported remote, id-addressed', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpine', {
    baseline: {
      state: 'unsupported',
      fingerprint: 'fp1',
      missing: [{ capability: 'readDir', probe: 'find -printf', detail: 'find: unrecognized: -printf' }],
      checkedAt: '2026-09-03T00:00:00.000Z',
    },
  }));
  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
  });
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'exec', id: 'e1', remoteId: 'alpine', cwd: '/tmp', argv: ['true'] });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'e1');
  // EUNKNOWN is the taxonomy's catch-all: it carries raw stderr verbatim and IS
  // surfaced to the user.
  assert.equal(err.code, 'EUNKNOWN');
  assert.equal(typeof err.id, 'string', 'id-addressed — one bad target is not a dead connection');
  assert.match(err.message, /readDir/, 'the refusal names the missing capability');
  assert.match(err.stderr, /find: unrecognized: -printf/, "and carries the target's own words");
  assert.equal(l.frames.some(f => f.type === 'exit'), false, 'refused WHOLE — no half-working system');

  // A read is refused the same way.
  l.send({ type: 'readFile', id: 'r1', remoteId: 'alpine', path: '/tmp/x' });
  assert.equal((await l.waitFor(f => f.type === 'error' && f.id === 'r1')).code, 'EUNKNOWN');
});

test('the launcher SERVES a remote that has never been probed', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  // `unknown` is the normal state for a launcher spawned before the backend
  // ever ran. Absence of evidence is not evidence, and blocking on it would
  // make a cold launcher useless.
  await writeRecord(store.dir, record('fresh', { baseline: unknownBaseline() }));
  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
  });
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'exec', id: 'e1', remoteId: 'fresh', cwd: '/tmp', argv: ['printf', 'served'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'e1');
  assert.equal(exit.code, 0);
});

// EXECUTES THE FAIL ARMS OF PROBE_SCRIPT ITSELF. Every busybox answer the tests
// above see is a hand-written string, so the script's own `printf` quoting and
// its `case "$3" in *.*)` output-shape branch were never run: a quoting bug
// there, or a retargeted `case`, passes the whole suite and surfaces on a real
// Alpine target as a WRONG VERDICT — exactly what the probe exists to prevent.
//
// A PATH shim of find/realpath/stat emitting the busybox text quoted verbatim
// from code-conductor's systems-protocol.md §11 gets those arms executed with no
// busybox and no container, matching this project's fake-external-deps
// convention.
test('the probe script\'s own busybox arms execute and produce the right verdict', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const bin = path.join(store.dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  const shim = async (name, body) => {
    const f = path.join(bin, name);
    await fs.writeFile(f, `#!/bin/sh\n${body}\n`);
    await fs.chmod(f, 0o755);
  };
  // BusyBox v1.38.0, measured, per systems-protocol.md §11.
  await shim('find', `printf 'find: unrecognized: -printf\\n' >&2; exit 1`);
  await shim('realpath', `printf "realpath: -e: No such file or directory\\n" >&2; exit 1`);
  // Succeeds AND IS WRONG: -c honoured, the .3 precision silently dropped.
  await shim('stat', `printf '41ed 4096 1788194735\\n'; exit 0`);

  const res = await new Promise((resolve) => {
    const c = spawn('/bin/sh', ['-c', PROBE_SCRIPT], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = []; const err = [];
    c.stdout.on('data', b => out.push(b));
    c.stderr.on('data', b => err.push(b));
    c.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
  });

  const parsed = parseProbeOutput(res);
  assert.equal(parsed.state, 'unsupported', `probe stdout was:\n${res.stdout.toString()}`);
  assert.deepEqual(parsed.missing.map(m => m.capability), ['readDir', 'realpath', 'stat']);

  const byCap = Object.fromEntries(parsed.missing.map(m => [m.capability, m]));
  assert.equal(byCap.readDir.probe, 'find -printf');
  assert.equal(byCap.readDir.detail, 'find: unrecognized: -printf',
    "the script carried the target's own words through its printf intact");
  assert.match(byCap.realpath.detail, /No such file or directory/);
  // The output-shape branch: exit 0 throughout, caught on the missing dot.
  assert.match(byCap.stat.detail, /sub-second/);
  assert.match(byCap.stat.detail, /1788194735/, 'and quotes what the target actually answered');
  assert.equal(byCap.stat.probe.includes('%.3Y'), true, 'the probe names the flag it checked');
});
