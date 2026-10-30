// THE SSH TRANSPORT AGAINST A REAL SSHD.
//
// Every test here is registered from a ROSTER and calls `skipUnlessSsh` first,
// so `npm test` stays green with no daemon and each skip prints a reason naming
// both halves of the gate. On a host where both answer, they run for real.
//
//   npm test                                              # skips, loudly
//   CODE_SYSTEM_DOCKER='["sudo","-n","docker"]' npm test    # runs
//
// THE ROSTER IS PROVED TO HAVE RUN, BY COUNT, IN BOTH DIRECTIONS — the last
// test in this file. tests/dockerkind.test.mjs states outright that no skip
// count is asserted anywhere in the docker suite; that is the gap this closes,
// because a live suite that silently skips everything while `npm test` stays
// green is indistinguishable from one that passes.
//
// THE FIXTURES BUILD IMAGES, RUN CONTAINERS AND GENERATE KEYS; THE PROVIDER
// NEVER DOES. It is attach-only and never mutates the remote host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { controlPathFor, createSshTransport } from '../src/launcher/kinds/ssh.mjs';
import { buildReapScript } from '../src/launcher/kinds/reapscript.mjs';
import { PROBE_SCRIPT, parseProbeOutput } from '../src/baseline.mjs';
import { makeRunner } from '../src/launcher/run.mjs';
import { SCHEMA } from '../src/store.mjs';
import { Launcher, tempStore, writeRecord } from './helpers.mjs';
import { PTY_INPUT_WINDOW_BYTES } from '../src/launcher/protocol.mjs';
import { PTY_LIVE_ROWS, creditedOf, framesOf, openTerminal, until } from './ptyLiveRows.mjs';
import {
  authCount, controlPathProcs, inTarget, markerCount, resolveSshGate, run, settle, skipUnlessSsh,
  tempDir, withSshTarget, writeSshConfig,
} from './sshFixture.mjs';

function sshRecord(remoteId, host, over = {}) {
  return {
    schema: SCHEMA,
    remoteId,
    kind: 'ssh',
    label: remoteId,
    config: { host, user: 'root' },
    enabled: true,
    baseline: { state: 'unknown', fingerprint: null, missing: [], checkedAt: null },
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    ...over,
  };
}

function textOf(frames, id, type = 'stdout') {
  return frames.filter(f => f.type === type && f.id === id)
    .map(f => Buffer.from(f.dataB64, 'base64').toString('utf8')).join('');
}

function bytesOf(frames, id) {
  return Buffer.concat(frames.filter(f => f.type === 'data' && f.id === id)
    .map(f => Buffer.from(f.dataB64, 'base64')));
}

// A distinctive `sleep` duration, so BOTH the remote shell and its `sleep`
// child carry it in /proc/<pid>/cmdline. Fresh per use, so two tests against
// the same target cannot see each other's processes.
let markerSeq = 0;
const newMarker = () => String(760000000 + (process.pid % 10000) * 1000 + markerSeq++);

function launcherFor(t, store, sshEnv, extraEnv = {}) {
  const l = new Launcher(['--kind', 'ssh'], {
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_SSH: sshEnv,
    ...extraEnv,
  });
  t.after(() => l.kill());
  return l;
}

/** A store holding one record for `target`, cleaned up however the test ends. */
async function storeFor(t, target, remoteId = 'alpha') {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, sshRecord(remoteId, target.alias));
  return store;
}

// Kill anything still carrying these markers on the target, however the test
// ends — a leaked `sleep` would poison a later test's count.
function cleanMarkers(t, cli, name, markers) {
  t.after(() => inTarget(cli, name,
    'for p in /proc/[0-9]*; do c=$(tr \'\\0\' \' \' < "$p/cmdline" 2>/dev/null); for m in $CC_MARKERS; do'
    + ' case "$c" in *"$m"*) kill -9 "${p#/proc/}" 2>/dev/null ;; esac; done; done; true',
    { env: { CC_MARKERS: markers.join(' ') } }));
}

// ── the roster ───────────────────────────────────────────────────────

const ROSTER = [];
const live = (name, fn) => ROSTER.push({ name, fn });

// PINS the whole shipped path — main.mjs arg parsing, kind dispatch,
// StoreRemoteSource lookup, spawnPlan, the frame loop — reaching a real host;
// that the frame's cwd really is the command's working directory; and that CC_REMOTE really
// lands in the environment of the child the exec started. The last is §10's
// CC_REMOTE row asserted ON THE FAR SIDE'S OWN ANSWER rather than on the
// command merely succeeding, which is what a misroute also looks like.
live('a routed exec reaches the host, at the requested cwd, knowing its remote id', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  l.send({
    type: 'exec', id: 'e1', remoteId: 'alpha', cwd: '/tmp',
    argv: ['/bin/sh', '-c', 'echo $CC_REMOTE; pwd'],
  });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'e1');
  assert.equal(exit.code, 0, `stderr=${textOf(l.frames, 'e1', 'stderr')}`);
  assert.equal(textOf(l.frames, 'e1'), 'alpha\n/tmp\n');
});

// PINS THE PREMISE OF PROTOCOL MUST 3 FOR THIS KIND, and it is the test that
// makes every reap assertion below discriminating rather than decorative: a
// kind whose children died with their client would need no relay at all.
// MEASURED: SIGKILL the local ssh client and the remote `sleep` keeps running.
live('NEGATIVE CONTROL — killing the local ssh client leaves the remote command running', async (t, g) => {
  const target = await withSshTarget(t, g);
  const marker = newMarker();
  cleanMarkers(t, g.cli, target.name, [marker]);

  const { spawn } = await import('node:child_process');
  const client = spawn(g.ssh[0], [
    ...g.ssh.slice(1), '-F', target.sshConfig, '-T', '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5', '-o', 'ControlPath=none', '--', target.alias, `sleep ${marker}`,
  ], { stdio: 'ignore' });

  assert.equal(await settle(async () => (await markerCount(g.cli, target.name, marker)) > 0), true,
    'the remote process must start before the control means anything');

  client.kill('SIGKILL');
  await new Promise(r => client.on('close', r));
  // Give any teardown a chance to happen; the point is that it does not, so a
  // window here can only weaken the assertion, never fake it.
  await settle(() => false, 1_000);
  assert.ok(await markerCount(g.cli, target.name, marker) > 0,
    'an ssh remote command survives its host client — this is why the provider must relay the kill');
});

// PINS THAT THE MULTIPLEXING IS REAL, on the only honest discriminator: sshd's
// own authentication count. "The command worked" is what an unmultiplexed run
// also looks like, so a build where every exec dials afresh passes every other
// test in this file.
//
// THE CONTROL IS IN THE TEST: the same five commands with ControlPath=none cost
// five authentications, so the flat count is a measurement and not a fixture
// that cannot tell the difference. Measured out of band first: 1 vs 5.
live('after connect(), five commands cost ONE authentication (control: five without it)', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const cp = controlPathFor(target.config);

  // A DELTA, not an absolute: the fixture's own readiness poll already
  // authenticated, so `1` would be an unestablished claim about how many
  // connections preceded this line.
  const beforeConnect = await authCount(g.cli, target.name);
  await target.transport().connect(target.config);
  const afterConnect = await authCount(g.cli, target.name);
  assert.equal(afterConnect - beforeConnect, 1, 'connect authenticates exactly once');
  const ino = (await fs.stat(cp)).ino;

  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  for (let i = 0; i < 5; i++) {
    l.send({ type: 'exec', id: `m${i}`, remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === `m${i}`);
    assert.equal(exit.code, 0, textOf(l.frames, `m${i}`, 'stderr'));
    assert.equal(textOf(l.frames, `m${i}`), 'ok');
  }
  assert.equal(await authCount(g.cli, target.name), afterConnect,
    'five multiplexed commands must cost NO further authentication');
  assert.equal((await fs.stat(cp)).ino, ino, 'and must ride the same master socket');

  // THE CONTROL: the same five commands with multiplexing impossible.
  for (let i = 0; i < 5; i++) {
    const res = await run([...g.ssh, '-F', target.sshConfig, '-T', '-o', 'BatchMode=yes',
      '-o', 'ControlPath=none', '--', target.alias, 'printf ok']);
    assert.equal(res.code, 0, res.stderr);
  }
  assert.equal(await authCount(g.cli, target.name), afterConnect + 5,
    'the discriminator works: unmultiplexed commands DO each authenticate');
});

// PINS IDEMPOTENCE ON THE ONLY TWO HONEST DISCRIMINATORS, both measured
// against a real sshd rather than inferred: sshd's own authentication count,
// and the host's own process table. "Connect resolved" is exactly what the
// defect also looked like — it reported success while re-authenticating and
// leaking a background `ssh -N` that owned no socket.
//
// THE AUTH COUNT IS READ AS A DELTA, never as an absolute: the fixture's own
// readiness poll has already authenticated, so a literal would be an
// unestablished claim about how many connections preceded this line.
live('a second connect() re-authenticates nothing, opens no second master, and leaks no orphan', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const cp = controlPathFor(target.config);
  const tr = target.transport();

  const before = await authCount(g.cli, target.name);
  await tr.connect(target.config);
  const afterFirst = await authCount(g.cli, target.name);
  assert.equal(afterFirst - before, 1, 'the first connect authenticates exactly once');
  // THE PRODUCT'S OWN FINGERPRINT (`ssh:<hash>:<ino>:<ctimeMs>`), not the raw
  // inode: this filesystem hands a just-freed inode straight back, so `ino`
  // alone can be equal across a genuine replacement. The ctime cannot.
  const fp = (await tr.reachability(target.config)).fingerprint;
  assert.ok(fp, 'a connected remote must carry a fingerprint');
  const one = await controlPathProcs(cp);
  assert.equal(one.count, 1, `exactly one master must own the socket: ${one.cmdlines.join(' | ')}`);

  await tr.connect(target.config);

  assert.equal(await authCount(g.cli, target.name) - afterFirst, 0,
    'a second connect against a live master must not authenticate again');
  const procs = await controlPathProcs(cp);
  assert.equal(procs.count, 1,
    `an orphaned ssh -N survived the second connect: ${procs.cmdlines.join(' | ')}`);
  assert.equal((await tr.reachability(target.config)).fingerprint, fp,
    'and it is the SAME socket, untouched — so the post-connect re-probe is a cache hit');

  // The reused master is really USABLE, not merely present — and using it still
  // costs nothing.
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  l.send({ type: 'exec', id: 'r1', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'r1');
  assert.equal(exit.code, 0, textOf(l.frames, 'r1', 'stderr'));
  assert.equal(textOf(l.frames, 'r1'), 'ok');
  assert.equal(await authCount(g.cli, target.name), afterFirst,
    'and an exec over the reused master costs no authentication either');
});

// PINS THE STALE-SOCKET RULING against the thing that actually produces one: a
// master killed out of band runs no cleanup, so ssh's socket file outlives it.
// `disconnect` will not clear it (every cold shape is "already disconnected"),
// so if `connect` refused, the remote would be permanently unconnectable with
// no in-product remedy. It reclaims instead — one new authentication, a NEW
// inode, one master.
//
// Asserted through the SHIPPED probe rather than a hand-rolled `ssh -O check`,
// so this measures the product's own eyes; and through `settle`, the project's
// bounded poll, never a sleep.
live('a master killed out of band leaves a stale socket, and connect reclaims it', async (t, g) => {
  const target = await withSshTarget(t, g);
  const cp = controlPathFor(target.config);
  const tr = target.transport();

  await tr.connect(target.config);
  const fp = (await tr.reachability(target.config)).fingerprint;
  const procs = await controlPathProcs(cp);
  assert.equal(procs.count, 1, `one master to kill: ${procs.cmdlines.join(' | ')}`);
  process.kill(procs.pids[0], 'SIGKILL');

  assert.equal(await settle(async () => (await tr.reachability(target.config)).connected === false),
    true, 'the master must really be gone before the reclaim means anything');
  await fs.stat(cp);   // MUST still exist: this is the stale case, not the cold one
  const authBefore = await authCount(g.cli, target.name);

  await tr.connect(target.config);

  assert.equal(await authCount(g.cli, target.name) - authBefore, 1,
    'the reclaim opens a real master: exactly one new authentication');
  const back = await tr.reachability(target.config);
  assert.equal(back.connected, true);
  // Again the FINGERPRINT rather than the bare inode — see the test above.
  assert.notEqual(back.fingerprint, fp, 'the dead socket was replaced, not reused');
  const after = await controlPathProcs(cp);
  assert.equal(after.count, 1, `and exactly one master owns the new one: ${after.cmdlines.join(' | ')}`);
});

/** Three live `sleep <marker>` execs plus a barrier proving they were spawned. */
async function threeLive(t, g, target, store) {
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const ids = ['a', 'b', 'c'];
  const markers = ids.map(() => newMarker());
  cleanMarkers(t, g.cli, target.name, markers);
  markers.forEach((m, i) => l.send({
    type: 'exec', id: ids[i], remoteId: 'alpha', cwd: '/tmp',
    argv: ['/bin/sh', '-c', `sleep ${m}`],
  }));
  // A DETERMINISTIC BARRIER, not a sleep: frames are handled in arrival order,
  // so this one's `exit` proves the three execs were already spawned.
  l.send({ type: 'exec', id: 'barrier', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier');
  for (const m of markers) {
    assert.equal(await settle(async () => (await markerCount(g.cli, target.name, m)) > 0), true,
      `marker ${m} must be running on the target before the kill is asserted`);
  }
  return { l, markers };
}

// PINS protocol MUST 3, PROVED against a real host rather than asserted: stdin
// EOF SIGKILLs the in-flight work ON THE TARGET. 2000 ms is cc's own
// DEFAULT_SHUTDOWN_GRACE_MS — past it cc SIGKILLs us mid-reap and the orphans
// survive anyway. A no-op `reap` reds the marker assertion, and it reds BECAUSE
// the negative control pins that the local kill alone leaves them running.
live('stdin EOF SIGKILLs every in-flight remote command, inside cc\'s grace', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const { l, markers } = await threeLive(t, g, target, store);

  const started = Date.now();
  l.closeStdin();
  const { code } = await l.exited;
  assert.equal(code, 0, 'a provider exits when its stdin closes');
  assert.ok(Date.now() - started < 2_000, "reaping must finish inside cc's own 2000ms grace");
  for (const m of markers) {
    assert.equal(await markerCount(g.cli, target.name, m), 0, `marker ${m} survived the reap`);
  }
});

// PINS that the reap is scoped to ONE exec's token, not to the host: a mutant
// reaping by host kills the other two and reds. The MIDDLE of three is chosen
// so a first/last-live heuristic cannot pass by accident.
live('`close` reaps that id alone and leaves the other execs running', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const { l, markers } = await threeLive(t, g, target, store);

  // MEASURE the steady state rather than asserting a literal: nothing fixes how
  // many remote processes one `sleep <marker>` exec owns, and a hardcoded 2
  // would be an unestablished claim that could drift with the target's shell.
  const baseline = {};
  for (const m of markers) baseline[m] = await markerCount(g.cli, target.name, m);
  for (const m of markers) assert.ok(baseline[m] > 0, `marker ${m} must be live before the close`);

  const before = l.frames.length;
  l.send({ type: 'close', id: 'b' });
  l.send({ type: 'exec', id: 'barrier2', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier2');

  assert.equal(await settle(async () => (await markerCount(g.cli, target.name, markers[1])) === 0), true,
    "the closed id's remote process must be gone");
  assert.equal(await markerCount(g.cli, target.name, markers[0]), baseline[markers[0]],
    'the first exec must be untouched — the reap is token-scoped, not host-scoped');
  assert.equal(await markerCount(g.cli, target.name, markers[2]), baseline[markers[2]],
    'the third exec must be untouched');
  assert.equal(l.frames.slice(before).filter(f => f.id === 'b').length, 0,
    'no further frames are emitted for a closed id');
});

// PINS the two reap sites an enumeration is most likely to miss. A `timeoutMs`
// expiry and a `signal` frame kill the LOCAL ssh client while the remote
// command keeps running (the negative control), so without a reap here the
// launcher reports `{code:124, timedOut:true}` — cc's own "the provider killed
// it" — for a command still running on the target.
live('a timed-out exec and a signalled exec are BOTH reaped on the target', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();

  const toMarker = newMarker();
  const sgMarker = newMarker();
  cleanMarkers(t, g.cli, target.name, [toMarker, sgMarker]);

  l.send({
    type: 'exec', id: 'to', remoteId: 'alpha', cwd: '/tmp', timeoutMs: 3_000,
    argv: ['/bin/sh', '-c', `sleep ${toMarker}`],
  });
  assert.equal(await settle(async () => (await markerCount(g.cli, target.name, toMarker)) > 0, 2_500), true,
    'the remote process must be running before the timeout fires, or this pins nothing');
  const toExit = await l.waitFor(f => f.type === 'exit' && f.id === 'to');
  assert.equal(toExit.code, 124, 'timeout is reported as timeout(1) does');
  assert.equal(toExit.timedOut, true);
  assert.equal(toExit.descendantsMaySurvive, true,
    'no process-group reach into the far side, so the result must say so');
  assert.equal(await settle(async () => (await markerCount(g.cli, target.name, toMarker)) === 0), true,
    'and the remote process is actually gone, not merely reported dead');

  l.send({ type: 'exec', id: 'sg', remoteId: 'alpha', cwd: '/tmp', argv: ['/bin/sh', '-c', `sleep ${sgMarker}`] });
  assert.equal(await settle(async () => (await markerCount(g.cli, target.name, sgMarker)) > 0), true);
  l.send({ type: 'signal', id: 'sg', signal: 'SIGTERM' });
  const sgExit = await l.waitFor(f => f.type === 'exit' && f.id === 'sg');
  assert.equal(sgExit.timedOut, false, 'a signal is not a timeout');
  assert.equal(sgExit.descendantsMaySurvive, true);
  assert.equal(await settle(async () => (await markerCount(g.cli, target.name, sgMarker)) === 0), true,
    'a signalled exec leaves nothing running on the target');
});

// PINS the one thing a pure spawnPlan test cannot reach: that `env -i` really
// clears the TARGET's environment, and that an absent frame `env` really leaves
// the target's own toolchain intact.
//
// HOME IS THE DISCRIMINATOR. An overlay would leave HOME=/root and pass every
// other assertion here; only a real replacement makes it UNSET. Both arms
// measured against this image: inherit → HOME=/root, replace → UNSET.
live('an absent env inherits the TARGET\'s environment; a supplied env replaces it', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const show = ['/bin/sh', '-c', 'echo "$PATH"; echo "[${HOME-UNSET}]"; echo "$CC_REMOTE"'];

  l.send({ type: 'exec', id: 'inh', remoteId: 'alpha', cwd: '/tmp', argv: show });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'inh')).code, 0,
    textOf(l.frames, 'inh', 'stderr'));
  const [inhPath, inhHome, inhRemote] = textOf(l.frames, 'inh').trim().split('\n');
  assert.notEqual(inhPath, process.env.PATH,
    "this fixture cannot discriminate: the launcher's PATH and the target's are identical");
  assert.equal(inhHome, '[/root]', "the TARGET's own HOME");
  assert.equal(inhRemote, 'alpha');

  l.send({
    type: 'exec', id: 'rep', remoteId: 'alpha', cwd: '/tmp', argv: show,
    env: { PATH: '/usr/bin', CC_REMOTE: 'frame-supplied' },
  });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'rep')).code, 0,
    textOf(l.frames, 'rep', 'stderr'));
  const [repPath, repHome, repRemote] = textOf(l.frames, 'rep').trim().split('\n');
  assert.equal(repPath, '/usr/bin');
  assert.equal(repHome, '[UNSET]',
    'HOME must be GONE — an overlay would leave /root and pass every other assertion here');
  assert.equal(repRemote, 'alpha', "the provider's binding beats the frame-supplied CC_REMOTE");
});

// PINS acceptance 2: the shared fileops.mjs scripts, the per-call CCERR-<nonce>
// tagging and the mode rules all hold over an ssh slave with the payload on
// stdin, with NO ssh-specific file code anywhere.
//
// THE REAL RISK FOR THIS KIND is the multi-line script surviving one round of
// `shellQuote` through a LOGIN shell — ssh joins argv and the far side
// re-parses. THE CONTENT ROUND TRIP IS WHAT CATCHES A BROKEN STDIN PATH:
// without it `base64 -d` sees immediate EOF and writes a ZERO-BYTE FILE WITH
// EXIT 0, so a mode-and-success-only test would pass a completely broken write.
live('readFile/writeFile work over ssh, with every code cc branches on', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const body = Buffer.from('hello from the ssh target\n#!/bin/sh\n');

  const write = async (id, p, data, over = {}) => {
    l.send({ type: 'writeFile', id, remoteId: 'alpha', path: p, ...over });
    l.send({ type: 'data', id, seq: 0, dataB64: data.toString('base64') });
    l.send({ type: 'end', id });
    return l.waitFor(f => (f.type === 'writeFileResult' || f.type === 'error') && f.id === id);
  };
  const read = async (id, p, over = {}) => {
    l.send({ type: 'readFile', id, remoteId: 'alpha', path: p, ...over });
    const head = await l.waitFor(f => (f.type === 'readFileResult' || f.type === 'error') && f.id === id);
    if (head.type === 'readFileResult') await l.waitFor(f => f.type === 'end' && f.id === id);
    return head;
  };

  assert.equal((await write('w1', '/tmp/f.txt', body, { mode: 0o750 })).type, 'writeFileResult');
  const r1 = await read('r1', '/tmp/f.txt');
  assert.equal(r1.type, 'readFileResult', JSON.stringify(r1));
  assert.equal(r1.mode & 0o7777, 0o750, 'the requested mode survived');
  assert.equal(r1.size, body.length);
  assert.equal(r1.isBinary, false);
  assert.deepEqual(bytesOf(l.frames, 'r1'), body,
    'the bytes round-trip — a broken stdin path writes zero bytes and exits 0');

  assert.equal((await write('w2', '/tmp/exec.sh', body, { atomic: true, mode: 0o100755 })).type,
    'writeFileResult');
  assert.equal((await read('r2', '/tmp/exec.sh')).mode & 0o7777, 0o755,
    'the requested mode survived the rename');

  assert.equal((await write('w2b', '/tmp/exec.sh', Buffer.from('again\n'))).type, 'writeFileResult');
  assert.equal((await read('r2b', '/tmp/exec.sh')).mode & 0o7777, 0o755,
    'a plain write must not reset an existing mode');

  assert.equal((await read('r3', '/tmp')).code, 'EISDIR');
  assert.equal((await read('r4', '/tmp/definitely-absent')).code, 'ENOENT');

  const r5 = await read('r5', '/tmp/f.txt', { offset: 6, length: 4 });
  assert.equal(r5.type, 'readFileResult');
  assert.equal(r5.size, body.length, 'size is the file, not the range');
  assert.deepEqual(bytesOf(l.frames, 'r5'), body.subarray(6, 10));
});

// PINS `exclusive` ON THE BYTES, not just on the code. Asserting only EEXIST
// would pass a build that truncated the file first and then refused — which is
// exactly the lost update the flag exists to prevent. The residual gap (a
// check-then-act race on a target shell that ignores noclobber) is documented
// in docs/protocol.md, not claimed away here.
live('an exclusive write over an existing file refuses AND leaves the bytes intact', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const original = Buffer.from('ORIGINAL-BYTES-MUST-SURVIVE\n');

  l.send({ type: 'writeFile', id: 'x1', remoteId: 'alpha', path: '/tmp/excl.txt' });
  l.send({ type: 'data', id: 'x1', seq: 0, dataB64: original.toString('base64') });
  l.send({ type: 'end', id: 'x1' });
  assert.equal((await l.waitFor(f => f.type === 'writeFileResult' && f.id === 'x1')).ok, true);

  l.send({ type: 'writeFile', id: 'x2', remoteId: 'alpha', path: '/tmp/excl.txt', exclusive: true });
  l.send({ type: 'data', id: 'x2', seq: 0, dataB64: Buffer.from('CLOBBERED').toString('base64') });
  l.send({ type: 'end', id: 'x2' });
  const err = await l.waitFor(f => (f.type === 'error' || f.type === 'writeFileResult') && f.id === 'x2');
  assert.equal(err.type, 'error');
  assert.equal(err.code, 'EEXIST', '"create unless it already exists" is written as catch-EEXIST');

  // READ THE FILE BACK, out of band, so the transport under test cannot be the
  // thing that reports its own success.
  const back = await inTarget(g.cli, target.name, 'cat /tmp/excl.txt');
  assert.equal(back.stdout, original.toString('utf8'),
    'the refusal must not have truncated the file it refused to write');
});

// PINS criterion 10 and §9's "one dead remote is not a dead connection". An
// unreachable host must answer an id-addressed ENOREMOTE with NO exit frame,
// inside a bounded wall time — a build without ConnectTimeout/BatchMode hangs,
// and one that read exit 255 as an exit status emits an `exit` frame instead.
//
// 127.0.0.1 port 1 rather than a guessed unroutable address: `Connection
// refused` is immediate and deterministic, so the wall-time bound is a real
// assertion rather than a race.
live('an unreachable host is an id-addressed ENOREMOTE with no exit frame, and the live one still serves', async (t, g) => {
  const target = await withSshTarget(t, g, {
    extraConfig: [
      '',
      'Host deadbox',
      '  HostName 127.0.0.1',
      '  Port 1',
      '  User root',
      '  IdentitiesOnly yes',
      '  IdentityAgent none',
      '  BatchMode yes',
    ],
  });
  const store = await storeFor(t, target);
  await writeRecord(store.dir, sshRecord('dead', 'deadbox'));

  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const started = Date.now();
  l.send({ type: 'exec', id: 'd1', remoteId: 'dead', cwd: '/', argv: ['true'] });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'd1');
  assert.equal(err.code, 'ENOREMOTE', JSON.stringify(err));
  assert.equal(typeof err.id, 'string', 'id-addressed: an id-less error fails every OTHER target');
  assert.match(err.message, /deadbox/, 'the message names the CONFIGURED host');
  assert.ok(Date.now() - started < 15_000, 'nothing may wait on a human or on TCP past ConnectTimeout');

  l.send({ type: 'readFile', id: 'd2', remoteId: 'dead', path: '/etc/hostname' });
  assert.equal((await l.waitFor(f => f.type === 'error' && f.id === 'd2')).code, 'ENOREMOTE');
  assert.equal(l.frames.some(f => f.type === 'exit'), false, 'no exit frame for a transport failure');

  // ONE DEAD REMOTE IS NOT A DEAD CONNECTION.
  l.send({ type: 'exec', id: 'ok', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'still here'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'ok')).code, 0);
  assert.equal(textOf(l.frames, 'ok'), 'still here');
});

// PINS [D3] — THE known_hosts POLICY, turned from a claim into a fact. The
// provider sets `StrictHostKeyChecking=accept-new` and no `UserKnownHostsFile`,
// so an UNKNOWN host key is accepted on first use and recorded in the
// operator's own known_hosts (the fixture's ssh_config names it), and later
// connects verify against it. The fixture itself leaves the option unset, so
// this measures the provider's flag and nothing else.
live('an unknown host key is accepted on first use and recorded in known_hosts', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  // Empty its known_hosts AFTER readiness, so the key really is unknown at the
  // moment the provider connects. Readiness used ControlPath=none, so no master
  // exists to short-circuit the check.
  await fs.writeFile(target.knownHosts, '');

  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  l.send({ type: 'exec', id: 'hk', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ran'] });
  const exit = await l.waitFor(f => (f.type === 'exit' || f.type === 'error') && f.id === 'hk');
  assert.equal(exit.type, 'exit', JSON.stringify(exit));
  assert.equal(exit.code, 0);
  assert.equal(textOf(l.frames, 'hk'), 'ran');

  const blob = target.hostKey.split(/\s+/).slice(0, 2).join(' ');
  const recorded = (await fs.readFile(target.knownHosts, 'utf8')).split('\n').filter(Boolean);
  assert.deepEqual(recorded.map(line => line.split(/\s+/).slice(0, 3).join(' ')), [`${target.ip} ${blob}`],
    'exactly the host\'s own key, under the address ssh dialled, in the operator\'s file');

  // And the next dial VERIFIES against it rather than recording again.
  l.send({ type: 'exec', id: 'hk2', remoteId: 'alpha', cwd: '/tmp', argv: ['true'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'hk2')).code, 0);
  assert.equal((await fs.readFile(target.knownHosts, 'utf8')).split('\n').filter(Boolean).length, 1);
});

// PINS the half of the policy that keeps a man-in-the-middle out: a key that
// DIFFERS from the recorded one is refused — on exec as an id-addressed
// EUNKNOWN naming the change, on connect as a throw saying the same — and the
// recorded key is left exactly as it was. A mutant setting
// `StrictHostKeyChecking=no` reds here: ssh would connect anyway.
live('a CHANGED host key is refused, named as a change, and the recorded key is untouched', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  // A different ed25519 key — the client key's own public half — on file for
  // the target's address, so the host presents a key of the SAME type that does
  // not match.
  const wrong = (await fs.readFile(`${target.key}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
  const onFile = `${target.ip} ${wrong}\n`;
  await fs.writeFile(target.knownHosts, onFile);

  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const started = Date.now();
  l.send({ type: 'exec', id: 'hk', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'should-not-run'] });
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'hk');
  assert.equal(err.code, 'EUNKNOWN', 'our access failing is NOT the remote being absent');
  assert.match(err.message, /CHANGED/, err.message);
  assert.match(err.message, /known_hosts/, 'the fix is out of band, and the message says where');
  assert.ok(Date.now() - started < 15_000, 'it must FAIL, not sit on a prompt');
  assert.equal(l.frames.some(f => f.type === 'exit'), false, 'and never a plausible exit frame');
  assert.equal(textOf(l.frames, 'hk'), '', 'the command must not have run');

  await assert.rejects(() => target.transport().connect(target.config), /CHANGED/);
  assert.equal(await fs.readFile(target.knownHosts, 'utf8'), onFile, 'a refusal never rewrites known_hosts');
});

// PINS acceptance 6. A CC_REMOTE-only assertion passes even if both ids reach
// the SAME host, so the target's own hostname is what makes a misroute visible.
live('every operation routes on its remoteId, and the routed host really differs', async (t, g) => {
  const one = await withSshTarget(t, g, { stem: 'one' });
  const two = await withSshTarget(t, g, { stem: 'two' });
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, sshRecord('one', one.alias));
  await writeRecord(store.dir, sshRecord('two', two.alias));

  // ONE ssh_config naming both aliases, so a single launcher can reach both.
  const dir = await tempDir(t);
  const combined = path.join(dir, 'ssh_config');
  await writeSshConfig(combined, [
    await fs.readFile(one.sshConfig, 'utf8'),
    await fs.readFile(two.sshConfig, 'utf8'),
  ]);

  const hostnames = {};
  for (const [id, target] of [['one', one], ['two', two]]) {
    hostnames[id] = (await inTarget(g.cli, target.name, 'cat /etc/hostname')).stdout.trim();
  }
  assert.notEqual(hostnames.one, hostnames.two, 'two containers, two identities');

  const l = launcherFor(t, store, JSON.stringify([...g.ssh, '-F', combined]));
  await l.hello();
  for (const id of ['one', 'two']) {
    l.send({
      type: 'exec', id: `x-${id}`, remoteId: id, cwd: '/',
      argv: ['/bin/sh', '-c', 'cat /etc/hostname; echo "$CC_REMOTE"'],
    });
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === `x-${id}`);
    assert.equal(exit.code, 0, textOf(l.frames, `x-${id}`, 'stderr'));
    assert.deepEqual(textOf(l.frames, `x-${id}`).trim().split('\n'), [hostnames[id], id],
      'the argv carried the ROUTED host, and the far side agrees which remote it is');
  }
});

// PINS criterion 1's third clause, and it is the payoff of holding NO connection
// state: an `ssh -O exit` issued OUTSIDE the plugin is reflected immediately,
// with nothing restarted. A memoised connect state would keep reporting a
// master that is gone.
//
// It also pins the [D1] consequence a UI must not overstate: connect/disconnect
// govern THE MULTIPLEXED MASTER, not authorization. After the master is gone an
// exec still SUCCEEDS — unmultiplexed, paying its own authentication — and does
// NOT silently re-create the master.
live('an out-of-band `ssh -O exit` is reflected, and an exec still succeeds unmultiplexed', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const tr = target.transport();
  const cp = controlPathFor(target.config);

  await tr.connect(target.config);
  assert.equal((await tr.reachability(target.config)).connected, true);

  // THE FIXTURE tears the master down itself, behind the provider's back.
  const killed = await run([...g.ssh, '-F', target.sshConfig, '-o', `ControlPath=${cp}`,
    '-o', 'ControlMaster=no', '-O', 'exit', '--', target.alias]);
  assert.equal(killed.code, 0, killed.stderr);

  const after = await tr.reachability(target.config);
  assert.equal(after.connected, false, 'the provider must re-ask the socket, not answer from memory');
  assert.equal(after.fingerprint, null);

  const authBefore = await authCount(g.cli, target.name);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  l.send({ type: 'exec', id: 'after', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'unmuxed-ok'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'after');
  assert.equal(exit.code, 0, textOf(l.frames, 'after', 'stderr'));
  assert.equal(textOf(l.frames, 'after'), 'unmuxed-ok');
  assert.equal(await authCount(g.cli, target.name), authBefore + 1,
    'it paid its own authentication — so it really ran unmultiplexed');
  await assert.rejects(() => fs.stat(cp), /ENOENT/,
    'and NOTHING was restarted: an exec must not silently re-create the master');
});

// PINS THE FIX FOR AN OPTION INJECTION against a real host rather than on the
// argv. Frame-supplied env KEYS are arbitrary; GNU `env` reads leading-`-`
// operands as its own options until a non-option operand, so without `env --` a
// frame silently relocates the command while cc believes it ran at the `cwd` it
// sent, or spoofs `$0`.
live('a frame env key shaped like an option cannot hijack the command', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  l.send({
    type: 'exec', id: 'inj', remoteId: 'alpha', cwd: '/tmp',
    argv: ['/bin/sh', '-c', 'pwd; echo "$0"'],
    // `/` exists everywhere, so a successful hijack is VISIBLE as a different
    // cwd rather than as a failure that could have many causes.
    env: { '--chdir=/': '', '--argv0=EVIL': '', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'inj');
  assert.equal(exit.code, 0, `the exec must still run: ${textOf(l.frames, 'inj', 'stderr')}`);
  const [cwd, argv0] = textOf(l.frames, 'inj').trim().split('\n');
  assert.equal(cwd, '/tmp', "the frame's cwd held — `--chdir` was an assignment, not an option");
  assert.notEqual(argv0, 'EVIL', '`--argv0` was an assignment, not an option');
});

// PINS `-T` AGAINST THE OPERATOR'S OWN CONFIG, which is the only place this
// hazard can come from. Measured: with `RequestTTY force`, a remote
// `printf 'CCSTAT …\n'` comes back `…\r\n` WITHOUT `-T` and `…\n` with it — and
// that `\r` corrupts fileops' header parse, which reads the first line.
//
// `RequestTTY yes` is NOT enough to reproduce it (ssh declines a pty when stdin
// is not a terminal), so `force` is what makes this test discriminating.
live('-T holds against a RequestTTY force in the operator\'s own ssh config', async (t, g) => {
  const target = await withSshTarget(t, g, { extraConfig: ['  RequestTTY force'] });
  const store = await storeFor(t, target);

  // FIRST, the control: prove this fixture really does force a pty, or the
  // assertion below would pass on a target that never had one.
  const raw = await run([...g.ssh, '-F', target.sshConfig, '-o', 'BatchMode=yes',
    '-o', 'ControlPath=none', '--', target.alias, "printf 'CCSTAT 81a4 12\\n'"]);
  assert.ok(raw.stdout.includes('\r'),
    'the fixture must actually force a pty, or this test cannot discriminate');

  // NOW the provider, which sets -T: a readFile must still parse.
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const body = Buffer.from('tty-must-not-corrupt-this\n');
  l.send({ type: 'writeFile', id: 'tw', remoteId: 'alpha', path: '/tmp/tty.txt' });
  l.send({ type: 'data', id: 'tw', seq: 0, dataB64: body.toString('base64') });
  l.send({ type: 'end', id: 'tw' });
  assert.equal((await l.waitFor(f => (f.type === 'writeFileResult' || f.type === 'error') && f.id === 'tw')).type,
    'writeFileResult');

  l.send({ type: 'readFile', id: 'tr', remoteId: 'alpha', path: '/tmp/tty.txt' });
  const head = await l.waitFor(f => (f.type === 'readFileResult' || f.type === 'error') && f.id === 'tr');
  assert.equal(head.type, 'readFileResult', `the CCSTAT header must still parse: ${JSON.stringify(head)}`);
  await l.waitFor(f => f.type === 'end' && f.id === 'tr');
  assert.deepEqual(bytesOf(l.frames, 'tr'), body, 'and no CR was injected into the payload');
});

// PINS THE MEASURED TRUTH ABOUT THE CONTROL DIRECTORY, IN BOTH DIRECTIONS —
// and the first half pins the OPPOSITE of what ssh_config(5)'s "will fall back
// to connecting normally if the control socket does not exist" suggests for a
// missing DIRECTORY. Measured: `ControlMaster=auto` with the directory absent
// exits 255 (`unix_listener: cannot bind to path …`), while `ControlMaster=no`
// runs fine and creates nothing. That is why every operation carries `no` and
// `spawnPlan` can stay pure.
//
// A mutant switching operations to `auto` reds the first half on a fresh remote.
live('with no master an exec still runs and creates nothing; after connect() execs share one socket', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const cp = controlPathFor(target.config);
  await assert.rejects(() => fs.stat(cp), /ENOENT/, 'no master yet');

  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  l.send({ type: 'exec', id: 'cold', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'cold-ok'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'cold');
  assert.equal(exit.code, 0, `a first exec must work with no master at all: ${textOf(l.frames, 'cold', 'stderr')}`);
  assert.equal(textOf(l.frames, 'cold'), 'cold-ok');
  await assert.rejects(() => fs.stat(cp), /ENOENT/,
    'and it must not have created a master — nothing on the pure exec path may bind one');

  // THE OTHER DIRECTION: once connect() has bound one, execs ride it.
  await target.transport().connect(target.config);
  const ino = (await fs.stat(cp)).ino;
  for (const id of ['warm1', 'warm2']) {
    l.send({ type: 'exec', id, remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'warm-ok'] });
    assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === id)).code, 0);
  }
  assert.equal((await fs.stat(cp)).ino, ino, 'both execs rode the one master socket');
});

// PINS the relay's blindness detection on THIS target's shell (debian:13-slim's
// dash), the third shell this project meets. Without `tr`, or on a target whose
// /proc/<pid>/environ cannot be read, every match fails — and an unconditional
// `exit 0` would report a successful reap while the far-side subtree survived.
live('the reap script reports `blind` instead of success when it cannot read /proc', async (t, g) => {
  const target = await withSshTarget(t, g);
  const script = buildReapScript('a-token-nothing-carries');

  const ok = await inTarget(g.cli, target.name, script);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^CCREAP ok 0 \d+$/m, JSON.stringify(ok.stdout));
  assert.notEqual(ok.stdout.trim().split(' ')[3], '0',
    'the scanning process can always read its own environ, so this is never 0 when sighted');

  const blind = await inTarget(g.cli, target.name, `PATH=/nonexistent-xyz\n${script}`);
  assert.equal(blind.code, 3, 'it must exit non-zero when blind');
  assert.match(blind.stdout, /CCREAP blind/);
});

// PINS the tooling baseline against this image, which is the reason the fixture
// is debian-slim and not Alpine: `fileops` and every cc derivation are gated on
// this verdict, so a target that failed it could not exercise the tests above.
live('the fixture image PASSES the tooling baseline, so the suite above is not vacuous', async (t, g) => {
  const target = await withSshTarget(t, g);
  const runner = makeRunner(target.transport(), target.config, 'alpha');
  const res = await runner({ script: PROBE_SCRIPT });
  assert.equal(res.code, 0, `the probe must run to completion: ${res.stderr}`);
  const parsed = parseProbeOutput(res);
  assert.equal(parsed.state, 'ok',
    `debian:13-slim must satisfy the baseline, else fileops is gated off: ${JSON.stringify(parsed.missing)}`);
  assert.deepEqual(parsed.missing, []);
});

// ── transports whose `env` lacks `--chdir`, and the failure rows ──────

// Runs ONE exec through the shipped launcher and returns its terminal frame.
async function execOnce(l, id, over) {
  l.send({ type: 'exec', id, remoteId: 'alpha', cwd: '/tmp', ...over });
  return l.waitFor(f => (f.type === 'exit' || f.type === 'error') && f.id === id);
}

// PINS that an exec runs at the frame's cwd on a target whose `env` has no
// `--chdir` option at all. THE WRONG IMPLEMENTATION is the GNU-only `env
// --chdir=<cwd>`: BusyBox 1.37 answers `unrecognized option: chdir=/tmp` with its
// usage text and exit 1, so every exec on Alpine fails — including the baseline
// probe's.
live('ALPINE: an exec runs at the frame\'s cwd on an `env` without --chdir', async (t, g) => {
  const target = await withSshTarget(t, g, { image: 'alpine' });
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const done = await execOnce(l, 'a1', { argv: ['/bin/sh', '-c', 'echo $CC_REMOTE; pwd'] });
  assert.equal(done.type, 'exit', JSON.stringify(done));
  assert.equal(done.code, 0, textOf(l.frames, 'a1', 'stderr'));
  assert.equal(textOf(l.frames, 'a1'), 'alpha\n/tmp\n');
});

for (const box of ['debian', 'alpine']) {
  const where = `${box.toUpperCase()}: `;
  const open = async (t, g) => {
    const target = await withSshTarget(t, g, { image: box });
    const store = await storeFor(t, target);
    const l = launcherFor(t, store, target.sshEnv);
    await l.hello();
    return { target, l };
  };

  // PINS that a cwd which does not exist is an ENOENT `error` frame and never an
  // `exit` frame — §5's "a command that never started". THE WRONG
  // IMPLEMENTATION lets the shell's own diagnostic through as a command's exit
  // status (on Alpine today: BusyBox usage text, exit 1). The message names our
  // marker's wording, which is what survives the shell-specific `cd` text.
  live(`${where}a nonexistent cwd is an ENOENT error frame, never an exit frame`, async (t, g) => {
    const { l } = await open(t, g);
    const done = await execOnce(l, 'c1', { cwd: '/nope-xyz', argv: ['/bin/true'] });
    assert.equal(done.type, 'error', JSON.stringify(done));
    assert.equal(done.code, 'ENOENT');
    assert.match(done.message, /cannot change directory to \/nope-xyz/);
    assert.equal(l.frames.some(f => f.type === 'exit' && f.id === 'c1'), false);
  });

  // PINS that a binary that does not exist is an ENOENT `error` frame, never an
  // `exit` frame. THE WRONG IMPLEMENTATION is a classifier that knows only the
  // GNU wording (or, on Alpine today, a transport that fails first and reports
  // BusyBox's usage text at exit 1).
  live(`${where}a missing binary is an ENOENT error frame`, async (t, g) => {
    const { l } = await open(t, g);
    const done = await execOnce(l, 'm1', { argv: ['/nonexistent-bin-xyz'] });
    assert.equal(done.type, 'error', JSON.stringify(done));
    assert.equal(done.code, 'ENOENT');
    assert.match(done.message, /nonexistent-bin-xyz/);
  });

  // PINS that a command's OWN 125 or 127 carrying env-looking stderr is an
  // `exit` frame with that code: the transport's verdict needs its own bytes at
  // its own code. THE WRONG IMPLEMENTATION is a classifier accepting `env: ` at
  // either code, or a 127 `env:` line followed by more output.
  live(`${where}a command's own 125/127 with env-like stderr is an exit frame`, async (t, g) => {
    const { l } = await open(t, g);
    const own125 = await execOnce(l, 'x1', {
      argv: ['/bin/sh', '-c', "printf 'env: cannot change directory to x\\n' >&2; exit 125"],
    });
    assert.deepEqual([own125.type, own125.code], ['exit', 125], JSON.stringify(own125));
    const own127 = await execOnce(l, 'x2', {
      argv: ['/bin/sh', '-c', "echo \"env: 'x': No such file or directory\" >&2; echo more >&2; exit 127"],
    });
    assert.deepEqual([own127.type, own127.code], ['exit', 127], JSON.stringify(own127));
  });

  // PINS that an odd absolute cwd and a relative `-` land on the EXACT path. The
  // relative case is the discriminating one: `cd -` with OLDPWD unset is refused,
  // so a trampoline that does not anchor a relative cwd with `./` fails here
  // instead of running in the login directory's `-`.
  live(`${where}odd cwds land on the exact path, and a relative '-' is a directory, not OLDPWD`, async (t, g) => {
    const { target, l } = await open(t, g);
    const made = await inTarget(g.cli, target.name, `mkdir -p "/tmp/a b'c*" /root/-`);
    assert.equal(made.code, 0, made.stderr);
    for (const [id, cwd, want] of [
      ['o1', "/tmp/a b'c*", "/tmp/a b'c*"],
      ['o2', '-', '/root/-'],
    ]) {
      const done = await execOnce(l, id, { cwd, argv: ['/bin/sh', '-c', 'pwd'] });
      assert.equal(done.type, 'exit', JSON.stringify(done));
      assert.equal(done.code, 0, textOf(l.frames, id, 'stderr'));
      assert.equal(textOf(l.frames, id), `${want}\n`);
    }
  });
}

// PINS that a missing binary whose path contains a space is still an ENOENT
// `error` frame on GNU `env`, which answers it with TWO stderr lines (the second
// is the `use -[v]S` hint). THE WRONG IMPLEMENTATION is a 127 arm that demands a
// single stderr line, which turns this into an `exit 127` frame.
live('DEBIAN: a missing binary whose path has a space is an ENOENT error frame', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const done = await execOnce(l, 'sp1', { argv: ['/tmp/no such binary'] });
  assert.equal(done.type, 'error', JSON.stringify(done));
  assert.equal(done.code, 'ENOENT');
});

// PINS the option-injection guard on a BusyBox `env`: frame env KEYS shaped like
// `env` options stay assignments, and a leading-dash argv[0] is a command. THE
// WRONG IMPLEMENTATION is dropping `--`, which lets `--chdir=/` relocate the
// command or `--argv0=EVIL` spoof `$0`.
live('ALPINE: a frame env key shaped like an option cannot hijack the command', async (t, g) => {
  const target = await withSshTarget(t, g, { image: 'alpine' });
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const done = await execOnce(l, 'inj', {
    argv: ['/bin/sh', '-c', 'pwd; echo "$0"'],
    env: { '--chdir=/': '', '--argv0=EVIL': '', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  assert.equal(done.type, 'exit', JSON.stringify(done));
  assert.equal(done.code, 0, textOf(l.frames, 'inj', 'stderr'));
  const [cwd, argv0] = textOf(l.frames, 'inj').trim().split('\n');
  assert.equal(cwd, '/tmp', "the frame's cwd held — `--chdir` was an assignment, not an option");
  assert.notEqual(argv0, 'EVIL', '`--argv0` was an assignment, not an option');
  const dash = await execOnce(l, 'inj2', { argv: ['-evilcmd', 'x'] });
  assert.deepEqual([dash.type, dash.code], ['error', 'ENOENT'], 'a leading-dash argv[0] is a command, not an option');
});

// PINS `env`'s inherit/replace on BusyBox: HOME is the discriminator, as in the
// debian roster entry. THE WRONG IMPLEMENTATION is a trampoline that rebuilds
// the environment, or a `-i` that BusyBox does not honour.
live('ALPINE: an absent env inherits the target\'s HOME; a supplied env replaces it', async (t, g) => {
  const target = await withSshTarget(t, g, { image: 'alpine' });
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  const show = ['/bin/sh', '-c', 'echo "[${HOME-UNSET}]"; echo "$CC_REMOTE"'];
  const inh = await execOnce(l, 'inh', { argv: show });
  assert.equal(inh.type, 'exit', JSON.stringify(inh));
  assert.deepEqual(textOf(l.frames, 'inh').trim().split('\n'), ['[/root]', 'alpha']);
  const rep = await execOnce(l, 'rep', {
    argv: show, env: { PATH: '/usr/bin:/bin', CC_REMOTE: 'frame' },
  });
  assert.equal(rep.type, 'exit', JSON.stringify(rep));
  assert.deepEqual(textOf(l.frames, 'rep').trim().split('\n'), ['[UNSET]', 'alpha'],
    "HOME is GONE, and the provider's CC_REMOTE beats the frame's");
});

// PINS that the baseline probe RUNS over ssh to an Alpine target and names the
// real gaps. THE WRONG IMPLEMENTATION is a transport that fails first: the probe
// is itself an exec, so BusyBox's `env` usage text left the probe with no
// readable output and one misleading `shell` gap instead of the four real ones.
live('ALPINE: the baseline probe runs over ssh and names the four real gaps', async (t, g) => {
  const target = await withSshTarget(t, g, { image: 'alpine' });
  const runner = makeRunner(target.transport(), target.config, 'alpha');
  const res = await runner({ script: PROBE_SCRIPT });
  const parsed = parseProbeOutput(res);
  assert.equal(parsed.state, 'unsupported');
  assert.deepEqual(parsed.missing.map(m => m.capability).sort(), ['readDir', 'realpath', 'shell', 'stat']);
});

// ── registration, and the count proof ────────────────────────────────

let ran = 0;
// ── terminals ────────────────────────────────────────────────────────

// The shared live rows (tests/ptyLiveRows.mjs) on BOTH paths a terminal can
// take: through the multiplexed master, and with none (a direct connection).
// They differ where it matters here — the mux relays a resize late and runs a
// tty-less command where a direct connection refuses it.
const ARMS = [['mux', true], ['direct', false]];
for (const [arm, mux] of ARMS) {
  for (const r of PTY_LIVE_ROWS) {
    live(`${r.name} [${arm}]`, async (t, g) => {
      const target = await withSshTarget(t, g);
      if (mux) await target.transport().connect(target.config);
      const store = await storeFor(t, target);
      const l = launcherFor(t, store, target.sshEnv);
      assert.equal((await l.hello()).capabilities.pty, true, `this host must run the pty helper: ${l.stderr}`);
      await r.fn({
        t, l, remoteId: 'alpha', marker: newMarker,
        count: (m) => markerCount(g.cli, target.name, m),
        clean: (ms) => cleanMarkers(t, g.cli, target.name, ms),
      });
    });
  }
}

// PINS EPTY on both arms of `PermitTTY no`, which ssh answers DIFFERENTLY: a
// direct connection exits 255 with "PTY allocation request failed" and never
// runs the command (the classifier's row), while the mux runs it with NO tty
// (the trampoline's `[ -t 0 ]`). The negative control is the same box with
// sshd's PermitTTY set back to yes: then it opens.
live('pty: PermitTTY no is EPTY, direct and through the mux; the same box with PermitTTY yes opens', async (t, g) => {
  const target = await withSshTarget(t, g, { permitTty: 'no' });
  const store = await storeFor(t, target);
  const attempt = async (id) => {
    const l = launcherFor(t, store, target.sshEnv);
    await l.hello();
    openTerminal({ l, remoteId: 'alpha' }, id, ['true']);
    const f = await l.waitFor(x => x.id === id && ['error', 'ptyStarted'].includes(x.type), { timeoutMs: 15_000 });
    l.kill();
    return f;
  };
  const direct = await attempt('d1');
  assert.deepEqual([direct.type, direct.code], ['error', 'EPTY'], `direct: ${JSON.stringify(direct)}`);
  await target.transport().connect(target.config);
  const viaMux = await attempt('m1');
  assert.deepEqual([viaMux.type, viaMux.code], ['error', 'EPTY'], `mux: ${JSON.stringify(viaMux)}`);

  await target.transport().disconnect(target.config);
  const re = await inTarget(g.cli, target.name, 'printf "PermitTTY yes\\n" > /etc/ssh/sshd_config.d/00-tty.conf && kill -HUP 1');
  assert.equal(re.code, 0, re.stderr);
  assert.ok(await settle(async () => (await attempt(`y${Date.now()}`)).type === 'ptyStarted', 10_000),
    'with PermitTTY yes the same box opens a terminal');
});

// PINS THE INPUT BOUND ssh actually has (documented in docs/features.md): input
// credit is granted as bytes enter the HOST pty, and behind it ssh's own channel
// window keeps accepting while the far program reads nothing — ~2 MiB
// (measured), far above PTY_INPUT_WINDOW_BYTES. Driven exactly as cc drives it,
// never more than one window ahead of the credit returned, so what this
// measures is where credit STOPS: fixed, and past one window.
live('pty: a far program that reads nothing stalls input at ssh\'s own window, ~2 MiB', async (t, g) => {
  const target = await withSshTarget(t, g);
  const store = await storeFor(t, target);
  const l = launcherFor(t, store, target.sshEnv);
  await l.hello();
  openTerminal({ l, remoteId: 'alpha' }, 's1', ['sh', '-c', 'stty raw -echo; echo READY; exec sleep 1000']);
  await until(l, 's1', /READY/);
  const CHUNK = 64 * 1024;
  const chunk = Buffer.alloc(CHUNK, 0x61).toString('base64');
  let sent = 0;
  let last = -1;
  // Send while credit allows; settled once a whole second brings no new credit.
  await settle(async () => {
    while (sent + CHUNK - creditedOf(l, 's1') <= PTY_INPUT_WINDOW_BYTES) {
      l.send({ type: 'input', id: 's1', dataB64: chunk });
      sent += CHUNK;
    }
    const now = creditedOf(l, 's1');
    if (now === last) return true;
    last = now;
    await new Promise(r => setTimeout(r, 1_000));
    return false;
  }, 60_000);
  const credited = creditedOf(l, 's1');
  assert.ok(credited >= 1024 * 1024 && credited <= 3 * 1024 * 1024, `about ssh's 2 MiB window (${credited})`);
  // The sender is saturated: what is out uncredited is within one chunk of a
  // whole window, so credit — not the sender — is what stopped.
  assert.ok(sent - credited > PTY_INPUT_WINDOW_BYTES - CHUNK && sent - credited <= PTY_INPUT_WINDOW_BYTES,
    `and then it stops, with a window outstanding (${sent - credited})`);
  assert.equal(framesOf(l, 's1').some(f => f.type === 'exit' || f.type === 'error'), false, 'the terminal stays open');
  l.send({ type: 'close', id: 's1' });
});

for (const item of ROSTER) {
  test(`live: ${item.name}`, async (t) => {
    const g = await skipUnlessSsh(t);
    if (!g) return;
    await item.fn(t, g);
    ran += 1;
  });
}

// THE COUNT PROOF, IN BOTH DIRECTIONS — the assertion tests/dockerkind.test.mjs
// says outright that the docker suite lacks ("no skip count is asserted
// anywhere"). The wrong implementation it catches is the one that file admits it
// cannot: a live suite that silently skips everything while `npm test` stays
// green, so a broken transport reads as a clean run.
//
// Deterministic because node:test runs a file's top-level tests sequentially, so
// every roster test has settled before this one is entered. It does NOT skip
// itself — it must assert in both directions.
test('the live ssh roster ALL ran or ALL skipped, and it is not empty', async () => {
  const g = await resolveSshGate();
  assert.ok(ROSTER.length > 0,
    'an empty roster must not be able to pass as a clean skip');
  assert.equal(new Set(ROSTER.map(r => r.name)).size, ROSTER.length, 'no duplicate roster names');
  if (g) {
    assert.equal(ran, ROSTER.length,
      `the gate was OPEN, so every live test must have run: ${ran}/${ROSTER.length}`);
  } else {
    assert.equal(ran, 0,
      `the gate was CLOSED, so no live test may have run: ${ran} did`);
  }
});
