// THE LIVE TERMINAL ROWS, shared by tests/docker-live.test.mjs and
// tests/ssh-live.test.mjs. ROWS, NOT TESTS: each entry file registers them on its
// own roster with a context that knows how to reach its target, so the same
// bodies pin the same terminal behaviour through the shipped launcher on both
// transports.
//
// A context is:
//   l            a Launcher for the kind, already past its hello
//   remoteId     the record it routes to
//   count(m)     how many target processes carry marker `m` in their cmdline
//   clean(ms)    kill anything still carrying those markers when the test ends
//   marker()     a fresh marker
//   t            the test context

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { settle } from './dockerFixture.mjs';

// Live processes on cc's host whose argv holds `needle`: the helper and the
// docker or ssh client run here.
async function hostCmdlinesHolding(needle) {
  const hits = [];
  for (const pid of await fs.readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    const cmd = await fs.readFile(`/proc/${pid}/cmdline`, 'latin1').catch(() => '');
    if (cmd.includes(needle)) hits.push(`${pid}: ${cmd.replace(/\0/g, ' ').slice(0, 200)}`);
  }
  return hits;
}

export const PTY = { cols: 80, rows: 24, term: 'xterm-256color' };
const CWD = '/tmp';

export const framesOf = (l, id) => l.frames.filter(f => f.id === id);
export const outOf = (l, id) => Buffer.concat(framesOf(l, id).filter(f => f.type === 'stdout')
  .map(f => Buffer.from(f.dataB64, 'base64')));
export const creditedOf = (l, id) => framesOf(l, id).filter(f => f.type === 'inputAck').reduce((n, f) => n + f.bytes, 0);

export async function until(l, id, re, timeoutMs = 15_000) {
  const ok = await settle(() => re.test(outOf(l, id).toString('latin1')), timeoutMs);
  assert.ok(ok, `no ${re} on ${id}: ${JSON.stringify(outOf(l, id).toString('latin1').slice(-400))}`);
  return re.exec(outOf(l, id).toString('latin1'));
}

export function openTerminal(ctx, id, argv, over = {}) {
  ctx.l.send({
    type: 'exec', id, remoteId: ctx.remoteId, cwd: CWD, ...(argv ? { argv } : {}), pty: { ...PTY, ...over },
  });
}

export const type = (ctx, id, s) => ctx.l.send({ type: 'input', id, dataB64: Buffer.from(s, 'latin1').toString('base64') });

export const PTY_LIVE_ROWS = [];
const row = (name, fn) => PTY_LIVE_ROWS.push({ name, fn });

// PINS the round trip and the in-band interrupt: keystrokes reach the far
// program and its output comes back; `^C` is SIGINT to the far foreground job
// and its exit code is the terminal's.
row('pty: keystrokes echo through cat, and ^C reaches the far program', async (ctx) => {
  const { l } = ctx;
  openTerminal(ctx, 'c1', ['cat']);
  await l.waitFor(f => f.id === 'c1' && f.type === 'ptyStarted', { timeoutMs: 15_000 });
  type(ctx, 'c1', 'hello-cat\n');
  await until(l, 'c1', /hello-cat\r\nhello-cat\r\n/);
  type(ctx, 'c1', '\x04');
  assert.equal((await l.waitFor(f => f.id === 'c1' && f.type === 'exit', { timeoutMs: 15_000 })).code, 0);

  openTerminal(ctx, 'c2', ['sh', '-c', 'trap "echo GOT_INT; exit 3" INT; echo READY; while :; do sleep 0.05; done']);
  await until(l, 'c2', /READY/);
  type(ctx, 'c2', '\x03');
  await until(l, 'c2', /GOT_INT/);
  const exit = await l.waitFor(f => f.id === 'c2' && f.type === 'exit', { timeoutMs: 15_000 });
  assert.deepEqual([exit.code, exit.signal, exit.timedOut], [3, null, false]);
});

// PINS the resize relay: input sent the moment after a resize is read by the
// program at the NEW size. Without the relay docker lost this 197/200 and the
// ssh mux 18/200 (measured); a stale size is printed once and the new one never.
row('pty: input right after a resize sees the new size, 20 times running', async (ctx) => {
  const { l } = ctx;
  openTerminal(ctx, 'r1', ['sh', '-c', 'while read x; do stty size; done']);
  await l.waitFor(f => f.id === 'r1' && f.type === 'ptyStarted', { timeoutMs: 15_000 });
  for (let i = 1; i <= 20; i++) {
    l.send({ type: 'resize', id: 'r1', cols: 80 + i, rows: 24 + i });
    type(ctx, 'r1', '\n');
    await until(l, 'r1', new RegExp(`^${24 + i} ${80 + i}\\r$`, 'm'));
  }
  l.send({ type: 'close', id: 'r1' });
});

// PINS close's reach on the target (§5): the program and the job it put in the
// background die; a job that left the session with `setsid` survives.
row('pty: close kills the far program and its background job, and spares a setsid job', async (ctx) => {
  const { l } = ctx;
  const bg = ctx.marker();
  const away = ctx.marker();
  ctx.clean([bg, away]);
  openTerminal(ctx, 'k1', ['sh', '-c', `sleep ${bg} & setsid sleep ${away} & echo READY; wait`]);
  await until(l, 'k1', /READY/);
  // The negative control: three carry each marker — the trampoline and the
  // program (whose argv both name it) and the job itself.
  assert.ok(await settle(async () => (await ctx.count(bg)) === 3 && (await ctx.count(away)) === 3, 10_000),
    `running before the close: ${await ctx.count(bg)} / ${await ctx.count(away)}`);
  l.send({ type: 'close', id: 'k1' });
  assert.ok(await settle(async () => (await ctx.count(bg)) === 0, 10_000), `the program and its job are gone (${await ctx.count(bg)})`);
  assert.equal(await ctx.count(away), 1, 'the setsid job survives');
});

// PINS MUST 3 for a terminal: the launcher's stdin closing takes the far
// program with it, inside cc's shutdown grace.
row('pty: stdin EOF to the launcher reaps an open terminal on the target', async (ctx) => {
  const { l } = ctx;
  const m = ctx.marker();
  ctx.clean([m]);
  openTerminal(ctx, 'e1', ['sh', '-c', `sleep ${m} & echo READY; wait`]);
  await until(l, 'e1', /READY/);
  // The trampoline, the program and the job.
  assert.ok(await settle(async () => (await ctx.count(m)) === 3, 10_000), `running before the EOF (${await ctx.count(m)})`);
  l.closeStdin();
  await l.exited;
  assert.ok(await settle(async () => (await ctx.count(m)) === 0, 5_000), `gone after the EOF (${await ctx.count(m)})`);
});

// PINS that the program's exit is the terminal's, and that nothing the
// transport prints at the end — ssh's "Connection to … closed." — reaches it.
row('pty: the exit code is the program\'s and no transport chatter follows its output', async (ctx) => {
  const { l } = ctx;
  openTerminal(ctx, 'x1', ['sh', '-c', 'echo hi; exit 7']);
  const exit = await l.waitFor(f => f.id === 'x1' && f.type === 'exit', { timeoutMs: 15_000 });
  assert.equal(exit.code, 7);
  assert.equal(outOf(l, 'x1').toString('latin1'), 'hi\r\n');
  assert.equal(framesOf(l, 'x1')[0].type, 'ptyStarted');
});

// PINS the quoting surface end to end: argv words and an overlay value come out
// of the far side byte-exact, and TERM is the frame's.
row('pty: argv and overlay values arrive byte-exact, and TERM is the frame\'s', async (ctx) => {
  const { l } = ctx;
  const values = ['a file with spaces', 'two\nlines', 'hello — héllo', "it's", '$HOME', '*'];
  const overlay = "q 'v' $HOME\n*";
  openTerminal(ctx, 'q1', ['/bin/sh', '-c', 'stty -opost; printf "%s\\0" "$@" "$CC_Q" "$TERM"', 'sh', ...values],
    { envOverlay: { CC_Q: overlay, TERM: 'dumb' } });
  const exit = await l.waitFor(f => f.id === 'q1' && f.type === 'exit', { timeoutMs: 15_000 });
  assert.equal(exit.code, 0);
  assert.deepEqual(outOf(l, 'q1').toString('utf8').split('\0').slice(0, -1), [...values, overlay, PTY.term]);
});

// PINS THE OVERLAY ON A REAL TRANSPORT: while the terminal is open, no process
// on cc's host (helper, client) or on the target (trampoline, program) carries
// an overlay value in its argv; the program gets the value byte for byte, a
// PATH that resolves nothing does not stop the trampoline, and the plumbing
// and TERM beat the overlay.
row('pty: the overlay is in no argv on either side, and reaches the program exactly', async (ctx) => {
  const { l } = ctx;
  const sentinel = `ccsentinel${Math.random().toString(16).slice(2)}`;
  const odd = `${sentinel} 'q' $HOME\n`;
  openTerminal(ctx, 'o1', ['/bin/sh', '-c',
    '/usr/bin/stty -opost; printf "[%s]" "$PATH" "$CC_REMOTE" "$CC_EXEC_TOKEN" "$TERM" "$CC_ODD"; read x'],
  { envOverlay: { PATH: '/nonexistent', CC_REMOTE: 'evil', CC_EXEC_TOKEN: 'evil', TERM: 'dumb', CC_ODD: odd } });
  await until(l, 'o1', /\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]/s);
  assert.deepEqual(await hostCmdlinesHolding(sentinel), [], 'no argv on cc\'s host');
  assert.equal(await ctx.count(sentinel), 0, 'no argv on the target');
  const [, p, remote, token, term, got] = /\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]\[(.*?)\]/s.exec(outOf(ctx.l, 'o1').toString('utf8'));
  assert.deepEqual([p, remote, term, got], ['/nonexistent', ctx.remoteId, PTY.term, odd]);
  assert.match(token, /^[0-9a-f]{24}$/, 'the provider\'s own token, not the overlay\'s');
  l.send({ type: 'close', id: 'o1' });
});

// PINS the reap on a program's own exit: a job it left in its session goes
// with it, as it would under a local terminal — which docker, never forwarding
// the hang-up (measured), needs the reap for.
row('pty: a program that exits takes the job it left in its session with it', async (ctx) => {
  const { l } = ctx;
  const m = ctx.marker();
  ctx.clean([m]);
  openTerminal(ctx, 'j1', ['sh', '-c', `sleep ${m} & echo READY; read x; exit 0`]);
  await until(l, 'j1', /READY/);
  // The trampoline, the program and the job.
  assert.ok(await settle(async () => (await ctx.count(m)) === 3, 10_000), `running before the exit (${await ctx.count(m)})`);
  type(ctx, 'j1', '\n');
  assert.equal((await l.waitFor(f => f.id === 'j1' && f.type === 'exit', { timeoutMs: 15_000 })).code, 0);
  assert.ok(await settle(async () => (await ctx.count(m)) === 0, 10_000), `the job is gone (${await ctx.count(m)})`);
});
