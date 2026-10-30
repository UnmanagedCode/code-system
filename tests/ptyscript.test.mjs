// PINS the far-side pty TRAMPOLINE (src/launcher/kinds/ptyscript.mjs): the
// script every kind's terminal runs on its target, ahead of the program. Run
// here on THIS machine under the vendored pty helper — the same chain `host`
// runs, and the same script docker and ssh hand their far side.
//
// PYTHON-GATED: the helper needs python3 (or CODE_SYSTEM_PYTHON). Without it
// every test here skips, naming the variable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findMarker, ptyTrampolineArgv } from '../src/launcher/kinds/ptyscript.mjs';
import { probePtyHelper, spawnPty } from '../src/launcher/ptyhost.mjs';

const PYTHON = process.env.CODE_SYSTEM_PYTHON?.trim() || 'python3';
const probe = await probePtyHelper({ python: PYTHON });
const SKIP = probe.ok ? false
  : `the pty helper cannot run here (${probe.reason}); set CODE_SYSTEM_PYTHON to a python3 that can`;

async function scratch(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-pty-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// One trampoline under the helper. Resolves with everything the terminal
// printed, the parsed marker, and the helper's exit report. `onOutput` is
// handed the terminal and everything after the marker, on every chunk once the
// marker has been seen.
function runTrampoline({ cwd, argv = null, assignments = [], mode = 'exec', cols = 80, rows = 24, onOutput }) {
  const nonce = randomBytes(12).toString('hex');
  return new Promise((resolve, reject) => {
    let out = '';
    let marker = null;
    const timer = setTimeout(() => { proc.close(); reject(new Error(`no exit within 10s: ${JSON.stringify(out)}`)); }, 10_000);
    const proc = spawnPty({
      interpreter: probe.interpreter,
      argv: ptyTrampolineArgv({ nonce, cwd, cols, rows, mode, assignments, argv }),
      env: process.env,
      programEnv: {},
      cwd: '/',
      cols,
      rows,
    }, {
      onStarted() {},
      onData(b) {
        out += b.toString('latin1');
        if (!marker) marker = findMarker(out, nonce);
        if (marker) onOutput?.(proc, out.slice(marker.end));
      },
      onWritten() {},
      onExit(code, signal) { clearTimeout(timer); resolve({ out, marker, code, signal }); },
      onFailed(code, message) { clearTimeout(timer); reject(new Error(`${code}: ${message}`)); },
    });
  });
}

const tail = (r) => r.out.slice(r.marker.end);

test('a cwd that is not there is ENOENT, and nothing is started', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const r = await runTrampoline({ cwd: path.join(dir, 'gone'), argv: ['true'] });
  assert.equal(r.marker?.kind, 'error', JSON.stringify(r.out));
  assert.equal(r.marker.code, 'ENOENT');
  assert.doesNotMatch(r.out, /STARTED/);
});

test('a cwd that is a file is ENOTDIR', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  await fs.writeFile(path.join(dir, 'f'), '');
  const r = await runTrampoline({ cwd: path.join(dir, 'f'), argv: ['true'] });
  assert.deepEqual([r.marker?.kind, r.marker?.code], ['error', 'ENOTDIR'], JSON.stringify(r.out));
});

test('a program that is not there is ENOENT; one that is not executable is EACCES; neither starts', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  await fs.writeFile(path.join(dir, 'plain'), 'echo RAN\n', { mode: 0o644 });
  const missing = await runTrampoline({ cwd: dir, argv: [path.join(dir, 'no-such-program')] });
  assert.deepEqual([missing.marker?.kind, missing.marker?.code], ['error', 'ENOENT'], JSON.stringify(missing.out));
  const bare = await runTrampoline({ cwd: dir, argv: ['no-such-program-anywhere-on-path'] });
  assert.deepEqual([bare.marker?.kind, bare.marker?.code], ['error', 'ENOENT'], 'searched on PATH, as execvp does');
  const plain = await runTrampoline({ cwd: dir, argv: [path.join(dir, 'plain')] });
  assert.deepEqual([plain.marker?.kind, plain.marker?.code], ['error', 'EACCES'], JSON.stringify(plain.out));
  assert.doesNotMatch(plain.out, /RAN/);
});

// THE TRANSPORT-AGNOSTIC EPTY: ssh through a multiplexed master under
// `PermitTTY no` runs the command with NO tty (measured), so the far side
// itself must say so before anything starts.
test('run without a terminal it answers EPTY and starts nothing', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const nonce = randomBytes(12).toString('hex');
  const [file, ...args] = ptyTrampolineArgv({ nonce, cwd: dir, cols: 80, rows: 24, mode: 'exec', assignments: [], argv: ['echo', 'RAN'] });
  const r = spawnSync(file, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const m = findMarker(r.stdout, nonce);
  assert.deepEqual([m?.kind, m?.code], ['error', 'EPTY'], JSON.stringify(r.stdout));
  assert.doesNotMatch(r.stdout, /RAN/);
});

// THE OVERLAY REACHES THE PROGRAM ONLY. An overlay PATH that resolves nothing
// would, applied to the trampoline, lose it `stty` and `tty` — so the marker
// would carry no terminal. Here the program sees the overlay while the marker
// is whole; `TERM` (the last assignment) beats an overlay TERM.
test('the overlay reaches the program, not the trampoline, and the last TERM wins', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const r = await runTrampoline({
    cwd: dir,
    assignments: ['PATH=/nonexistent', 'TERM=dumb', 'CC_PROBE=a b', 'TERM=xterm-256color'],
    argv: ['/usr/bin/env'],
  });
  assert.equal(r.marker?.kind, 'started', JSON.stringify(r.out));
  assert.match(r.marker.tty, /^\/dev\/pts\/\d+$/, 'the trampoline still found `tty`');
  const env = tail(r).split('\r\n');
  assert.ok(env.includes('PATH=/nonexistent'), 'the overlay PATH is the program\'s');
  assert.ok(env.includes('CC_PROBE=a b'), 'an overlay value with a space arrives whole');
  assert.ok(env.includes('TERM=xterm-256color') && !env.includes('TERM=dumb'), 'the last TERM wins');
  assert.equal(r.code, 0);
});

test('the program runs in cwd, at the size asked for', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const r = await runTrampoline({ cwd: dir, cols: 123, rows: 45, argv: ['sh', '-c', 'pwd; stty size'] });
  assert.equal(r.marker?.kind, 'started');
  assert.deepEqual(tail(r).split('\r\n').slice(0, 2), [dir, '45 123']);
});

// THE TWO RUN MODES. `exec`: the program IS the session leader (host). `child`:
// the trampoline stays as its parent and session leader, which is what makes
// the program's `$PPID` a real process on a far side where the exec'ing
// client's parent is outside the namespace (docker, measured) — and what turns
// ssh's 255-for-a-signal into 128+n.
test('exec mode: the program is the session leader the marker names', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const r = await runTrampoline({ cwd: dir, mode: 'exec', argv: ['sh', '-c', 'echo PID=$$'] });
  assert.equal(r.marker?.kind, 'started');
  assert.equal(/PID=(\d+)/.exec(tail(r))?.[1], r.marker.sid);
});

test('child mode: the program\'s parent is the trampoline, the session leader the marker names', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const r = await runTrampoline({ cwd: dir, mode: 'child', argv: ['sh', '-c', 'echo PPID=$PPID; exit 7'] });
  assert.equal(r.marker?.kind, 'started');
  assert.equal(/PPID=(\d+)/.exec(tail(r))?.[1], r.marker.sid);
  assert.equal(r.code, 7, 'the program\'s exit is the trampoline\'s');
});

test('child mode: ^C reaches the program and not the trampoline', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  let sent = false;
  const r = await runTrampoline({
    cwd: dir, mode: 'child',
    argv: ['sh', '-c', 'trap "echo GOT_INT; exit 3" INT; echo READY; while :; do sleep 0.05; done'],
    // Only once READY is out, so the program's own trap is installed first.
    onOutput: (proc, after) => {
      if (/READY/.test(after) && !sent) { sent = true; proc.write(Buffer.from('\x03')); }
    },
  });
  assert.match(tail(r), /GOT_INT/);
  assert.equal(r.code, 3);
});

test('no argv runs the target user\'s login shell, from the passwd database', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const uid = String(process.getuid());
  const shell = readFileSync('/etc/passwd', 'utf8').split('\n').map(l => l.split(':')).find(f => f[2] === uid)?.[6] || '/bin/sh';
  let sent = false;
  const r = await runTrampoline({
    cwd: dir,
    onOutput: (proc) => {
      if (!sent) { sent = true; proc.write(Buffer.from('echo "ZERO=$0 N=$((6*7))"; exit 0\n')); }
    },
  });
  assert.equal(r.marker?.kind, 'started');
  assert.match(tail(r), new RegExp(`ZERO=-?${shell.replace(/[/.]/g, '\\$&')} N=42`), 'the passwd shell ran the line');
});
