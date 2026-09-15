// THE TWO DIAGNOSTIC LINES THE CHANNEL OWES, and the proof that routing is
// invisible on the wire. Driven through the SHIPPED launcher with `--kind fake`
// plus `CODE_SYSTEM_FAKE_CHANNEL=1`, whose channel is this machine's own
// `/bin/sh` — no docker anywhere.
//
// WHY THESE LINES EXIST AT ALL. Admission fails closed, which is safe and
// SILENT: if cc changes one flag in a derivation, that row de-admits, every op
// quietly returns to the per-op spawn, and every test in this repo still passes.
// A live-docker test pins routing at a moment in time, not the ongoing property.
// So the drift line is the ongoing signal, and the census line is the positive
// answer to "was the channel carrying ops".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_TRANSPORT, Launcher, record, tempStore, writeRecord } from './helpers.mjs';

const E = ['env', 'LC_ALL=C'];

function env(storeDir, extra = {}) {
  return {
    CODE_SYSTEM_STORE: storeDir,
    CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
    CODE_SYSTEM_FAKE_CHANNEL: '1',
    ...extra,
  };
}

async function launcher(t, extra = {}) {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const l = new Launcher(['--kind', 'fake'], env(store.dir, extra));
  t.after(() => l.kill());
  await l.hello();
  return l;
}

// A cc derivation, exactly as `execFrame` puts it on the wire.
const derive = (id, argv) => ({
  type: 'exec', id, remoteId: 'alpha', cwd: '/', stdin: 'ignore', argv,
});

const textOf = (frames, id, type = 'stdout') =>
  frames.filter(f => f.type === type && f.id === id)
    .map(f => Buffer.from(f.dataB64, 'base64').toString('utf8')).join('');

// PINS THE DRIFT LINE, and that it is ONE-SHOT. A frame that passes the envelope
// and opens `['env','LC_ALL=C',…]` is a cc derivation by construction, so no row
// matching it is unambiguously cc-side drift — the one thing that can silently
// undo this whole change while every test stays green.
test('a derivation-shaped frame that matches no row warns once, naming the argv and the table', async (t) => {
  const l = await launcher(t);
  // A real `stat` derivation with ONE byte of the format changed: envelope
  // passes, no row matches.
  l.send(derive('d1', [...E, 'stat', '-L', '-c', '%f %s %.6Y', '--', '/tmp']));
  await l.waitFor(f => f.type === 'exit' && f.id === 'd1');
  assert.match(l.stderr, /a derivation-shaped exec matched no admission row/);
  assert.match(l.stderr, /src\/launcher\/admission\.mjs/, 'it names the file to edit');
  assert.match(l.stderr, /%\.6Y/, 'and quotes the argv that drifted');

  // A SECOND one says nothing further: this is a signal, not a log.
  l.send(derive('d2', [...E, 'stat', '-L', '-c', '%f %s %.9Y', '--', '/tmp']));
  await l.waitFor(f => f.type === 'exit' && f.id === 'd2');
  assert.equal(l.stderr.match(/matched no admission row/g).length, 1, 'exactly one line, ever');
});

// PINS that the signal is DRIFT and not "something was refused". Ordinary user
// commands are refused on every frame; warning about them would bury the one
// line that matters.
test('an ordinary user command emits no drift line', async (t) => {
  const l = await launcher(t);
  l.send({ type: 'exec', id: 'u1', remoteId: 'alpha', cwd: '/tmp', shell: 'printf shell' });
  await l.waitFor(f => f.type === 'exit' && f.id === 'u1');
  l.send({ type: 'exec', id: 'u2', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'git'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'u2');
  // And a DELIBERATE exclusion is not drift either — `removeTree` is refused by
  // name, for a reason a warning would only obscure.
  l.send(derive('u3', [...E, 'rm', '-rf', '--', '/tmp/does-not-exist-code-system']));
  await l.waitFor(f => f.type === 'exit' && f.id === 'u3');
  assert.equal(l.stderr.includes('matched no admission row'), false, `stderr was: ${l.stderr}`);
});

// PINS THE CENSUS LINE: the positive answer to "was the channel carrying ops",
// emitted once at shutdown beside the reap warnings already there.
test('shutdown reports what the channel carried, of what it was offered, on how many channels', async (t) => {
  const l = await launcher(t);
  // Enough admitted ops that the lazy open has served at least one of them.
  for (let i = 0; i < 12; i++) {
    l.send(derive(`c${i}`, [...E, 'realpath', '-e', '--', '/tmp']));
    await l.waitFor(f => f.type === 'exit' && f.id === `c${i}`);
  }
  l.closeStdin();
  await l.exited;
  const m = /channel carried (\d+) of (\d+) admitted ops on (\d+) channels/.exec(l.stderr);
  assert.ok(m, `no census line in stderr: ${l.stderr}`);
  const [, carried, admitted, channels] = m.map(Number);
  assert.equal(admitted, 12, 'every admitted frame was offered to the pool');
  assert.ok(carried > 0, `the channel really carried ops: ${m[0]}`);
  assert.ok(carried < admitted, 'and the ops that found nothing idle are still counted as offered');
  assert.ok(channels >= 1, `a channel opened: ${m[0]}`);
});

// PINS THE KILL SWITCH end to end: with `CODE_SYSTEM_CHANNEL=0` there is no pool
// at all, so no census line is emitted and nothing rides a channel. This is the
// conformance suite's off arm — it has to be today's code path, not a variant.
test('CODE_SYSTEM_CHANNEL=0 removes the pool entirely', async (t) => {
  const l = await launcher(t, { CODE_SYSTEM_CHANNEL: '0' });
  for (let i = 0; i < 4; i++) {
    l.send(derive(`z${i}`, [...E, 'realpath', '-e', '--', '/tmp']));
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === `z${i}`);
    assert.equal(exit.code, 0);
  }
  l.closeStdin();
  await l.exited;
  assert.equal(l.stderr.includes('channel carried'), false,
    `a disabled channel reports nothing: ${l.stderr}`);
});

// PINS THAT ROUTING IS INVISIBLE ON THE WIRE. An admitted derivation and a
// refused one must produce the same frame types, the same decoded streams and
// the same `exit` — otherwise cc can tell which path an op took, and this change
// is no longer a pure transport optimisation.
test('an admitted frame and a refused frame answer identically', async (t) => {
  const l = await launcher(t);
  // Warm the pool so the admitted frame really rides a channel, then run the
  // SAME command both ways: `realpath -e -- /tmp` is a table row; the identical
  // command with a non-placeholder cwd is refused at the envelope.
  for (let i = 0; i < 6; i++) {
    l.send(derive(`w${i}`, [...E, 'realpath', '-e', '--', '/tmp']));
    await l.waitFor(f => f.type === 'exit' && f.id === `w${i}`);
  }
  l.send(derive('onchan', [...E, 'realpath', '-e', '--', '/tmp']));
  const a = await l.waitFor(f => f.type === 'exit' && f.id === 'onchan');
  l.send({ ...derive('offchan', [...E, 'realpath', '-e', '--', '/tmp']), cwd: '/tmp' });
  const b = await l.waitFor(f => f.type === 'exit' && f.id === 'offchan');

  assert.equal(textOf(l.frames, 'onchan'), textOf(l.frames, 'offchan'));
  assert.equal(textOf(l.frames, 'onchan'), '/tmp\n');
  assert.equal(textOf(l.frames, 'onchan', 'stderr'), textOf(l.frames, 'offchan', 'stderr'));
  assert.deepEqual({ ...a, id: null }, { ...b, id: null }, 'the exit frames match field for field');

  // AND A FAILURE ANSWERS IDENTICALLY TOO — the exit code and the stderr a
  // caller branches on, not just the happy path.
  const missing = '/tmp/code-system-no-such-path-2026-0021';
  l.send(derive('failon', [...E, 'realpath', '-e', '--', missing]));
  const fa = await l.waitFor(f => f.type === 'exit' && f.id === 'failon');
  l.send({ ...derive('failoff', [...E, 'realpath', '-e', '--', missing]), cwd: '/tmp' });
  const fb = await l.waitFor(f => f.type === 'exit' && f.id === 'failoff');
  assert.equal(fa.code, fb.code);
  assert.notEqual(fa.code, 0);
  assert.equal(textOf(l.frames, 'failon', 'stderr'), textOf(l.frames, 'failoff', 'stderr'));
  assert.match(textOf(l.frames, 'failon', 'stderr'), /No such file or directory/);
});

// PINS that cc's LIVENESS PROBE row reaches the channel through the shipped
// launcher. It is the one table row with no `env LC_ALL=C` prefix, so a matcher
// that keyed on that prefix rather than on the whole vector would silently drop
// it — and on the channel it resolves to the shell's BUILTIN `true`, which is
// strictly more robust than exec'ing coreutils.
//
// (The channel's own `CC_REMOTE` routing evidence is pinned where it is
// observable: `channelPlan`'s argv, in tests/dockerkind.test.mjs.)
test('the liveness probe rides the channel', async (t) => {
  const l = await launcher(t);
  for (let i = 0; i < 12; i++) {
    l.send({ type: 'exec', id: `p${i}`, remoteId: 'alpha', cwd: '/', stdin: 'ignore', argv: ['true'] });
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === `p${i}`);
    assert.equal(exit.code, 0);
  }
  l.closeStdin();
  await l.exited;
  const m = /channel carried (\d+) of/.exec(l.stderr);
  assert.ok(m && Number(m[1]) > 0, `the probe rode the channel: ${l.stderr}`);
});
