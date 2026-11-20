// TERMINALS OVER THE AGENT: the core's host pty helper runs a bridge in
// `--pty` mode, the agent opens a real far pty, and the shared trampoline runs
// in it. What these pin is the terminal contract cc relies on — and the one
// thing this transport does differently from docker and ssh: a resize goes
// in-band and IN ORDER, with no `stty -F` relay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Launcher } from './helpers.mjs';
import { NEEDS_PYTHON, PY, agentEnv, agentWorld, alive, waitFor } from './agentFixture.mjs';
import { probePtyHelper } from '../src/launcher/ptyhost.mjs';

const probe = PY.python ? await probePtyHelper({ python: PY.python }) : { ok: false, reason: NEEDS_PYTHON };
const skip = NEEDS_PYTHON || (probe.ok ? false : `the pty helper cannot run here (${probe.reason})`);

const PTY = { cols: 80, rows: 24, term: 'xterm-256color' };
const b64 = s => Buffer.from(s).toString('base64');

async function rig(t) {
  const w = await agentWorld(t);
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-pty-')));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const l = new Launcher(['--kind', 'agent'], { ...agentEnv(w.store), CODE_SYSTEM_PYTHON: PY.python, CODE_SYSTEM_CHANNEL: '0' });
  t.after(() => l.kill());
  const hello = await l.hello();
  assert.equal(hello.capabilities.pty, true);
  return { w, l, cwd };
}

const framesOf = (l, id) => l.frames.filter(f => f.id === id);
const outOf = (l, id) => framesOf(l, id).filter(f => f.type === 'stdout')
  .map(f => Buffer.from(f.dataB64, 'base64').toString('latin1')).join('');
const credited = (l, id) => framesOf(l, id).filter(f => f.type === 'inputAck').reduce((n, f) => n + f.bytes, 0);
const until = (l, id, re) => waitFor(() => re.test(outOf(l, id)), { what: `${re} on ${id}: ${JSON.stringify(outOf(l, id))}` });
const open = (l, id, cwd, argv) => l.send({ type: 'exec', id, remoteId: 'ag', cwd, argv, pty: PTY });
const exitOf = l => id => l.waitFor(f => f.id === id && (f.type === 'exit' || f.type === 'error'), { timeoutMs: 15_000 });

test('a terminal starts, carries output and input, and reports the exact exit code', { skip }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', cwd, ['/bin/sh', '-c', 'echo "pwd=$(pwd) remote=$CC_REMOTE"; read x; echo "got=$x"; exit 7']);
  await l.waitFor(f => f.id === 't1' && f.type === 'ptyStarted');
  assert.equal(framesOf(l, 't1')[0].type, 'ptyStarted', 'the first frame');
  await until(l, 't1', /remote=ag\r\n/);
  assert.match(outOf(l, 't1'), new RegExp(`pwd=${cwd}`));
  l.send({ type: 'input', id: 't1', dataB64: b64('hello\r') });
  const end = await exitOf(l)('t1');
  assert.deepEqual([end.type, end.code, end.signal], ['exit', 7, null]);
  assert.match(outOf(l, 't1'), /got=hello\r\n/);
  assert.equal(outOf(l, 't1').includes('\r\r\n'), false, 'one line discipline, not two');
});

// PINS input credit: granted only for bytes written, and it adds up to
// exactly what was sent.
test('inputAck credits exactly the bytes sent', { skip }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', cwd, ['/bin/sh', '-c', 'stty -echo; read a; read b; echo "[$a][$b]"']);
  await l.waitFor(f => f.id === 't1' && f.type === 'ptyStarted');
  l.send({ type: 'input', id: 't1', dataB64: b64('one\r') });
  l.send({ type: 'input', id: 't1', dataB64: b64('two\r') });
  await until(l, 't1', /\[one\]\[two\]/);
  await waitFor(() => credited(l, 't1') === 8, { what: `8 bytes credited (got ${credited(l, 't1')})` });
});

// PINS that terminal input credit stays honest: while the program reads
// nothing, the transport absorbs well under cc's input window (a terminal's
// bridge keeps one chunk in flight), and every byte's credit returns once it
// reads.
test('input credit is not granted for a whole window the program has not read', { skip }, async (t) => {
  const { l, cwd } = await rig(t);
  const { PTY_INPUT_WINDOW_BYTES: W, CHUNK_BYTES } = await import('../src/launcher/protocol.mjs');
  open(l, 't1', cwd, ['/bin/sh', '-c', `stty raw -echo; echo READY; while [ ! -e GO ]; do sleep 0.01; done; head -c ${W} >/dev/null; echo DONE`]);
  await until(l, 't1', /READY/);
  for (let at = 0; at < W; at += CHUNK_BYTES) {
    l.send({ type: 'input', id: 't1', dataB64: Buffer.alloc(Math.min(CHUNK_BYTES, W - at), 0x61).toString('base64') });
  }
  await new Promise(r => setTimeout(r, 500));
  assert.ok(credited(l, 't1') < W, `credited ${credited(l, 't1')} of ${W} while the program read nothing`);
  await fs.writeFile(path.join(cwd, 'GO'), '');
  await until(l, 't1', /DONE/);
  await waitFor(() => credited(l, 't1') === W, { what: `all ${W} bytes credited (got ${credited(l, 't1')})` });
});

// PINS the in-order resize: no input is ever read by a program that sees a
// size OLDER than the last resize sent before that input. Sizes are a state,
// not a queue — the host terminal holds only its latest size, as any terminal
// does — so a burst of resizes ahead of one input COALESCES to the last.
test('a resize lands before the input that follows it; a burst coalesces to the last', { skip }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', cwd, ['/bin/sh', '-c', 'stty -echo; while read x; do stty size; done']);
  await l.waitFor(f => f.id === 't1' && f.type === 'ptyStarted');
  const sizes = [[100, 40], [81, 25], [132, 50], [90, 33]];
  let lines = 0;
  for (const [cols, rows] of sizes) {
    l.send({ type: 'resize', id: 't1', cols, rows });
    l.send({ type: 'input', id: 't1', dataB64: b64('\r') });
    lines += 1;
    await waitFor(() => outOf(l, 't1').split('\n').length > lines, { what: `answer ${lines}` });
    assert.equal(outOf(l, 't1').trim().split(/\r?\n/).pop().trim(), `${rows} ${cols}`);
  }
  for (const [cols, rows] of [[70, 20], [71, 21], [72, 22]]) l.send({ type: 'resize', id: 't1', cols, rows });
  l.send({ type: 'input', id: 't1', dataB64: b64('\r') });
  await waitFor(() => outOf(l, 't1').split('\n').length > lines + 1, { what: 'the burst answer' });
  assert.equal(outOf(l, 't1').trim().split(/\r?\n/).pop().trim(), '22 72');
  l.send({ type: 'close', id: 't1' });
});

// PINS ^C: a raw byte through two terminals, turned into SIGINT by the FAR
// one, and the program's death by it reported as the signal.
test('^C interrupts the program, and a signal death is reported as the signal', { skip }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', cwd, ['/bin/sh', '-c', 'echo ready; exec sleep 30']);
  await until(l, 't1', /ready/);
  l.send({ type: 'input', id: 't1', dataB64: b64('\x03') });
  const end = await exitOf(l)('t1');
  assert.deepEqual([end.type, end.code, end.signal], ['exit', null, 'SIGINT']);
});

test('close hangs the terminal up and reaps its session', { skip }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', cwd, ['/bin/sh', '-c', 'trap "" HUP; echo $$; exec sleep 30']);
  await until(l, 't1', /^\d+\r\n/);
  const pid = Number(/^(\d+)/.exec(outOf(l, 't1'))[1]);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(alive(pid), true);
  l.send({ type: 'close', id: 't1' });
  await waitFor(() => !alive(pid), { what: 'the terminal\'s program to be reaped' });
});
