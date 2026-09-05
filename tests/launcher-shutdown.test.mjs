// PINS PROTOCOL MUST 3: the launcher exits when its stdin closes and takes
// everything it started with it — including the far-side work a kind must reap
// itself, because a `docker exec` child is not the provider's OS descendant and cc
// has no way to clean up after a provider that does not do this.
//
// Asserted on the fake Transport's RECORDED reap calls, so it holds for a kind
// whose children are not our OS descendants without standing up a container.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FAKE_TRANSPORT, Launcher, record, tempStore, writeRecord } from './helpers.mjs';

function mkfifo(p) {
  return new Promise((resolve, reject) => {
    const c = spawn('mkfifo', [p]);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`))));
    c.on('error', reject);
  });
}

async function reaped(logPath) {
  try {
    const text = await fs.readFile(logPath, 'utf8');
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// /proc/<pid>/stat, past the comm field (which may itself contain spaces):
// [0]=state [1]=ppid [2]=pgrp.
async function statFields(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch { return null; }
}

async function pids() {
  return (await fs.readdir('/proc')).filter(e => /^\d+$/.test(e)).map(Number);
}

// The launcher's own direct children.
async function descendantShells(launcherPid) {
  const out = [];
  for (const pid of await pids()) {
    const f = await statFields(pid);
    if (f && Number(f[1]) === launcherPid) out.push(pid);
  }
  return out;
}

async function processesMentioning(needle) {
  const out = [];
  for (const pid of await pids()) {
    let cmd;
    try { cmd = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (cmd.includes(needle)) out.push(pid);
  }
  return out;
}

// EVERY member of a process group, which is what a cancellation actually has to
// clear. Measuring only direct children is what let the earlier version of
// these tests pass while orphaning a whole `tail | head | base64 | tr` pipeline:
// killing `sh` reparents its grandchildren to PID 1, which moves them OUT of a
// ppid query and makes the leak invisible to the test that caused it.
async function processesInGroup(pgid) {
  const out = [];
  for (const pid of await pids()) {
    const f = await statFields(pid);
    if (f && Number(f[2]) === pgid) out.push(pid);
  }
  return out;
}

async function settle(pred, ms = 3_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return pred();
}

async function threeLive(t) {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const reapLog = path.join(store.dir, 'reaps.jsonl');
  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
    CODE_SYSTEM_FAKE_REAP_LOG: reapLog,
  });
  t.after(() => l.kill());
  await l.hello();
  for (const id of ['a', 'b', 'c']) {
    l.send({ type: 'exec', id, remoteId: 'alpha', cwd: '/tmp', argv: ['sleep', '30'] });
  }
  // A DETERMINISTIC BARRIER, not a sleep: frames are handled in arrival order,
  // so this one's exit proves the three sleeps were already spawned. Without it
  // the test could pass by reaping nothing.
  l.send({ type: 'exec', id: 'barrier', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier');
  return { l, reapLog, store };
}

test('stdin EOF reaps EVERY live exec and exits 0 inside the deadline', async (t) => {
  const { l, reapLog } = await threeLive(t);
  const started = Date.now();
  l.closeStdin();
  const { code } = await l.exited;
  assert.equal(code, 0, 'a provider exits when its stdin closes');
  assert.ok(Date.now() - started < 2_000,
    "reaping must finish inside cc's own 2000ms shutdown grace, or cc SIGKILLs us mid-reap");
  const calls = await reaped(reapLog);
  assert.equal(calls.length, 3, 'all three live ids were reaped');
  assert.deepEqual(calls.map(c => c.remoteId), ['alpha', 'alpha', 'alpha']);
  for (const c of calls) {
    assert.equal(typeof c.pid, 'number', 'the kind is handed the host child pid');
    assert.match(c.token, /^[0-9a-f]{24}$/, 'and the per-exec token it injected into the far side');
  }
});

test('SIGTERM takes the same shutdown path', async (t) => {
  const { l, reapLog } = await threeLive(t);
  l.kill('SIGTERM');
  const { code } = await l.exited;
  assert.equal(code, 0);
  assert.equal((await reaped(reapLog)).length, 3);
});

test('`close` on one id reaps THAT id, emits nothing further for it, and leaves the others', async (t) => {
  const { l, reapLog } = await threeLive(t);
  l.send({ type: 'close', id: 'b' });
  await settle(async () => (await reaped(reapLog)).length >= 1);

  const calls = await reaped(reapLog);
  assert.equal(calls.length, 1, 'exactly the closed id was reaped');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(l.frames.some(f => f.id === 'b'), false,
    'close means cc has stopped listening: NO further frames for that id');
  assert.equal(l.frames.some(f => f.id === 'a' || f.id === 'c'), false,
    'and the other two ids were untouched');

  // The other two are still live, and shutting down still reaps them.
  l.closeStdin();
  await l.exited;
  assert.equal((await reaped(reapLog)).length, 3, 'the remaining two were reaped at shutdown');
});

// ── `detach`: the exact opposite of `close` (systems-protocol.md §5) ──

// A command that BACKGROUNDS a job and then keeps talking. The `sleep 30` is the
// survivor `detach` exists to spare; the tick loop is what makes "no further
// frames for that id" observable instead of vacuous.
//
// The shell records its OWN pid too, because the fake kind plans
// `detached: true` — so that pid LEADS the group, and since a detached exec is
// deliberately outside every kill path in this file, the group kill registered
// below is the only thing that cleans it up.
const DEADLINE_MS = 1_500;

async function detachable(t, { timeoutMs } = {}) {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const reapLog = path.join(store.dir, 'reaps.jsonl');
  const shellPidFile = path.join(store.dir, 'shell.pid');
  const jobPidFile = path.join(store.dir, 'job.pid');
  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
    CODE_SYSTEM_FAKE_REAP_LOG: reapLog,
  });
  t.after(() => l.kill());
  await l.hello();
  const sentAt = Date.now();
  l.send({
    type: 'exec', id: 'd', remoteId: 'alpha', cwd: '/tmp',
    shell: `echo $$ > ${shellPidFile}; sleep 30 >/dev/null 2>&1 & echo $! > ${jobPidFile};`
      + ' while :; do echo tick; sleep 0.05; done',
    killGraceMs: 100,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  });
  const readPid = async (p) => Number((await fs.readFile(p, 'utf8').catch(() => '')).trim());
  await settle(async () => (await readPid(jobPidFile)) > 0);
  const jobPid = await readPid(jobPidFile);
  const shellPid = await readPid(shellPidFile);
  assert.ok(jobPid > 0 && shellPid > 0, 'the command recorded its own pid and its background job pid');
  t.after(() => {
    for (const p of [-shellPid, jobPid]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  });
  // Positive proof the stream is FLOWING before we detach, so "nothing further
  // arrived" cannot pass by nothing ever having arrived.
  await l.waitFor(f => f.type === 'stdout' && f.id === 'd');
  return { l, reapLog, jobPid, shellPid, sentAt, since: (ms) => new Promise(r => setTimeout(r, Math.max(0, sentAt + ms - Date.now()))) };
}

// PINS §5's `detach`: the operation ends and nothing is killed, even with a
// deadline armed and expiring inside the test. The deadline is what makes an
// ignored detach VISIBLE at all — a provider that drops the frame keeps the id
// open with its timer running, and that timer is what terminates the command and
// reaps the background job cc told it to leave alone (§1 MUST 5; §5's "cc cannot
// detect that" is why this test exists locally rather than only in cc's battery).
//
// It does NOT pin the `clearTimeout` calls in `#detach`: `state.closed` already
// makes an expired timer a no-op, so those lines are hygiene and are commented
// as such at the source. The claim here is the observable one — the deadline
// passes and neither reports nor kills.
test('`detach` ends the id and kills nothing — an expired deadline included', async (t) => {
  const { l, reapLog, jobPid, sentAt, since } = await detachable(t, { timeoutMs: DEADLINE_MS });
  assert.ok(Date.now() - sentAt < 700,
    'the fixture must settle well inside the armed deadline, or this test measures nothing');
  l.send({ type: 'detach', id: 'd' });

  // Snapshot BEFORE the deadline: a tick already in flight when the detach was
  // handled is allowed to land. What must not happen is any frame after this.
  await since(900);
  const settled = l.frames.filter(f => f.id === 'd').length;
  assert.ok(settled > 0, 'the id really was streaming');
  // Well past the deadline and the 100 ms SIGKILL grace behind it.
  await since(DEADLINE_MS + 400);

  assert.equal(l.frames.filter(f => f.id === 'd').length, settled,
    'no further frames for a detached id: the ticks stopped and the expired deadline said nothing');
  assert.equal(l.frames.some(f => (f.type === 'exit' || f.type === 'error') && f.id === 'd'), false,
    'the id did NOT terminate in a frame of ours — cc ended it with detach (MUST 5)');
  assert.equal(alive(jobPid), true,
    'the backgrounded job outlives its command, as a local shell job would');
  assert.deepEqual(await reaped(reapLog), [],
    'detach signals nothing and reaps nothing — that is the whole content of the frame');
});

// PINS THE MUST 3 CARVE-OUT, which cc's own battery cannot reach: MUST 3's exit
// reap covers operations still OPEN, and a detached exec is closed (§1 MUST 3,
// §11 item 1). The mechanism is `#execs.delete(id)` in `Session.#detach`, since
// `shutdown()` iterates `#execs` — so a future "reap everything we ever spawned"
// refactor breaks exactly here.
test('a detached exec is OUT of MUST 3\'s exit reap', async (t) => {
  const { l, reapLog, jobPid } = await detachable(t);
  l.send({ type: 'detach', id: 'd' });
  // A barrier, not a sleep: this exit proves the detach above was processed.
  l.send({ type: 'exec', id: 'barrier', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier');

  l.closeStdin();
  assert.equal((await l.exited).code, 0, 'the provider still exits cleanly on stdin EOF');
  assert.deepEqual(await reaped(reapLog), [],
    'shutdown reaped nothing: the detached id had already left the bookkeeping MUST 3 iterates');
  assert.equal(await settle(async () => alive(jobPid), 500), true,
    'and the background job survived the provider, exactly as a detached local one does');
});

// THE CONTRAST WITH `close`, which reaps THAT id (test above): detach reaps
// nothing, and neither frame may touch the other live ids.
test('`detach` on one id reaps nothing and leaves the other ids reapable at shutdown', async (t) => {
  const { l, reapLog } = await threeLive(t);
  l.send({ type: 'detach', id: 'b' });
  l.send({ type: 'exec', id: 'barrier2', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier2');
  assert.deepEqual(await reaped(reapLog), [], 'detach reaped nothing — unlike close');

  // The detached id survives shutdown BY DESIGN, so this test has to clean it
  // up itself: capture the launcher's children while it still has them.
  const children = await descendantShells(l.pid);
  t.after(() => { for (const p of children) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } });

  l.closeStdin();
  await l.exited;
  assert.equal((await reaped(reapLog)).length, 2,
    'the two ids cc did NOT detach were still reaped at exit');
  assert.equal(l.frames.some(f => f.id === 'b'), false,
    'and nothing further was emitted for the detached id');
});

test('the host-side child really dies — the group goes, not just the direct child', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const pidFile = path.join(store.dir, 'grandchild.pid');
  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
  });
  t.after(() => l.kill());
  await l.hello();
  l.send({
    type: 'exec', id: 'g', remoteId: 'alpha', cwd: '/tmp',
    shell: `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; wait`,
  });
  await settle(async () => !!(await fs.readFile(pidFile, 'utf8').catch(() => '')).trim());
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.ok(pid > 0, 'the grandchild recorded its pid');
  try {
    l.closeStdin();
    await l.exited;
    assert.equal(await settle(async () => !alive(pid)), true,
      'shutdown killed the whole process group, not just the direct child');
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

// PINS THAT `close` REACHES A DERIVED FILE OPERATION. §5 is explicit — close
// means "kill the command (hard)" — and cc's readFile/writeFile backstop works
// BY sending close, so this is the one place its kill instruction could be
// ignored. The body runs detached (so one round trip does not serialise every
// other id), which is exactly why dropping bookkeeping alone is not enough:
// without a kill handle the far-side `sh -c` keeps running, and on docker/ssh
// it becomes a process nobody reaps.
test('`close` kills the WHOLE derived pipeline of a readFile, and reaps it', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const reapLog = path.join(store.dir, 'reaps.jsonl');
  // A FIFO makes the read block on the far side with no sleep and no wall-clock
  // dependence: opening one for reading blocks until a writer appears, and
  // nobody ever writes. A `length` is required — a FIFO stats as size 0, so an
  // unbounded read computes `want=0` and never opens it at all.
  const fifo = path.join(store.dir, 'blocker');
  await mkfifo(fifo);

  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
    CODE_SYSTEM_FAKE_REAP_LOG: reapLog,
  });
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'readFile', id: 'r1', remoteId: 'alpha', path: fifo, length: 10 });
  assert.equal(await settle(async () => (await processesMentioning(fifo)).length > 0), true,
    'the derived child really started');

  // Capture the GROUP while it is alive — after the kill there is nothing left
  // mentioning the fifo to find it by.
  const [shPid] = await descendantShells(l.pid);
  assert.ok(shPid, 'the launcher has a direct sh child');
  const pgid = Number((await statFields(shPid))[2]);
  assert.equal(pgid, shPid, 'the runner spawns detached, so the shell LEADS its own group');
  const before = await processesInGroup(pgid);
  assert.ok(before.length >= 3,
    `a real pipeline is running, not just a shell (saw ${before.length} members)`);

  l.send({ type: 'close', id: 'r1' });
  assert.equal(await settle(async () => (await processesInGroup(pgid)).length === 0), true,
    'close killed every member of the pipeline, not just the direct child');
  assert.deepEqual(await processesMentioning(fifo), [], 'and nothing is left blocked on the fifo');

  // The kind gets its chance to clean up the far side, exactly as for an exec.
  const calls = await reaped(reapLog);
  assert.equal(calls.length, 1, 'a cancelled file operation is reaped too');
  assert.equal(calls[0].remoteId, 'alpha');
  assert.equal(typeof calls[0].pid, 'number', 'reap is handed the real child pid, not a placeholder');

  await new Promise(r => setTimeout(r, 150));
  assert.equal(l.frames.some(f => f.id === 'r1'), false,
    'close means cc has stopped listening: no further frames for that id');

  l.send({ type: 'exec', id: 'after', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'after')).code, 0);
});

test('shutdown takes the whole parked pipeline with it, and reaps it', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const reapLog = path.join(store.dir, 'reaps.jsonl');
  const fifo = path.join(store.dir, 'blocker2');
  await mkfifo(fifo);
  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
    CODE_SYSTEM_FAKE_REAP_LOG: reapLog,
  });
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'readFile', id: 'r1', remoteId: 'alpha', path: fifo, length: 10 });
  assert.equal(await settle(async () => (await processesMentioning(fifo)).length > 0), true);

  const [shPid] = await descendantShells(l.pid);
  const pgid = Number((await statFields(shPid))[2]);
  assert.ok((await processesInGroup(pgid)).length >= 3);

  const started = Date.now();
  l.closeStdin();
  const { code } = await l.exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 2_000, "inside cc's own shutdown grace");
  assert.equal(await settle(async () => (await processesInGroup(pgid)).length === 0), true,
    'MUST 3 covers a derived file operation, pipeline members included');
  assert.deepEqual(await processesMentioning(fifo), []);
  assert.equal((await reaped(reapLog)).length, 1, 'and it was reaped');
});
