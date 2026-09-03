// PINS PROTOCOL MUST 3: the launcher exits when its stdin closes and takes
// everything it started with it — including the far-side work a kind must reap
// itself, because a `docker exec` child reparents inside the container and cc
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

async function reaped(logPath) {
  try {
    const text = await fs.readFile(logPath, 'utf8');
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The launcher's own `sh -c` children, read from /proc rather than guessed at,
// so "the child is gone" is a measurement.
async function descendantShells(launcherPid) {
  const out = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try { stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8'); } catch { continue; }
    // ppid is field 4, after the comm field which may itself contain spaces.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (ppid === launcherPid) out.push(Number(entry));
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
test('`close` kills the in-flight derived child of a readFile, not just its bookkeeping', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  // A FIFO makes the read block on the far side with no sleep and no wall-clock
  // dependence: opening one for reading blocks until a writer appears, and
  // nobody ever writes. A `length` is required — a FIFO stats as size 0, so an
  // unbounded read computes `want=0` and never opens it at all.
  const fifo = path.join(store.dir, 'blocker');
  await new Promise((resolve, reject) => {
    const c = spawn('mkfifo', [fifo]);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`))));
    c.on('error', reject);
  });

  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
  });
  t.after(() => l.kill());
  await l.hello();

  l.send({ type: 'readFile', id: 'r1', remoteId: 'alpha', path: fifo, length: 10 });
  // The derived `sh -c` is now parked opening the FIFO.
  const running = async () => (await descendantShells(l.pid)).length > 0;
  assert.equal(await settle(running), true, 'the derived child really started');

  l.send({ type: 'close', id: 'r1' });
  assert.equal(await settle(async () => !(await running())), true,
    'close killed the derived child — without the abort handle it would still be parked');

  // And nothing is emitted for a closed id.
  await new Promise(r => setTimeout(r, 150));
  assert.equal(l.frames.some(f => f.id === 'r1'), false,
    'close means cc has stopped listening: no further frames for that id');

  // The connection is still usable.
  l.send({ type: 'exec', id: 'after', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'after')).code, 0);
});

test('shutdown also takes a parked derived child with it', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const fifo = path.join(store.dir, 'blocker2');
  await new Promise((resolve, reject) => {
    const c = spawn('mkfifo', [fifo]);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mkfifo exited ${code}`))));
    c.on('error', reject);
  });
  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
  });
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'readFile', id: 'r1', remoteId: 'alpha', path: fifo, length: 10 });
  assert.equal(await settle(async () => (await descendantShells(l.pid)).length > 0), true);

  const started = Date.now();
  l.closeStdin();
  const { code } = await l.exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 2_000, "inside cc's own shutdown grace");
  assert.equal(await settle(async () => (await descendantShells(l.pid)).length === 0), true,
    'MUST 3 covers a derived file operation too');
});
