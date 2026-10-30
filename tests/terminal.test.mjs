// PINS the launcher's TERMINAL core (src/launcher/terminal.mjs) over the wire:
// the pty exec of systems-protocol.md §5 as cc sees it — `ptyStarted` first and
// the trampoline's marker never on the wire, the output credit window, input
// credit granted from the helper's drain report, input held until the program
// can take it, the resize relay, the refusals, and close/shutdown reaching the
// kind's reap with the terminal's own session.
//
// Driven through the REAL launcher with `--kind fake` and CODE_SYSTEM_FAKE_PTY=1:
// the fake's `ptyPlan` runs the shared trampoline on this machine, as `host`
// does, and records its reap calls (tests/fakeTransport.mjs).
//
// PYTHON-GATED, like every terminal: skips naming CODE_SYSTEM_PYTHON without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PTY_WINDOW_BYTES } from '../src/launcher/protocol.mjs';
import { probePtyHelper } from '../src/launcher/ptyhost.mjs';
import { settle } from './dockerFixture.mjs';
import { FAKE_TRANSPORT, Launcher, record, tempStore, writeRecord } from './helpers.mjs';

const PYTHON = process.env.CODE_SYSTEM_PYTHON?.trim() || 'python3';
const probe = await probePtyHelper({ python: PYTHON });
const SKIP = probe.ok ? false
  : `the pty helper cannot run here (${probe.reason}); set CODE_SYSTEM_PYTHON to a python3 that can`;

const PTY = { cols: 80, rows: 24, term: 'xterm-256color' };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const b64 = (s) => Buffer.from(s).toString('base64');

// Everything a test needs: a store with one remote, a scratch cwd, a reap log,
// and a launcher speaking terminals. `env` adds the fake's seams.
async function rig(t, { env = {}, config = {}, args = [] } = {}) {
  const store = await tempStore();
  await writeRecord(store.dir, record('alpha', { config }));
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-term-')));
  const reapLog = path.join(store.dir, 'reap.log');
  const l = new Launcher(['--kind', 'fake', ...args], {
    CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
    CODE_SYSTEM_FAKE_PTY: '1', CODE_SYSTEM_FAKE_REAP_LOG: reapLog, CODE_SYSTEM_PYTHON: PYTHON, ...env,
  });
  // ONE hook, in this order: the launcher reaps into the store as it dies, so
  // the store goes only once the launcher has.
  t.after(async () => {
    l.kill();
    await l.exited;
    await store.cleanup();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await l.hello();
  const reaps = async () => (await fs.readFile(reapLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
  return { l, cwd, store, reaps };
}

const framesOf = (l, id) => l.frames.filter(f => f.id === id);
const outOf = (l, id) => framesOf(l, id).filter(f => f.type === 'stdout')
  .map(f => Buffer.from(f.dataB64, 'base64').toString('latin1')).join('');
const credited = (l, id) => framesOf(l, id).filter(f => f.type === 'inputAck').reduce((n, f) => n + f.bytes, 0);
const until = (l, id, re, timeoutMs = 10_000) => settle(() => re.test(outOf(l, id)), timeoutMs)
  .then(ok => assert.ok(ok, `no ${re} on ${id}: ${JSON.stringify(outOf(l, id))}`));

// A barrier: every frame sent before it has been handled once its exit is back.
async function barrier(l, cwd) {
  const id = `b${Math.random().toString(16).slice(2)}`;
  l.send({ type: 'exec', id, remoteId: 'alpha', cwd, argv: ['true'], stdin: 'ignore' });
  await l.waitFor(f => f.id === id && (f.type === 'exit' || f.type === 'error'));
}

const open = (l, id, cwd, argv, over = {}) =>
  l.send({ type: 'exec', id, remoteId: 'alpha', cwd, ...(argv ? { argv } : {}), pty: { ...PTY, ...over } });

test('ptyStarted is the first frame, the trampoline\'s marker never reaches the wire, and no stderr frame does', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', cwd, ['sh', '-c', 'echo OUT; echo ERR >&2; exit 4']);
  const exit = await l.waitFor(f => f.id === 't1' && f.type === 'exit');
  assert.deepEqual({ code: exit.code, signal: exit.signal, timedOut: exit.timedOut }, { code: 4, signal: null, timedOut: false });
  const types = framesOf(l, 't1').map(f => f.type);
  assert.equal(types[0], 'ptyStarted');
  assert.equal(types.filter(x => x === 'ptyStarted').length, 1, 'sent once');
  assert.equal(types.includes('stderr'), false, 'the terminal merges stderr');
  assert.equal(outOf(l, 't1'), 'OUT\r\nERR\r\n', 'exactly the program\'s output — nothing the trampoline printed');
});

test('a missing cwd is an id-addressed ENOENT before any ptyStarted', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', path.join(cwd, 'gone'), ['true']);
  const err = await l.waitFor(f => f.id === 't1' && (f.type === 'error' || f.type === 'exit'));
  assert.equal(err.type, 'error');
  assert.equal(err.code, 'ENOENT');
  assert.equal(framesOf(l, 't1').some(f => f.type === 'ptyStarted'), false);
});

test('unacked output is EXACTLY one PTY_WINDOW_BYTES, and an ack resumes it', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', cwd, ['yes']);
  const bytes = () => framesOf(l, 't1').filter(f => f.type === 'stdout')
    .reduce((n, f) => n + Buffer.from(f.dataB64, 'base64').length, 0);
  assert.ok(await settle(() => bytes() >= PTY_WINDOW_BYTES, 10_000), `the flood filled the window (${bytes()})`);
  // Three barriers: anything past the window would have arrived by now.
  for (let i = 0; i < 3; i++) await barrier(l, cwd);
  assert.equal(bytes(), PTY_WINDOW_BYTES);
  l.send({ type: 'ack', id: 't1', bytes: 1000 });
  assert.ok(await settle(() => bytes() === PTY_WINDOW_BYTES + 1000, 5_000), `an ack returns exactly its credit (${bytes()})`);
  l.send({ type: 'close', id: 't1' });
});

// INPUT CREDIT IS GRANTED FROM THE HELPER'S DRAIN REPORT, never on receipt: a
// program that reads nothing leaves most of what was sent uncredited, and once
// it reads, every byte's credit comes back — and not one more.
test('inputAck credits bytes written into the terminal, not bytes received, and all of them', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  const N = 64 * 1024;
  open(l, 't1', cwd, ['sh', '-c', `stty raw -echo; echo READY; while [ ! -e GO ]; do sleep 0.01; done; head -c ${N} >/dev/null; echo DONE; exec sleep 1000`]);
  await until(l, 't1', /READY/);
  l.send({ type: 'input', id: 't1', dataB64: Buffer.alloc(N, 0x61).toString('base64') });
  for (let i = 0; i < 3; i++) await barrier(l, cwd);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(credited(l, 't1') < N, `while unread, less than was sent is credited (${credited(l, 't1')} of ${N})`);
  await fs.writeFile(path.join(cwd, 'GO'), '');
  await until(l, 't1', /DONE/);
  assert.ok(await settle(() => credited(l, 't1') === N, 5_000), `every byte's credit returns (${credited(l, 't1')} of ${N})`);
  assert.ok(framesOf(l, 't1').filter(f => f.type === 'inputAck').every(f => Number.isInteger(f.bytes) && f.bytes > 0));
  l.send({ type: 'close', id: 't1' });
});

// HELD, NOT WRITTEN: input that arrives before the program has a terminal would
// be echoed by it ahead of the marker — and that echo is discarded with the
// marker. Held, it is echoed after `ptyStarted` like any keystroke, and earns
// no credit before it was written.
test('input before ptyStarted is held: no credit for it before the start, and its echo arrives after', { skip: SKIP }, async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const gate = path.join(store.dir, 'trampoline-go');
  const { l, cwd } = await rig(t, { env: { CODE_SYSTEM_FAKE_PTY_GATE: gate } });
  open(l, 't1', cwd, ['cat']);
  l.send({ type: 'input', id: 't1', dataB64: b64('early\n') });
  await barrier(l, cwd);
  await fs.writeFile(gate, '');
  await until(l, 't1', /early\r\nearly\r\n/);
  const types = framesOf(l, 't1').map(f => f.type);
  assert.ok(types.indexOf('inputAck') > types.indexOf('ptyStarted'), `no inputAck before ptyStarted: ${types}`);
  l.send({ type: 'close', id: 't1' });
});

// THE RESIZE RELAY (docker and ssh: their clients relay a resize asynchronously
// and lose the race against the next keystroke, measured). With it on, input
// after a `resize` waits for the relay to finish.
test('with the resize relay, input after a resize waits for the relay', { skip: SKIP }, async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const relayGate = path.join(store.dir, 'relay-go');
  const { l, cwd } = await rig(t, { env: { CODE_SYSTEM_FAKE_PTY_RELAY: '1', CODE_SYSTEM_FAKE_RELAY_GATE: relayGate } });
  open(l, 't1', cwd, ['sh', '-c', 'stty size; read x; stty size; read y']);
  await until(l, 't1', /^24 80\r$/m);
  l.send({ type: 'resize', id: 't1', cols: 100, rows: 40 });
  l.send({ type: 'input', id: 't1', dataB64: b64('\n') });
  await barrier(l, cwd);
  await new Promise(r => setTimeout(r, 200));
  assert.doesNotMatch(outOf(l, 't1'), /^40 100\r$/m, 'the input waited for the relay');
  assert.equal(credited(l, 't1'), 0, 'held input earns no credit');
  await fs.writeFile(relayGate, '');
  await until(l, 't1', /^40 100\r$/m);
  l.send({ type: 'close', id: 't1' });
});

test('close reaps with the terminal\'s own session, kills the program, and emits nothing more', { skip: SKIP }, async (t) => {
  const { l, cwd, reaps } = await rig(t);
  open(l, 't1', cwd, ['sh', '-c', 'echo PID=$$; exec sleep 1000']);
  await until(l, 't1', /PID=\d+/);
  const pid = Number(/PID=(\d+)/.exec(outOf(l, 't1'))[1]);
  assert.ok(alive(pid), 'running before the close');
  const before = framesOf(l, 't1').length;
  l.send({ type: 'close', id: 't1' });
  assert.ok(await settle(async () => (await reaps()).length === 1, 5_000), 'the kind was asked to reap');
  const [r] = await reaps();
  assert.equal(r.sid, String(pid), 'scoped to the session the marker named — the program leads it here');
  assert.equal(r.remoteId, 'alpha');
  assert.match(r.token, /^[0-9a-f]{24}$/);
  assert.ok(await settle(() => !alive(pid), 5_000), 'the program is gone');
  await barrier(l, cwd);
  assert.equal(framesOf(l, 't1').length, before, 'no frame after close');
});

test('stdin EOF to the launcher closes and reaps every open terminal (MUST 3)', { skip: SKIP }, async (t) => {
  const { l, cwd, reaps } = await rig(t);
  open(l, 't1', cwd, ['sh', '-c', 'echo PID=$$; exec sleep 1000']);
  await until(l, 't1', /PID=\d+/);
  const pid = Number(/PID=(\d+)/.exec(outOf(l, 't1'))[1]);
  l.closeStdin();
  await l.exited;
  const r = await reaps();
  assert.equal(r.length, 1);
  assert.equal(r[0].sid, String(pid));
  assert.ok(await settle(() => !alive(pid), 5_000), 'the program is gone');
});

test('a client that exits before any marker is the classifier\'s verdict, or EUNKNOWN without an errno token', { skip: SKIP }, async (t) => {
  const down = await rig(t, { config: { ptyFail: 'down' } });
  open(down.l, 't1', down.cwd, ['true']);
  const e1 = await down.l.waitFor(f => f.id === 't1' && f.type === 'error');
  assert.equal(e1.code, 'ENOREMOTE');

  const odd = await rig(t, { config: { ptyFail: 'garbage' } });
  open(odd.l, 't2', odd.cwd, ['true']);
  const e2 = await odd.l.waitFor(f => f.id === 't2' && f.type === 'error');
  assert.equal(e2.code, 'EUNKNOWN');
  assert.match(e2.message, /odd/, 'the head is quoted');
  assert.doesNotMatch(e2.message, /\bENOENT\b/, 'with no bare errno token cc would re-read');
  for (const l of [down.l, odd.l]) assert.equal(l.frames.some(f => f.type === 'ptyStarted'), false);
});

test('a malformed pty exec is EPROTO, id-addressed; a pty exec under --no-pty is EUNSUPPORTED', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  const bad = [
    { pty: { ...PTY, cols: 0 } },
    { pty: { ...PTY, rows: 4097 } },
    { pty: { ...PTY, cols: 1.5 } },
    { pty: { ...PTY, term: 7 } },
    { pty: { ...PTY, envOverlay: { A: 1 } } },
    { pty: { ...PTY, envOverlay: { 'A=B': 'x' } } },
    { pty: PTY, shell: 'echo hi' },
    { pty: PTY, env: {} },
    { pty: PTY, timeoutMs: 1000 },
    { pty: PTY, argv: [] },
  ];
  for (const [i, over] of bad.entries()) {
    l.send({ type: 'exec', id: `x${i}`, remoteId: 'alpha', cwd, argv: ['true'], ...over });
    const f = await l.waitFor(g => g.id === `x${i}` && g.type !== 'stdout');
    assert.deepEqual([f.type, f.code], ['error', 'EPROTO'], JSON.stringify(over));
  }
  await barrier(l, cwd);
  assert.equal(l.frames.some(f => f.type === 'error' && !f.id), false, 'none of them was connection-level');

  const off = await rig(t, { args: ['--no-pty'] });
  open(off.l, 'u1', off.cwd, ['true']);
  const u = await off.l.waitFor(f => f.id === 'u1');
  assert.deepEqual([u.type, u.code], ['error', 'EUNSUPPORTED']);
});

// cc never sends `signal` or `detach` for a pty id, and a provider MAY ignore
// them (§5) — so they must not kill, detach or silence the terminal.
test('signal and detach on a pty id change nothing', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 't1', cwd, ['cat']);
  await l.waitFor(f => f.id === 't1' && f.type === 'ptyStarted');
  l.send({ type: 'signal', id: 't1', signal: 'SIGKILL', processGroup: true });
  l.send({ type: 'detach', id: 't1' });
  l.send({ type: 'input', id: 't1', dataB64: b64('still\n') });
  await until(l, 't1', /still\r\nstill\r\n/);
  l.send({ type: 'input', id: 't1', dataB64: b64('\x04') });
  assert.equal((await l.waitFor(f => f.id === 't1' && f.type === 'exit')).code, 0);
});
