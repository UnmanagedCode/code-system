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
import { PTY_INPUT_WINDOW_BYTES, PTY_WINDOW_BYTES } from '../src/launcher/protocol.mjs';
import { overlayBlob } from '../src/launcher/kinds/ptyscript.mjs';
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

// Every live process on THIS machine whose argv holds `needle`.
async function cmdlinesHolding(needle) {
  const hits = [];
  for (const pid of await fs.readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    const cmd = await fs.readFile(`/proc/${pid}/cmdline`, 'latin1').catch(() => '');
    if (cmd.includes(needle)) hits.push(`${pid}: ${cmd.replace(/\0/g, ' ').slice(0, 200)}`);
  }
  return hits;
}

// PINS THE OVERLAY'S FOUR INVARIANTS through `Terminals.open`: (a) no overlay
// value is in any process's argv — /proc/<pid>/cmdline is world-readable — while
// the terminal is open; (b) it does not apply to the trampoline's own tools — a
// PATH that resolves nothing leaves `tty`, so the marker carries one and the
// resize relay, which needs it, raises no warning; (c) the program gets the
// exact bytes; (d) the plumbing and TERM beat it, on the program and on the reap.
test('the overlay is in no argv, reaches only the program exactly, and the plumbing and TERM beat it', { skip: SKIP }, async (t) => {
  const { l, cwd, reaps } = await rig(t, { env: { CODE_SYSTEM_FAKE_PTY_RELAY: '1' } });
  const sentinel = `ccsentinel${Math.random().toString(16).slice(2)}`;
  const odd = `${sentinel} 'q' $HOME\n`;
  open(l, 't1', cwd, ['/bin/sh', '-c', '/usr/bin/stty -opost; printf "[%s]" "$PATH" "$CC_REMOTE" "$CC_EXEC_TOKEN" "$TERM" "$CC_ODD"; read x; /usr/bin/stty size; read y'], {
    envOverlay: { PATH: '/nonexistent', CC_REMOTE: 'evil', CC_EXEC_TOKEN: 'evil', TERM: 'dumb', CC_ODD: odd },
  });
  await until(l, 't1', /\]\[.*\]$/s);
  assert.deepEqual(await cmdlinesHolding(sentinel), [], 'no process carries an overlay value in its argv');
  l.send({ type: 'resize', id: 't1', cols: 101, rows: 41 });
  l.send({ type: 'input', id: 't1', dataB64: b64('\n') });
  await until(l, 't1', /41 101/);
  assert.doesNotMatch(l.stderr, /could not be relayed/, `the marker carried a tty the relay could use: ${l.stderr}`);
  l.send({ type: 'close', id: 't1' });
  assert.ok(await settle(async () => (await reaps()).length === 1, 5_000));
  const [reap] = await reaps();
  const seen = /^\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*)\]/s.exec(Buffer.from(outOf(l, 't1'), 'latin1').toString('utf8'));
  assert.ok(seen, outOf(l, 't1'));
  const [, pathSeen, remote, token, term, oddSeen] = seen;
  assert.equal(pathSeen, '/nonexistent', 'the program sees the overlay PATH');
  assert.equal(oddSeen.split(']')[0], odd, 'byte for byte');
  assert.equal(remote, 'alpha', 'CC_REMOTE is the provider\'s binding');
  assert.equal(token, reap.token, 'CC_EXEC_TOKEN is the one the reap uses');
  assert.notEqual(token, 'evil');
  assert.equal(reap.remoteId, 'alpha');
  assert.equal(term, PTY.term, 'TERM is the frame\'s term');
});

// PINS THE HELD REMAINDER's CONTENT: output that crosses the credit edge in the
// middle of a chunk is split there, and what was held is delivered — in order,
// byte for byte — once credit returns. A prefix written on its own first puts
// the edge away from the helper's read boundaries.
test('output crossing the credit edge mid-chunk arrives byte for byte after an ack', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  const body = Buffer.alloc(PTY_WINDOW_BYTES + 40_000);
  for (let i = 0; i < body.length; i++) body[i] = (i * 131 + (i >> 9)) & 0xff;
  await fs.writeFile(path.join(cwd, 'body'), body);
  const prefix = 'P'.repeat(1001);
  open(l, 't1', cwd, ['/bin/sh', '-c', `/usr/bin/stty raw -echo; printf ${prefix}; sleep 0.3; cat body`]);
  const got = () => Buffer.concat(framesOf(l, 't1').filter(f => f.type === 'stdout').map(f => Buffer.from(f.dataB64, 'base64')));
  assert.ok(await settle(() => got().length === PTY_WINDOW_BYTES, 10_000), `the window filled (${got().length})`);
  await barrier(l, cwd);
  assert.equal(got().length, PTY_WINDOW_BYTES, 'and stopped at its edge');
  l.send({ type: 'ack', id: 't1', bytes: PTY_WINDOW_BYTES });
  const expected = Buffer.concat([Buffer.from(prefix), body]);
  assert.ok(await settle(() => got().length >= expected.length, 10_000), `the rest arrived (${got().length})`);
  assert.ok(got().equals(expected), 'every byte, in order, nothing dropped at the edge');
});

// PINS THE INPUT CAP: a peer that sends more than one PTY_INPUT_WINDOW_BYTES the
// helper has not written — here all of it held, before the start — ends that
// terminal EPROTO, id-addressed, and the connection serves on.
test('input past one window unwritten ends the terminal EPROTO, id-addressed', { skip: SKIP }, async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const { l, cwd, reaps } = await rig(t, { env: { CODE_SYSTEM_FAKE_PTY_GATE: path.join(store.dir, 'never') } });
  open(l, 't1', cwd, ['cat']);
  const chunk = Buffer.alloc(64 * 1024, 0x61).toString('base64');
  for (let i = 0; i < 4; i++) l.send({ type: 'input', id: 't1', dataB64: chunk });
  await barrier(l, cwd);
  assert.equal(framesOf(l, 't1').some(f => f.type === 'error'), false, 'exactly one window is within the contract');
  l.send({ type: 'input', id: 't1', dataB64: b64('x') });
  const err = await l.waitFor(f => f.id === 't1' && f.type === 'error');
  assert.equal(err.code, 'EPROTO');
  assert.ok(await settle(async () => (await reaps()).length === 1, 5_000), 'its far side is reaped');
  await barrier(l, cwd);
  assert.equal(l.frames.some(f => f.type === 'error' && !f.id), false, 'the connection is not failed');
});

// PINS that close and shutdown ABANDON an in-flight resize relay: its `stty`
// client is detached, and left alone it outlives the terminal — and the
// launcher — until its own timeout.
for (const how of ['close', 'shutdown']) {
  test(`${how} kills an in-flight resize relay at once`, { skip: SKIP }, async (t) => {
    const store = await tempStore();
    t.after(() => store.cleanup());
    const relayGate = path.join(store.dir, `relay-gate-${how}`);
    const { l, cwd } = await rig(t, { env: { CODE_SYSTEM_FAKE_PTY_RELAY: '1', CODE_SYSTEM_FAKE_RELAY_GATE: relayGate } });
    open(l, 't1', cwd, ['cat']);
    await l.waitFor(f => f.id === 't1' && f.type === 'ptyStarted');
    l.send({ type: 'resize', id: 't1', cols: 90, rows: 30 });
    assert.ok(await settle(async () => (await cmdlinesHolding(relayGate)).length > 0, 5_000), 'the relay is in flight');
    if (how === 'close') l.send({ type: 'close', id: 't1' });
    else { l.closeStdin(); await l.exited; }
    assert.ok(await settle(async () => (await cmdlinesHolding(relayGate)).length === 0, 1_000),
      `the relay is gone: ${await cmdlinesHolding(relayGate)}`);
  });
}

// PINS the reap on a program's own exit: what it left in its session is the
// kind's to take (docker never forwards the hang-up), so the reap runs with the
// marker's session, as it does on close.
test('a program exiting on its own is reaped with its session', { skip: SKIP }, async (t) => {
  const { l, cwd, reaps } = await rig(t);
  open(l, 't1', cwd, ['sh', '-c', 'echo PID=$$; exit 5']);
  const exit = await l.waitFor(f => f.id === 't1' && f.type === 'exit');
  assert.equal(exit.code, 5);
  assert.ok(await settle(async () => (await reaps()).length === 1, 5_000), 'the kind was asked to reap');
  assert.equal((await reaps())[0].sid, /PID=(\d+)/.exec(outOf(l, 't1'))[1]);
});

// PINS THE OVERLAY NAME RULE at the frame: the trampoline `eval`s the blob, so a
// name outside cc's ENV_NAME_RE — a `-`, a leading digit, a `.`, a `;` — is
// refused EPROTO, id-addressed, never sent; an ordinary `_A1` starts.
test('an overlay name outside the identifier rule is EPROTO; _A1 is accepted', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  for (const [i, name] of ['A-B', '1A', 'a.b', 'A;echo X'].entries()) {
    open(l, `n${i}`, cwd, ['true'], { envOverlay: { [name]: 'v' } });
    const f = await l.waitFor(g => g.id === `n${i}` && ['error', 'ptyStarted'].includes(g.type));
    assert.deepEqual([f.type, f.code], ['error', 'EPROTO'], name);
  }
  open(l, 'ok', cwd, ['true'], { envOverlay: { _A1: 'v' } });
  assert.equal((await l.waitFor(g => g.id === 'ok' && ['error', 'ptyStarted'].includes(g.type))).type, 'ptyStarted');
});

// The overlay that makes the blob exactly `bytes` long, given the plumbing the
// launcher appends for remote 'alpha' (a 24-hex token) and PTY.term. Split
// across names so no value reaches the kernel's per-string limit at exec.
function overlayOfBlobSize(bytes) {
  const plumbing = [['CC_REMOTE', 'alpha'], ['CC_EXEC_TOKEN', '0'.repeat(24)], ['TERM', PTY.term]];
  const names = ['CC_BIG_A', 'CC_BIG_B', 'CC_BIG_C'];
  const fixed = overlayBlob([...names.map(n => [n, '']), ...plumbing]).length;
  const room = bytes - fixed;
  const each = Math.floor(room / names.length);
  const sizes = names.map((_, i) => (i === 0 ? room - each * (names.length - 1) : each));
  const overlay = Object.fromEntries(names.map((n, i) => [n, 'v'.repeat(sizes[i])]));
  assert.equal(overlayBlob([...Object.entries(overlay), ...plumbing]).length, bytes, 'the helper sized it right');
  return overlay;
}

// PINS THE BLOB'S CEILING at exactly one PTY_INPUT_WINDOW_BYTES: one byte over
// is EPROTO before anything starts, and a blob at it opens.
test('a blob one byte over PTY_INPUT_WINDOW_BYTES is EPROTO; one exactly at it starts', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t);
  open(l, 'over', cwd, ['true'], { envOverlay: overlayOfBlobSize(PTY_INPUT_WINDOW_BYTES + 1) });
  const over = await l.waitFor(g => g.id === 'over' && ['error', 'ptyStarted'].includes(g.type));
  assert.deepEqual([over.type, over.code], ['error', 'EPROTO']);
  open(l, 'at', cwd, ['true'], { envOverlay: overlayOfBlobSize(PTY_INPUT_WINDOW_BYTES) });
  assert.equal((await l.waitFor(g => g.id === 'at' && ['error', 'ptyStarted'].includes(g.type), { timeoutMs: 20_000 })).type, 'ptyStarted');
});

// PINS that the blob is the LAUNCHER's bytes, not the peer's: a large overlay
// costs cc nothing of its input window. Input held before the start, then more
// once it has started, stays within one window of cc's own bytes and is not
// refused, though with the blob counted in it would be far over.
test('the blob does not count against the peer\'s input window', { skip: SKIP }, async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const gate = path.join(store.dir, 'go');
  const { l, cwd } = await rig(t, { env: { CODE_SYSTEM_FAKE_PTY_GATE: gate } });
  open(l, 't1', cwd, ['sh', '-c', 'stty raw -echo; exec sleep 1000'], { envOverlay: overlayOfBlobSize(200 * 1024) });
  l.send({ type: 'input', id: 't1', dataB64: Buffer.alloc(PTY_INPUT_WINDOW_BYTES - 1000, 0x61).toString('base64') });
  await barrier(l, cwd);
  await fs.writeFile(gate, '');
  await l.waitFor(f => f.id === 't1' && f.type === 'ptyStarted', { timeoutMs: 20_000 });
  l.send({ type: 'input', id: 't1', dataB64: b64('x') });
  await barrier(l, cwd);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(framesOf(l, 't1').some(f => f.type === 'error'), false, JSON.stringify(framesOf(l, 't1').filter(f => f.type === 'error')));
  l.send({ type: 'close', id: 't1' });
});

// PINS ONE REAP PER TERMINAL: a close arriving after the program's own exit
// finds no terminal and reaps nothing a second time.
test('a close after a natural exit does not reap twice', { skip: SKIP }, async (t) => {
  const { l, cwd, reaps } = await rig(t);
  open(l, 't1', cwd, ['true']);
  await l.waitFor(f => f.id === 't1' && f.type === 'exit');
  assert.ok(await settle(async () => (await reaps()).length === 1, 5_000), 'the exit reaped');
  l.send({ type: 'close', id: 't1' });
  await barrier(l, cwd);
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await reaps()).length, 1, 'and the close did not reap again');
});

// PINS THE REAP ON A CLIENT THAT DIES BEFORE STARTED: no session was reported,
// so the far side is reaped by the whole token (sid null) — the trampoline it
// may have left is not the launcher's descendant.
test('a client dying before the start is reaped by the whole token', { skip: SKIP }, async (t) => {
  const { l, cwd, reaps } = await rig(t, { config: { ptyFail: 'down' } });
  open(l, 't1', cwd, ['true']);
  await l.waitFor(f => f.id === 't1' && f.type === 'error');
  assert.ok(await settle(async () => (await reaps()).length === 1, 5_000), 'the kind was asked to reap');
  const [r] = await reaps();
  assert.equal(r.sid, null, 'by the whole token');
  assert.equal(r.remoteId, 'alpha');
});

// PINS THAT NOTHING AFTER `OVERLAY` IS QUOTED: a client that took the blob on a
// tty that echoed it, then died, produces an error carrying no nonce, no
// plumbing and no overlay value.
test('an error after OVERLAY quotes no nonce and no overlay value', { skip: SKIP }, async (t) => {
  const { l, cwd } = await rig(t, { config: { ptyFail: 'afterOverlay' } });
  const secret = `ccsecret${Math.random().toString(16).slice(2)}`;
  open(l, 't1', cwd, ['true'], { envOverlay: { CC_SECRET: secret } });
  const err = await l.waitFor(f => f.id === 't1' && f.type === 'error');
  const text = JSON.stringify(err);
  assert.doesNotMatch(text, new RegExp(secret), 'no overlay value');
  assert.doesNotMatch(text, /CC_EXEC_TOKEN|OVERLAY|[0-9a-f]{24}/, 'no plumbing, no marker, no nonce');
});
