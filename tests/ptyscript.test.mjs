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
import { ENV_NAME_RE, findMarker, overlayBlob, ptyTrampolineArgv } from '../src/launcher/kinds/ptyscript.mjs';
import { HELPER_INPUT_WINDOW_BYTES, probePtyHelper, spawnPty } from '../src/launcher/ptyhost.mjs';

const PYTHON = process.env.CODE_SYSTEM_PYTHON?.trim() || 'python3';
const probe = await probePtyHelper({ python: PYTHON });
const SKIP = probe.ok ? false
  : `the pty helper cannot run here (${probe.reason}); set CODE_SYSTEM_PYTHON to a python3 that can`;

async function scratch(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-pty-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// One trampoline under the helper, driven as terminal.mjs drives it: on
// `OVERLAY` it is sent `env` (name/value pairs, applied in order) in-band.
// Resolves with everything the terminal printed after the overlay exchange,
// the final marker, and the helper's exit report. `onOutput` is handed the
// terminal and everything after the marker, on every chunk once it is seen.
function runTrampoline({ cwd, argv = null, env = [], mode = 'exec', cols = 80, rows = 24, helperEnv = process.env, onOutput }) {
  const nonce = randomBytes(12).toString('hex');
  const blob = overlayBlob(env);
  return new Promise((resolve, reject) => {
    let out = '';
    let marker = null;
    let sent = false;
    let asked = false;
    const timer = setTimeout(() => { proc.close(); reject(new Error(`no exit within 10s: ${JSON.stringify(out)}`)); }, 10_000);
    const proc = spawnPty({
      interpreter: probe.interpreter,
      argv: ptyTrampolineArgv({ nonce, cwd, cols, rows, mode, blobBytes: blob.length, argv }),
      env: helperEnv,
      programEnv: {},
      cwd: '/',
      cols,
      rows,
      maxQueuedBytes: 1024 * 1024,
    }, {
      onStarted() {},
      onData(b) {
        out += b.toString('latin1');
        if (!marker) marker = findMarker(out, nonce);
        if (marker?.kind === 'overlay') {
          if (!sent) { sent = true; asked = true; proc.write(blob); }
          out = out.slice(marker.end);
          marker = findMarker(out, nonce);
        }
        if (marker) onOutput?.(proc, out.slice(marker.end));
      },
      onWritten() {},
      onExit(code, signal) { clearTimeout(timer); resolve({ out, marker, code, signal, asked }); },
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
  const [file, ...args] = ptyTrampolineArgv({ nonce, cwd: dir, cols: 80, rows: 24, mode: 'exec', blobBytes: 0, argv: ['echo', 'RAN'] });
  const r = spawnSync(file, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const m = findMarker(r.stdout, nonce);
  assert.deepEqual([m?.kind, m?.code], ['error', 'EPTY'], JSON.stringify(r.stdout));
  assert.doesNotMatch(r.stdout, /RAN/);
});

// THE ENVIRONMENT REACHES THE PROGRAM ONLY, and exactly. An overlay PATH that
// resolves nothing would, applied to the trampoline, lose it `stty` and `tty`
// — so the marker would carry no terminal. Here the program sees the overlay
// byte for byte while the marker is whole, and a later entry beats an earlier
// one, which is how the plumbing and TERM beat the overlay.
test('the env reaches the program exactly, not the trampoline, and a later entry wins', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const odd = "a b'c\n$HOME `x` \\ é\n\n";
  const r = await runTrampoline({
    cwd: dir,
    env: [['PATH', '/nonexistent'], ['TERM', 'dumb'], ['CC_PROBE', odd], ['TERM', 'xterm-256color']],
    argv: ['/bin/sh', '-c', '/usr/bin/stty -opost; printf "[%s][%s][%s]" "$PATH" "$TERM" "$CC_PROBE"'],
  });
  assert.equal(r.marker?.kind, 'started', JSON.stringify(r.out));
  assert.match(r.marker.tty, /^\/dev\/pts\/\d+$/, 'the trampoline still found `tty`');
  assert.equal(Buffer.from(tail(r), 'latin1').toString('utf8'), `[/nonexistent][xterm-256color][${odd}]`);
  assert.equal(r.code, 0);
});

// EXEC'D AS GIVEN: an `argv[0]` holding `=` is a program — never an assignment
// a wrapping `env(1)` would consume (cc's own spawn is execvpe).
test('an argv[0] containing = is run as the program it names', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  await fs.mkdir(path.join(dir, 'a=b'));
  for (const f of [path.join(dir, 'A=b'), path.join(dir, 'a=b', 'run')]) {
    await fs.writeFile(f, '#!/bin/sh\necho "RAN $0 $*"\n', { mode: 0o755 });
  }
  const rel = await runTrampoline({ cwd: dir, argv: ['./A=b', 'x'] });
  assert.equal(rel.marker?.kind, 'started', JSON.stringify(rel.out));
  assert.match(tail(rel), /^RAN \.\/A=b x\r\n$/);
  const abs = await runTrampoline({ cwd: dir, argv: [path.join(dir, 'a=b', 'run'), 'bash'] });
  assert.match(tail(abs), new RegExp(`^RAN ${path.join(dir, 'a=b', 'run').replace(/[/.]/g, '\\$&')} bash\\r\\n$`));
});

// THE BARE-NAME PRE-CHECK answers as execvp would (cc §7, `ARGV_SCRIPT`): a
// PATH entry where the name exists but is not a runnable regular file is
// EACCES, not ENOENT — and a later runnable one still wins.
test('a bare name present on PATH but not runnable is EACCES; a later runnable one is run', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  for (const d of ['asdir', 'asfile', 'good']) await fs.mkdir(path.join(dir, d));
  await fs.mkdir(path.join(dir, 'asdir', 'prog'));
  await fs.writeFile(path.join(dir, 'asfile', 'prog'), 'echo NO\n', { mode: 0o644 });
  await fs.writeFile(path.join(dir, 'good', 'prog'), '#!/bin/sh\necho GOOD\n', { mode: 0o755 });
  for (const sub of ['asdir', 'asfile']) {
    const r = await runTrampoline({ cwd: dir, env: [['PATH', path.join(dir, sub)]], argv: ['prog'] });
    assert.deepEqual([r.marker?.kind, r.marker?.code], ['error', 'EACCES'], `${sub}: ${JSON.stringify(r.out)}`);
  }
  const ok = await runTrampoline({ cwd: dir, env: [['PATH', `${path.join(dir, 'asdir')}:${path.join(dir, 'good')}`]], argv: ['prog'] });
  assert.match(tail(ok), /^GOOD\r\n$/);
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

// NO ARGV IS THE PASSWD SHELL, AS A LOGIN SHELL. $SHELL is set to a decoy that
// is not it, so reading $SHELL first reds this; and bash's own `login_shell`
// option is the login-only observable for `-l`.
test('no argv runs the passwd shell — not $SHELL — as a login shell', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const uid = String(process.getuid());
  const shell = readFileSync('/etc/passwd', 'utf8').split('\n').map(l => l.split(':')).find(f => f[2] === uid)?.[6];
  if (!shell || !/bash$/.test(shell)) { t.skip(`the passwd shell here is ${shell}, not bash: no login_shell to read`); return; }
  let sent = false;
  const r = await runTrampoline({
    cwd: dir,
    helperEnv: { ...process.env, SHELL: '/bin/sh' },
    onOutput: (proc) => {
      if (!sent) { sent = true; proc.write(Buffer.from('shopt -q login_shell && echo "LOGIN=yes BASH=${BASH}"; exit 0\n')); }
    },
  });
  assert.equal(r.marker?.kind, 'started');
  assert.match(tail(r), /LOGIN=yes BASH=\/\S*bash/, 'bash, from passwd, and a login shell');
});

// THE HELPER'S QUEUE IS BOUNDED: past `maxQueuedBytes` a write is refused and
// nothing of it is taken, whatever the peer sends.
test('spawnPty refuses a write past maxQueuedBytes', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const proc = spawnPty({
    interpreter: probe.interpreter, argv: ['sleep', '10'], env: process.env, programEnv: {},
    cwd: dir, cols: 80, rows: 24, maxQueuedBytes: 1000,
  }, { onStarted() {}, onData() {}, onWritten() {}, onExit() {}, onFailed() {} });
  t.after(() => proc.close());
  assert.equal(proc.write(Buffer.alloc(1000, 0x61)), true, 'up to the cap is taken');
  assert.equal(proc.write(Buffer.alloc(1, 0x61)), false, 'one byte past it is refused');
});

// PINS overlayBlob's OWN guard, ungated: the blob is `eval`ed on the target, so
// it refuses a name outside ENV_NAME_RE whoever calls it — a name like
// `A;echo X` would otherwise be command execution.
test('overlayBlob refuses a name outside the identifier rule, and a NUL in a value', () => {
  for (const name of ['A-B', '1A', 'a.b', 'A;echo X', '', 'A B']) {
    assert.throws(() => overlayBlob([[name, 'v']]), /environment name/, name);
  }
  assert.throws(() => overlayBlob([['A', 'x\0y']]), /NUL/);
  assert.equal(overlayBlob([['_A1', "it's"]]).toString(), "export _A1='it'\\''s'\n");
  assert.equal(ENV_NAME_RE.test('_A1'), true);
});

// A PATH directory of the trampoline's tools: the real ones, minus `omit`,
// plus `fake` scripts by name.
async function toolDir(t, { omit = null, fake = {} } = {}) {
  const dir = await scratch(t);
  for (const tool of ['stty', 'tty', 'id', 'head']) {
    if (tool === omit || fake[tool]) continue;
    await fs.symlink(real(tool), path.join(dir, tool));
  }
  for (const [tool, body] of Object.entries(fake)) {
    await fs.writeFile(path.join(dir, tool), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return dir;
}
const real = (tool) => spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();

// PINS THE UP-FRONT TOOL CHECK: each tool the trampoline runs before the
// program is checked first, and a missing one is refused by name — never a
// start, and never an OVERLAY request.
test('a missing trampoline tool is refused EPTY by name, and nothing starts', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  for (const tool of ['stty', 'tty', 'id', 'head']) {
    const bin = await toolDir(t, { omit: tool });
    const r = await runTrampoline({ cwd: dir, argv: ['/bin/echo', 'RAN'], helperEnv: { ...process.env, PATH: bin } });
    assert.deepEqual([r.marker?.kind, r.marker?.code, r.marker?.detail], ['error', 'EPTY', `missing-${tool}`], JSON.stringify(r.out));
    assert.equal(r.asked, false, 'the environment was never asked for');
    assert.doesNotMatch(r.out, /RAN/);
  }
});

// PINS FAIL-CLOSED ON `stty`: if the terminal cannot be made raw and `-echo`,
// it is refused BEFORE `OVERLAY`, so the blob never meets a cooked, echoing tty.
test('a failing stty -g or stty raw -echo is refused before the environment is asked for', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const fakes = [
    'exit 1',
    `case "$1" in -g) exec ${real('stty')} -g ;; esac; exit 1`,
  ];
  for (const body of fakes) {
    const bin = await toolDir(t, { fake: { stty: body } });
    const r = await runTrampoline({ cwd: dir, argv: ['/bin/echo', 'RAN'], helperEnv: { ...process.env, PATH: bin } });
    assert.deepEqual([r.marker?.kind, r.marker?.code, r.marker?.detail], ['error', 'EPTY', 'stty'], `${body}: ${JSON.stringify(r.out)}`);
    assert.equal(r.asked, false, 'no OVERLAY was printed');
    assert.doesNotMatch(r.out, /RAN/);
  }
});

// PINS FAIL-CLOSED ON THE READ: a `head` that returns short, or fails, is a
// refusal — never a start without the environment and TERM.
test('a short or failed read of the environment is refused EPTY, and nothing starts', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const fakes = [
    `${real('head')} -c "$2" | ${real('head')} -c 3`,
    `${real('head')} -c "$2" >/dev/null; exit 1`,
  ];
  for (const body of fakes) {
    const bin = await toolDir(t, { fake: { head: body } });
    const r = await runTrampoline({
      cwd: dir, argv: ['/bin/echo', 'RAN'], env: [['CC_X', 'value']], helperEnv: { ...process.env, PATH: bin },
    });
    assert.equal(r.asked, true, 'the environment was asked for');
    assert.deepEqual([r.marker?.kind, r.marker?.code, r.marker?.detail], ['error', 'EPTY', 'overlay'], `${body}: ${JSON.stringify(r.out)}`);
    assert.doesNotMatch(r.out, /RAN/);
  }
});

// PINS THE DEFAULT CAP: a caller that omits `maxQueuedBytes` still gets one —
// HELPER_INPUT_WINDOW_BYTES, never no limit.
test('spawnPty without maxQueuedBytes caps its queue at HELPER_INPUT_WINDOW_BYTES', { skip: SKIP }, async (t) => {
  const dir = await scratch(t);
  const proc = spawnPty({
    interpreter: probe.interpreter, argv: ['sleep', '10'], env: process.env, programEnv: {}, cwd: dir, cols: 80, rows: 24,
  }, { onStarted() {}, onData() {}, onWritten() {}, onExit() {}, onFailed() {} });
  t.after(() => proc.close());
  assert.equal(proc.write(Buffer.alloc(HELPER_INPUT_WINDOW_BYTES, 0x61)), true, 'a full window is taken');
  assert.equal(proc.write(Buffer.alloc(1, 0x61)), false, 'one byte past it is refused');
});
