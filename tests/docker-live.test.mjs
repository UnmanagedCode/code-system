// THE DOCKER TRANSPORT AGAINST A REAL CONTAINER.
//
// Every test here is registered from a ROSTER and calls `skipUnlessDocker`
// first, so `npm test` stays green and docker-free — each skip prints a reason
// naming both invocations tried and the CODE_SYSTEM_DOCKER override. On a host
// where the daemon answers, they run for real.
//
// THE ROSTER IS PROVED TO HAVE RUN, BY COUNT, IN BOTH DIRECTIONS — the last
// test in this file. Without it a suite that skips everything is
// indistinguishable from one that passes everything, and a green `npm test`
// would be evidence of nothing. Add a test with `live(...)`, never a bare
// `test(...)`, or the proof cannot see it.
//
//   npm test                                              # skips, loudly
//   CODE_SYSTEM_DOCKER='["sudo","-n","docker"]' npm test   # runs
//
// THE FIXTURES CREATE AND DESTROY CONTAINERS; THE PROVIDER NEVER DOES. That
// asymmetry is acceptance 9, and the provider half of it is enforced in
// kinds/docker.mjs and pinned by tests/dockerkind.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_SCRIPT, parseProbeOutput } from '../src/baseline.mjs';
import { createDockerTransport } from '../src/launcher/kinds/docker.mjs';
import { buildReapScript } from '../src/launcher/kinds/reapscript.mjs';
import { makeRunner } from '../src/launcher/run.mjs';
import { SCHEMA } from '../src/store.mjs';
import { Launcher, tempStore, writeRecord } from './helpers.mjs';
import {
  countingShim, inContainer, markerCount, resolveDockerCli, run, settle, skipUnlessDocker,
  tempDir, withContainer,
} from './dockerFixture.mjs';

const BUSYBOX = 'busybox:1.38.0';

function dockerRecord(remoteId, container, over = {}) {
  return {
    schema: SCHEMA,
    remoteId,
    kind: 'docker',
    label: remoteId,
    config: { container },
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

// A distinctive number used as a `sleep` duration, so BOTH the shell and its
// `sleep` child carry it in /proc/<pid>/cmdline. Fresh per use so two tests in
// the same container cannot see each other's processes.
let markerSeq = 0;
const newMarker = () => String(700000000 + process.pid % 10000 * 1000 + markerSeq++);

function launcherFor(t, store, cli, extraEnv = {}) {
  const l = new Launcher(['--kind', 'docker'], {
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_DOCKER: JSON.stringify(cli),
    // PINNED TO THE SHIPPED DEFAULT, not inherited. `Launcher` spreads
    // `process.env`, so an operator running the suite with the kill switch set
    // would otherwise turn every channel row below into a test of something
    // else — silently, and green. `extraEnv` can still override it.
    CODE_SYSTEM_CHANNEL: '1',
    ...extraEnv,
  });
  t.after(() => l.kill());
  return l;
}

// THE ROSTER. Every live test is registered from here rather than calling
// `test()` directly, so the count proof at the bottom of this file has
// something to count. Adding a test means adding a `live(...)` — a bare
// `test()` would be invisible to the proof.
const ROSTER = [];
const live = (name, fn) => ROSTER.push({ name, fn });

// ── L1: the happy path, through the SHIPPED launcher ─────────────────

// PINS the whole shipped path — main.mjs arg parsing, kind dispatch,
// StoreRemoteSource lookup, spawnPlan, the frame loop — reaching a real
// container; that `-w` really sets the working directory; and that CC_REMOTE
// really lands in the environment of the child the exec started. The last is
// §10's CC_REMOTE row asserted ON THE CONTAINER'S OWN ANSWER rather than on the
// command merely succeeding, which is what a misroute also looks like.
live('a routed exec reaches the container, at the requested cwd, knowing its remote id', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));

  const l = launcherFor(t, store, d.cli);
  await l.hello();
  l.send({ type: 'exec', id: 'e1', remoteId: 'alpha', cwd: '/tmp', argv: ['/bin/sh', '-c', 'echo $CC_REMOTE; pwd'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'e1');
  assert.equal(exit.code, 0, `stderr=${textOf(l.frames, 'e1', 'stderr')}`);
  assert.equal(textOf(l.frames, 'e1'), 'alpha\n/tmp\n');
});

// ── L2: the NEGATIVE CONTROL the reap tests rest on ──────────────────

// PINS the premise of protocol MUST 3 for this kind: a `docker exec` child is
// NOT an OS descendant of its host client and does NOT die with it. Without
// this, every reap test below would pass even if `reap` did nothing — a kind
// whose children died with their proxy needs no relay at all. This is the test
// that makes the reap tests discriminating rather than decorative.
live('NEGATIVE CONTROL — killing the host docker client leaves the container process running', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const marker = newMarker();
  t.after(() => inContainer(d.cli, box,
    'for p in /proc/[0-9]*; do case "$(tr \'\\0\' \' \' < "$p/cmdline" 2>/dev/null)" in'
    + ' *"$CC_MARKER"*) kill -9 "${p#/proc/}" 2>/dev/null ;; esac; done; true',
    { env: { CC_MARKER: marker } }));

  const { spawn } = await import('node:child_process');
  const host = spawn(d.cli[0], [...d.cli.slice(1), 'exec', '--', box, '/bin/sh', '-c', `sleep ${marker}`],
    { stdio: 'ignore' });

  assert.equal(await settle(async () => (await markerCount(d.cli, box, marker)) > 0), true,
    'the container process must start before the control means anything');

  host.kill('SIGKILL');
  await new Promise(r => host.on('close', r));
  // Give any reparenting/teardown a chance to happen; the point is that it does
  // not, so a settle window here can only weaken the assertion, never fake it.
  await settle(() => false, 500);
  assert.ok(await markerCount(d.cli, box, marker) > 0,
    'a docker exec child survives its host client — this is why the provider must relay the kill');
});

// ── L3: MUST 3 on stdin EOF ──────────────────────────────────────────

/** Three live `sleep <marker>` execs plus a barrier proving they were spawned. */
async function threeLive(t, cli, box, store) {
  const l = launcherFor(t, store, cli);
  await l.hello();
  const markers = ['a', 'b', 'c'].map(() => newMarker());
  markers.forEach((m, i) => l.send({
    type: 'exec', id: ['a', 'b', 'c'][i], remoteId: 'alpha', cwd: '/tmp',
    argv: ['/bin/sh', '-c', `sleep ${m}`],
  }));
  // A DETERMINISTIC BARRIER, not a sleep: frames are handled in arrival order,
  // so this one's `exit` proves the three execs were already spawned.
  l.send({ type: 'exec', id: 'barrier', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier');
  for (const m of markers) {
    assert.equal(await settle(async () => (await markerCount(cli, box, m)) > 0), true,
      `marker ${m} must be running in the container before the kill is asserted`);
  }
  t.after(() => inContainer(cli, box,
    'for p in /proc/[0-9]*; do c=$(tr \'\\0\' \' \' < "$p/cmdline" 2>/dev/null); for m in $CC_MARKERS; do'
    + ' case "$c" in *"$m"*) kill -9 "${p#/proc/}" 2>/dev/null ;; esac; done; done; true',
    { env: { CC_MARKERS: markers.join(' ') } }));
  return { l, markers };
}

// PINS acceptance 3, PROVED against a real container rather than asserted: stdin
// EOF SIGKILLs the in-flight work INSIDE the container. 2000 ms is cc's own
// DEFAULT_SHUTDOWN_GRACE_MS — past it cc SIGKILLs us mid-reap and the orphans
// survive anyway. A no-op `reap` reds the marker assertion, and it reds
// BECAUSE the negative control above pins that the host-side kill alone leaves
// them running.
live('stdin EOF SIGKILLs every in-flight exec inside the container, inside the grace', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const { l, markers } = await threeLive(t, d.cli, box, store);

  const started = Date.now();
  l.closeStdin();
  const { code } = await l.exited;
  assert.equal(code, 0, 'a provider exits when its stdin closes');
  assert.ok(Date.now() - started < 2_000,
    "reaping must finish inside cc's own 2000ms shutdown grace");
  for (const m of markers) {
    assert.equal(await markerCount(d.cli, box, m), 0, `marker ${m} survived the reap`);
  }
});

// ── L4: `close` is per-handle and token-scoped ───────────────────────

// PINS that the reap is scoped to ONE exec's token, not to the container: a
// mutant reaping by container kills the other two and reds. The MIDDLE of three
// is chosen so a first/last-live heuristic cannot pass by accident, for the
// reason tests/launcher-frames.test.mjs sets out.
live('`close` reaps that id alone and leaves the other execs running', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const { l, markers } = await threeLive(t, d.cli, box, store);

  // MEASURE the steady state rather than asserting a literal: nothing in
  // `threeLive` fixes how many container processes one `sleep <marker>` exec
  // owns, and a hardcoded 2 would be an unestablished claim that could drift
  // with the image's shell.
  const baseline = {};
  for (const m of markers) baseline[m] = await markerCount(d.cli, box, m);
  for (const m of markers) assert.ok(baseline[m] > 0, `marker ${m} must be live before the close`);

  const before = l.frames.length;
  l.send({ type: 'close', id: 'b' });
  // Another exec as the barrier: its exit proves `close` was already handled.
  l.send({ type: 'exec', id: 'barrier2', remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'barrier2');

  assert.equal(await settle(async () => (await markerCount(d.cli, box, markers[1])) === 0), true,
    'the closed id\'s container process must be gone');
  assert.equal(await markerCount(d.cli, box, markers[0]), baseline[markers[0]],
    'the first exec must be untouched — the reap is token-scoped, not container-scoped');
  assert.equal(await markerCount(d.cli, box, markers[2]), baseline[markers[2]],
    'the third exec must be untouched');
  assert.equal(l.frames.slice(before).filter(f => f.id === 'b').length, 0,
    'no further frames are emitted for a closed id');

  l.closeStdin();
  await l.exited;
  for (const m of markers) assert.equal(await markerCount(d.cli, box, m), 0);
});

// ── L5: a TERMINATED exec is reaped too ──────────────────────────────

// PINS the two sites docs/architecture.md stated the principle for and its
// enumeration missed. A `timeoutMs` expiry and a `signal` frame kill the HOST
// docker client while the container process keeps running (L2), so without a
// reap here the launcher reports `{code:124, timedOut:true}` — cc's own "the
// provider killed it" — for a command that is still running in the container.
// A reap-only-on-`close` mutant reds both halves.
live('a timed-out exec is reaped in the container, not just reported as killed', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const marker = newMarker();

  const l = launcherFor(t, store, d.cli);
  await l.hello();
  l.send({
    type: 'exec', id: 'to', remoteId: 'alpha', cwd: '/tmp', timeoutMs: 2_000,
    argv: ['/bin/sh', '-c', `sleep ${marker}`],
  });
  assert.equal(await settle(async () => (await markerCount(d.cli, box, marker)) > 0, 1_500), true,
    'the container process must be running before the timeout fires, or this pins nothing');

  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'to');
  assert.equal(exit.code, 124, 'timeout is reported as timeout(1) does');
  assert.equal(exit.timedOut, true);
  assert.equal(exit.descendantsMaySurvive, true,
    'no process-group reach into the container, so the result must say so');
  assert.equal(await settle(async () => (await markerCount(d.cli, box, marker)) === 0), true,
    'and the container-side process is actually gone, not merely reported dead');
});

live('a `signal` frame reaps the container-side process too', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const marker = newMarker();

  const l = launcherFor(t, store, d.cli);
  await l.hello();
  l.send({ type: 'exec', id: 'sg', remoteId: 'alpha', cwd: '/tmp', argv: ['/bin/sh', '-c', `sleep ${marker}`] });
  assert.equal(await settle(async () => (await markerCount(d.cli, box, marker)) > 0), true);

  l.send({ type: 'signal', id: 'sg', signal: 'SIGTERM' });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'sg');
  // The SAME honesty the timeout path is held to: we have no process-group
  // reach into the container, so a result we terminated must say descendants
  // may have survived — the reap runs AFTER the exit frame. A mutant that kills
  // correctly but never sets `orphaned` would otherwise pass this test.
  assert.equal(exit.descendantsMaySurvive, true);
  assert.equal(exit.timedOut, false, 'a signal is not a timeout');
  assert.equal(await settle(async () => (await markerCount(d.cli, box, marker)) === 0), true,
    'a signalled exec leaves nothing running in the container');
});

// ── L6: a natural exit is NOT reaped, and the override is real ───────

// PINS two things at once. (i) The deliberate no-reap-on-natural-exit rule
// ("Reviewed twice; do not re-litigate") survives the new reap-on-terminate
// path — otherwise every command costs a second ~106 ms round trip into the
// container. (ii) Acceptance 10 END TO END: the launcher really invokes the
// OVERRIDDEN argv, which no pure test can show.
live('five commands that exit on their own cost exactly five docker invocations', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);

  const l = launcherFor(t, store, shim.argv);
  await l.hello();
  for (let i = 0; i < 5; i++) {
    l.send({ type: 'exec', id: `n${i}`, remoteId: 'alpha', cwd: '/tmp', argv: ['printf', 'ok'] });
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === `n${i}`);
    assert.equal(exit.code, 0, `the OVERRIDDEN docker argv really ran: ${textOf(l.frames, `n${i}`, 'stderr')}`);
    assert.equal(textOf(l.frames, `n${i}`), 'ok');
  }

  const calls = await shim.calls();
  assert.equal(calls.length, 5, `exactly one docker invocation per command; got ${JSON.stringify(calls)}`);
  assert.ok(calls.every(c => c.startsWith('exec ')), 'and every one of them is an `exec`');
});

// ── L7: inherit vs replace, against the container ────────────────────

// PINS the one thing a pure spawnPlan test cannot reach: that `env -i` really
// clears the CONTAINER's environment, and that an absent frame `env` really
// leaves the container's own toolchain intact.
//
// HOME IS THE DISCRIMINATOR. An overlay via `docker exec -e` leaves HOME=/root
// and would pass every other assertion in this test; only a real replacement
// makes it UNSET. Measured both ways.
live('an absent env inherits the CONTAINER\'s environment; a supplied env replaces it', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));

  const l = launcherFor(t, store, d.cli);
  await l.hello();
  const show = ['/bin/sh', '-c', 'echo "$PATH"; echo "[${HOME-UNSET}]"; echo "$CC_REMOTE"'];

  // (a) INHERIT.
  l.send({ type: 'exec', id: 'inh', remoteId: 'alpha', cwd: '/tmp', argv: show });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'inh')).code, 0);
  const [inhPath, inhHome, inhRemote] = textOf(l.frames, 'inh').trim().split('\n');
  assert.notEqual(inhPath, process.env.PATH,
    'this fixture cannot discriminate: the launcher\'s PATH and the container\'s are identical');
  assert.match(inhPath, /\/usr\/local\/bin/, "the CONTAINER's PATH, not cc's host PATH");
  assert.equal(inhHome, '[/root]', "and the container's own HOME");
  assert.equal(inhRemote, 'alpha');

  // (b) REPLACE, with a colliding CC_REMOTE.
  l.send({
    type: 'exec', id: 'rep', remoteId: 'alpha', cwd: '/tmp', argv: show,
    env: { PATH: '/usr/bin', CC_REMOTE: 'frame-supplied' },
  });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'rep')).code, 0,
    textOf(l.frames, 'rep', 'stderr'));
  const [repPath, repHome, repRemote] = textOf(l.frames, 'rep').trim().split('\n');
  assert.equal(repPath, '/usr/bin');
  assert.equal(repHome, '[UNSET]',
    'HOME must be GONE — an -e overlay would leave /root and pass every other assertion here');
  assert.equal(repRemote, 'alpha', "the provider's binding beats the frame-supplied CC_REMOTE");
});

// ── L8: cwd '/' and the dangerous derivation ─────────────────────────

// PINS acceptance 5 against a real container, and that the one §7 derivation
// cc's own docs call "the dangerous one" answers with real sub-second precision
// on this image. A fence on `/`, or a dropped `-w`, reds it.
live("cwd '/' is served, and `stat` answers with sub-second mtime precision", async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));

  const l = launcherFor(t, store, d.cli);
  await l.hello();
  l.send({ type: 'exec', id: 's', remoteId: 'alpha', cwd: '/', argv: ['stat', '-L', '-c', '%f %s %.3Y', '--', '/'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 's');
  assert.equal(exit.code, 0, textOf(l.frames, 's', 'stderr'));
  assert.match(textOf(l.frames, 's'), /\d+\.\d{3}/, 'busybox stat succeeds here and silently drops the fraction');

  // And the placeholder really was the working directory, not a rewritten one.
  l.send({ type: 'exec', id: 'pwd', remoteId: 'alpha', cwd: '/', argv: ['pwd'] });
  await l.waitFor(f => f.type === 'exit' && f.id === 'pwd');
  assert.equal(textOf(l.frames, 'pwd'), '/\n');
});

// ── L9: readFile/writeFile INHERITED, over docker exec ───────────────

// PINS acceptance 2: the shared fileops.mjs scripts, the per-call CCERR-<nonce>
// tagging and the `set -C` guarantee all hold over `docker exec -i` with the
// payload on stdin, with NO docker-specific file code anywhere.
//
// THE CONTENT ROUND TRIP IS WHAT CATCHES A DROPPED `-i`: without it `base64 -d`
// sees immediate EOF and writes a ZERO-BYTE FILE WITH EXIT 0, so a
// mode-and-success-only test would pass a completely broken write.
live('readFile/writeFile work over docker exec, with every code cc branches on', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));

  const l = launcherFor(t, store, d.cli);
  await l.hello();
  const body = Buffer.from('hello from the container\n#!/bin/sh\n');

  const write = async (id, path, data, over = {}) => {
    l.send({ type: 'writeFile', id, remoteId: 'alpha', path, ...over });
    l.send({ type: 'data', id, seq: 0, dataB64: data.toString('base64') });
    l.send({ type: 'end', id });
    return l.waitFor(f => (f.type === 'writeFileResult' || f.type === 'error') && f.id === id);
  };
  const read = async (id, path, over = {}) => {
    l.send({ type: 'readFile', id, remoteId: 'alpha', path, ...over });
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
  assert.deepEqual(bytesOf(l.frames, 'r1'), body, 'the bytes round-trip — a dropped -i writes zero bytes and exits 0');

  // An atomic write carries the REQUESTED mode through the rename — the chmod
  // lands on the temp before it is installed, so an edited script does not come
  // back 0644 and stop being executable.
  assert.equal((await write('w2', '/tmp/exec.sh', body, { atomic: true, mode: 0o100755 })).type, 'writeFileResult');
  const r2 = await read('r2', '/tmp/exec.sh');
  assert.equal(r2.mode & 0o7777, 0o755, 'the requested mode survived the rename');

  // A PLAIN write over an existing file preserves that file's mode, matching
  // fs.writeFile — routing it through temp-then-rename would silently reset it.
  assert.equal((await write('w2b', '/tmp/exec.sh', Buffer.from('again\n'))).type, 'writeFileResult');
  assert.equal((await read('r2b', '/tmp/exec.sh')).mode & 0o7777, 0o755,
    'a plain write must not reset an existing mode');

  // The four codes cc's callers branch on.
  const exists = await write('w3', '/tmp/exec.sh', body, { exclusive: true });
  assert.equal(exists.type, 'error');
  assert.equal(exists.code, 'EEXIST', '"create unless it already exists" is written as catch-EEXIST');

  assert.equal((await read('r3', '/tmp')).code, 'EISDIR');
  assert.equal((await read('r4', '/tmp/definitely-absent')).code, 'ENOENT');

  // A ranged read returns the range, with the WHOLE FILE's size.
  const r5 = await read('r5', '/tmp/f.txt', { offset: 6, length: 4 });
  assert.equal(r5.type, 'readFileResult');
  assert.equal(r5.size, body.length, 'size is the file, not the range');
  assert.deepEqual(bytesOf(l.frames, 'r5'), body.subarray(6, 10));
});

// ── L9b: the remote's configured identity, for real ──────────────────

// PINS THE WHOLE POINT OF `config.user` against a real daemon, on BOTH paths
// that matter — and the second is the one nothing else proves: a derived file
// operation has no docker-specific code at all, it rides the same `spawnPlan`
// through run.mjs, so the OWNER of a written file is the only evidence that the
// identity really governs the file path and not just `exec`.
//
// Measured on Docker 29.7.2: a uid with no passwd entry (`-u 9999:9999`)
// SUCCEEDS, so there is nothing cheap to pre-validate — a rejected identity can
// only be caught per operation, and it must arrive as a NAMED refusal pointing
// at the card's field rather than as a bogus command exit.
live('a configured identity governs exec AND the derived file operations', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box, { config: { container: box, user: 'node' } }));
  await writeRecord(store.dir, dockerRecord('ghost', box, { config: { container: box, user: 'nosuchuser' } }));

  const l = launcherFor(t, store, d.cli);
  await l.hello();

  // 1. THE EXEC runs as the configured identity — the container's own answer,
  //    not ours. node:24-slim's `node` user is uid 1000; the image default is 0.
  l.send({ type: 'exec', id: 'who', remoteId: 'alpha', cwd: '/tmp', argv: ['/usr/bin/id', '-u'] });
  const who = await l.waitFor(f => f.type === 'exit' && f.id === 'who');
  assert.equal(who.code, 0, `stderr=${textOf(l.frames, 'who', 'stderr')}`);
  assert.equal(textOf(l.frames, 'who').trim(), '1000',
    'the exec ran as the card\'s identity, not as the image default (0)');

  // 2. THE FILE OPERATION rides the same path, proved by who OWNS the file.
  l.send({ type: 'writeFile', id: 'w', remoteId: 'alpha', path: '/tmp/owned.txt' });
  l.send({ type: 'data', id: 'w', seq: 0, dataB64: Buffer.from('mine\n').toString('base64') });
  l.send({ type: 'end', id: 'w' });
  const wrote = await l.waitFor(f => (f.type === 'writeFileResult' || f.type === 'error') && f.id === 'w');
  assert.equal(wrote.type, 'writeFileResult', JSON.stringify(wrote));

  l.send({ type: 'exec', id: 'own', remoteId: 'alpha', cwd: '/tmp', argv: ['/usr/bin/stat', '-c', '%u', '/tmp/owned.txt'] });
  const own = await l.waitFor(f => f.type === 'exit' && f.id === 'own');
  assert.equal(own.code, 0, `stderr=${textOf(l.frames, 'own', 'stderr')}`);
  assert.equal(textOf(l.frames, 'own').trim(), '1000',
    'writeFile went through the same spawnPlan — a file-op path that ignored the identity would be root-owned');

  // 3. AN IDENTITY THE CONTAINER REJECTS is a named refusal pointing at the
  //    field, not an `exit` frame carrying docker's own exit 1.
  l.send({ type: 'exec', id: 'bad', remoteId: 'ghost', cwd: '/tmp', argv: ['/usr/bin/id', '-u'] });
  const err = await l.waitFor(f => (f.type === 'error' || f.type === 'exit') && f.id === 'bad');
  assert.equal(err.type, 'error', JSON.stringify(err));
  assert.equal(err.code, 'EUNKNOWN', 'never ENOREMOTE — the container is fine');
  assert.match(err.message, /Run as/, 'and it names the field on the card that fixes it');
  assert.match(err.message, new RegExp(box), 'and the configured container');
  assert.match(err.message, /nosuchuser/, 'and the identity that was refused');

  // ONE BROKEN REMOTE IS NOT A BROKEN CONNECTION.
  l.send({ type: 'exec', id: 'still', remoteId: 'alpha', cwd: '/tmp', argv: ['/usr/bin/id', '-u'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'still')).code, 0);
});

// ── L10: a real busybox target is refused BY NAME ────────────────────

// PINS acceptance 7 against a live busybox, and the reason the probe asserts on
// OUTPUT SHAPE rather than exit codes: busybox is a PARTIAL failure whose `stat`
// SUCCEEDS while being wrong (no sub-second field), which is the one degradation
// cc never surfaces on its own.
//
// FOUR capabilities, not the three cc's own §11 note lists: our `shell` row is
// `[ -x /bin/bash ]` and busybox has no bash. A test written to three would red.
live('a real busybox container fails the baseline, and the launcher refuses it BY NAME', async (t, d) => {
  const bb = await withContainer(t, d.cli, { image: BUSYBOX, stem: 'busybox' });

  const runner = makeRunner(createDockerTransport({ cli: d.cli }), { container: bb }, 'bb');
  const res = await runner({ script: PROBE_SCRIPT });
  assert.equal(res.code, 0, `the probe itself must run to completion: ${res.stderr}`);
  const parsed = parseProbeOutput(res);

  assert.equal(parsed.state, 'unsupported');
  assert.deepEqual(parsed.missing.map(m => m.capability), ['readDir', 'realpath', 'stat', 'shell']);
  const by = Object.fromEntries(parsed.missing.map(m => [m.capability, m]));
  assert.match(by.readDir.detail, /unrecognized: -printf/, "busybox find's own words");
  assert.match(by.stat.detail, /sub-second/, 'the silent degradation, named');
  assert.match(by.stat.detail, /\d{9,}/, 'and quoting the epoch the target actually answered');
  assert.equal(by.stat.detail.includes('.'), false, 'busybox answered a whole-second mtime');

  // A record carrying that verdict refuses the target WHOLE — every request
  // frame, id-addressed, naming the missing capability, and NO exit frame.
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('bb', bb, {
    baseline: { state: 'unsupported', fingerprint: 'docker:x:y', missing: parsed.missing, checkedAt: null },
  }));
  const l = launcherFor(t, store, d.cli);
  await l.hello();
  l.send({ type: 'exec', id: 'x', remoteId: 'bb', cwd: '/', argv: ['true'] });
  l.send({ type: 'readFile', id: 'y', remoteId: 'bb', path: '/etc/hostname' });
  for (const id of ['x', 'y']) {
    const err = await l.waitFor(f => f.type === 'error' && f.id === id);
    assert.equal(err.code, 'EUNKNOWN');
    assert.match(err.message, /readDir/, 'the refusal names what was missing');
  }
  assert.equal(l.frames.some(f => f.type === 'exit'), false, 'refused whole — never a plausible exit');
});

// ── L11: a stopped and a missing container are ENOREMOTE ─────────────

// PINS acceptance 8 for the two cases the DOCKER kind owns (an unknown remote
// *id* is already pinned generically by tests/launcher-frames.test.mjs). Both
// arrive as a non-zero exit of the docker CLI, so without `classifyFailure` the
// exec would be an ordinary `exit` frame and the read a bare EUNKNOWN — both
// wrong, and both invisible without this test.
//
// Plus §9's "one dead remote is not a dead connection": the answers are
// id-addressed, and the live remote is still served afterwards.
live('a stopped and a non-existent container each answer ENOREMOTE, id-addressed', async (t, d) => {
  const running = await withContainer(t, d.cli);
  const stopped = await withContainer(t, d.cli, { stem: 'stopped' });
  // THE FIXTURE may stop a container. The provider never may — pinned in
  // tests/dockerkind.test.mjs.
  assert.equal((await run([...d.cli, 'stop', '-t', '0', stopped])).code, 0);

  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alive', running));
  await writeRecord(store.dir, dockerRecord('dead', stopped));
  await writeRecord(store.dir, dockerRecord('ghost', 'code-system-test-no-such-container'));

  const l = launcherFor(t, store, d.cli);
  await l.hello();

  for (const [remoteId, container] of [['dead', stopped], ['ghost', 'code-system-test-no-such-container']]) {
    l.send({ type: 'exec', id: `e-${remoteId}`, remoteId, cwd: '/', argv: ['true'] });
    const eErr = await l.waitFor(f => f.type === 'error' && f.id === `e-${remoteId}`);
    assert.equal(eErr.code, 'ENOREMOTE', JSON.stringify(eErr));
    assert.equal(typeof eErr.id, 'string');
    assert.match(eErr.message, new RegExp(container), 'the message names the CONFIGURED container');

    l.send({ type: 'readFile', id: `r-${remoteId}`, remoteId, path: '/etc/hostname' });
    const rErr = await l.waitFor(f => f.type === 'error' && f.id === `r-${remoteId}`);
    assert.equal(rErr.code, 'ENOREMOTE', JSON.stringify(rErr));
    assert.match(rErr.message, new RegExp(container));
  }
  assert.match(l.frames.find(f => f.type === 'error' && f.id === 'e-dead').message, /ATTACH-ONLY/,
    'a stopped container is not something this provider offers to start');
  assert.equal(l.frames.some(f => f.type === 'exit'), false, 'no exit frame for a transport failure');

  // ONE DEAD REMOTE IS NOT A DEAD CONNECTION.
  l.send({ type: 'exec', id: 'ok', remoteId: 'alive', cwd: '/tmp', argv: ['printf', 'still here'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'ok')).code, 0);
  assert.equal(textOf(l.frames, 'ok'), 'still here');
});

// ── L12: an id is bound to one remote, for life ──────────────────────

// PINS acceptance 6. A CC_REMOTE-only assertion passes even if both ids exec
// into the SAME container, so the container's own hostname is what makes a
// misroute visible.
live('every operation routes on its remoteId, and the routed container really differs', async (t, d) => {
  const one = await withContainer(t, d.cli);
  const two = await withContainer(t, d.cli, { image: BUSYBOX, stem: 'busybox' });
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('one', one));
  await writeRecord(store.dir, dockerRecord('two', two));

  const hostnames = {};
  for (const [id, ctr] of [['one', one], ['two', two]]) {
    hostnames[id] = (await inContainer(d.cli, ctr, 'cat /etc/hostname')).stdout.trim();
  }
  assert.notEqual(hostnames.one, hostnames.two, 'two containers, two identities');

  const l = launcherFor(t, store, d.cli);
  await l.hello();
  for (const id of ['one', 'two']) {
    l.send({
      type: 'exec', id: `x-${id}`, remoteId: id, cwd: '/',
      argv: ['/bin/sh', '-c', 'cat /etc/hostname; echo "$CC_REMOTE"'],
    });
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === `x-${id}`);
    assert.equal(exit.code, 0, textOf(l.frames, `x-${id}`, 'stderr'));
    assert.deepEqual(textOf(l.frames, `x-${id}`).trim().split('\n'), [hostnames[id], id],
      'the argv carried the ROUTED container, and the far side agrees which remote it is');
  }
});

// ── the `env -i` operand boundary, run for real ──────────────────────

// PINS THE FIX FOR AN OPTION INJECTION, against a real container rather than on
// the argv. Frame-supplied env KEYS are arbitrary; GNU `env` reads leading-`-`
// operands as its own options until a non-option operand. Measured in this
// image (coreutils 9.1), with `-w /`:
//
//   env -i    '--chdir=/tmp' PATH=/usr/bin pwd  → /tmp   cwd HIJACKED
//   env -i -- '--chdir=/tmp' PATH=/usr/bin pwd  → /      the -w holds
//
// So without the `--` a frame silently relocates the command while cc believes
// it ran at the `cwd` it sent — and on coreutils 9.7 `--argv0=` spoofs $0 while
// 9.1 refuses the exec outright. Dropping the `--` reds this.
live('a frame env key shaped like an option cannot hijack the command', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));

  const l = launcherFor(t, store, d.cli);
  await l.hello();
  l.send({
    type: 'exec', id: 'inj', remoteId: 'alpha', cwd: '/tmp',
    argv: ['/bin/sh', '-c', 'pwd; echo "$0"'],
    // `/` exists in every image, so a successful hijack is VISIBLE as a
    // different cwd rather than as a failure that could have many causes.
    env: { '--chdir=/': '', '--argv0=EVIL': '', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'inj');
  assert.equal(exit.code, 0,
    `the exec must still run: ${textOf(l.frames, 'inj', 'stderr')}`);
  const [cwd, argv0] = textOf(l.frames, 'inj').trim().split('\n');
  assert.equal(cwd, '/tmp', 'the frame\'s cwd held — `--chdir` was an assignment, not an option');
  assert.notEqual(argv0, 'EVIL', '`--argv0` was an assignment, not an option');

  // The inherit path takes each `-e` value as a separate argv token, so the
  // same key cannot reach docker as an option there either.
  l.send({ type: 'exec', id: 'inj2', remoteId: 'alpha', cwd: '/tmp', argv: ['pwd'] });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'inj2')).code, 0);
  assert.equal(textOf(l.frames, 'inj2'), '/tmp\n');
});

// ── the reap relay detects its own blindness, for real ───────────────

// PINS that the relay reports whether it could see anything. Without `tr`, or on
// a target whose /proc/<pid>/environ cannot be read, every `case` matches
// nothing — and an unconditional `exit 0` would report a successful reap while
// the container-side subtree survived. That is the MUST-3 hazard itself, made
// invisible; `baselineRefusal` gates exec and fileops, never `reap`.
//
// Run in BOTH shells this project meets: node:24-slim's dash and busybox's ash.
live('the reap script reports `blind` instead of success when it cannot read /proc', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const bb = await withContainer(t, d.cli, { image: BUSYBOX, stem: 'busybox' });
  const script = buildReapScript('a-token-nothing-carries');

  for (const [name, ctr] of [['node:24-slim/dash', box], ['busybox/ash', bb]]) {
    const ok = await inContainer(d.cli, ctr, script);
    assert.equal(ok.code, 0, `${name}: ${ok.stderr}`);
    assert.match(ok.stdout, /^CCREAP ok 0 \d+$/m,
      `${name} must report how many environs it could read; got ${JSON.stringify(ok.stdout)}`);
    assert.notEqual(ok.stdout.trim().split(' ')[3], '0',
      `${name}: the scanning process can always read its own environ, so this is never 0 when sighted`);

    // The same script with `tr` unreachable: it must NOT claim success.
    const blind = await inContainer(d.cli, ctr, `PATH=/nonexistent-xyz\n${script}`);
    assert.equal(blind.code, 3, `${name} must exit non-zero when blind`);
    assert.match(blind.stdout, /CCREAP blind/, `${name} must say so`);
  }
});

// PINS the transport half: a reap it cannot prove ran THROWS, so session.mjs can
// report it — while the container simply being gone stays quiet, because its
// processes went with it and crying wolf on every shutdown would train the
// warning away.
live('reap throws when the relay cannot be proved, and is quiet when the container is gone', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const tr = createDockerTransport({ cli: d.cli });

  // A live container: the relay runs and proves it.
  await tr.reap({ container: box }, { pid: null, token: 'nothing-carries-this', remoteId: 'alpha' });

  // A container that does not exist: benign, nothing left to reap.
  await tr.reap({ container: 'code-system-test-no-such-container' },
    { pid: null, token: 'x', remoteId: 'alpha' });

  // A container that exists but is stopped: also benign.
  const stopped = await withContainer(t, d.cli, { stem: 'stopped' });
  assert.equal((await run([...d.cli, 'stop', '-t', '0', stopped])).code, 0);
  await tr.reap({ container: stopped }, { pid: null, token: 'x', remoteId: 'alpha' });

  // A docker CLI that cannot be spawned at all is NOT benign — nothing was
  // reaped and the container may well still be running it.
  await assert.rejects(
    () => createDockerTransport({ cli: ['/definitely-not-docker-xyz'] })
      .reap({ container: box }, { pid: null, token: 'x', remoteId: 'alpha' }),
    /may have survived/);
});

// ── L14: the out-of-band half ────────────────────────────────────────
//
// tests/ssh-live.test.mjs pins this for ssh; docker had no equivalent. The card
// UI's whole probe axis rests on it: reachability is re-asked on every render
// and never cached, so a container stopped BEHIND THE PLUGIN'S BACK must read
// as not running on the very next probe.
//
// THE FIXTURE STOPS THE CONTAINER, and that asymmetry is the point: a fixture
// may, the provider may not. The counting shim proves the provider issued only
// `inspect`, so "the container stopped" and "we stopped it" cannot be confused.

live('a container stopped out of band reads as not running, and the provider never stopped it', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);
  // Every provider-side call goes through the shim; the FIXTURE's own calls use
  // d.cli directly, so the log contains the provider's invocations and only
  // those.
  const transport = createDockerTransport({ cli: shim.argv });

  const before = await transport.reachability({ container: box });
  assert.equal(before.connected, true, 'the fixture\'s container is running');
  assert.notEqual(before.fingerprint, null);

  // `docker stop`, by somebody who is not this provider.
  const stopped = await run([...d.cli, 'stop', box]);
  assert.equal(stopped.code, 0, `the fixture could not stop the container: ${stopped.stderr}`);

  const after = await transport.reachability({ container: box });
  assert.equal(after.connected, false, 'the probe re-asked the daemon — nothing was cached');
  assert.match(after.detail, /not running/);
  assert.match(after.detail, /ATTACH-ONLY/, 'and the card says code-system will not start it');
  assert.equal(after.fingerprint, null, 'a stopped container caches no baseline verdict');

  // THE PROVIDER'S OWN LOG. Attach-only is not a claim here — it is what the
  // recorded invocations show.
  const calls = await shim.calls();
  assert.equal(calls.length, 2, 'exactly the two reachability probes');
  for (const c of calls) {
    assert.match(c, /^inspect /, `the provider ran only inspect, not: ${c}`);
  }
  assert.equal(calls.some(c => /\b(start|stop|run|rm|create|restart|kill)\b/.test(c)), false,
    'the provider never mutated the container');
});

// ── L13: the held-open channel, against a real container (card 2026-0021) ──

// cc's derivation envelope on the wire, and two of its rows.
const DERIVE = (id, argv) => ({ type: 'exec', id, remoteId: 'alpha', cwd: '/', stdin: 'ignore', argv });
const LSTAT = (id, p) => DERIVE(id, ['env', 'LC_ALL=C', 'find', p, '-maxdepth', '0', '-printf', '%y\\t%m\\t%s\\t%T@\\t%l\\n']);

// The channel's own invocation, as the counting shim records it: the only
// `docker exec` this provider ever makes with `-i -w /` and no per-op token.
const isChannelCall = (c) => /^exec -i -w \/ /.test(c) && c.endsWith('/bin/sh');

/** Every BARE `/bin/sh` in the container — i.e. every held-open channel. */
async function bareShellCount(cli, container) {
  const res = await inContainer(cli, container, [
    'n=0',
    'for d in /proc/[0-9]*; do',
    '  c=$(tr \'\\0\' \'|\' < "$d/cmdline" 2>/dev/null)',
    '  [ "$c" = "/bin/sh|" ] && n=$((n+1))',
    'done',
    'printf %s "$n"',
  ].join('\n'));
  if (res.code !== 0) throw new Error(`bareShellCount failed: ${res.stderr || res.stdout}`);
  return Number(res.stdout.trim());
}

/**
 * Drive admitted derivations until the channel is OPEN and idle, and answer how
 * many docker invocations that cost. Deterministic: it polls the shim's own log
 * rather than sleeping, and the caller measures from this point on.
 */
async function warmChannel(l, shim) {
  for (let i = 0; i < 60; i++) {
    l.send(LSTAT(`warm${i}`, '/tmp'));
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === `warm${i}`);
    assert.equal(exit.code, 0, `warm ${i} must succeed`);
    const calls = await shim.calls();
    // The channel is open AND idle once a channel call exists and the op that
    // triggered it has settled.
    if (calls.some(isChannelCall) && i > 0) return calls.length;
  }
  throw new Error(`the channel never opened: ${JSON.stringify(await shim.calls())}`);
}

/** A named FIFO in the container, and a `readFile` that blocks for ever on it. */
async function blockingFifo(t, cli, box, marker) {
  const p = `/tmp/ccfifo-${marker}`;
  const res = await inContainer(cli, box, `mkfifo ${p}`);
  assert.equal(res.code, 0, `mkfifo failed: ${res.stderr}`);
  t.after(() => inContainer(cli, box, `rm -f ${p}`));
  return p;
}

// PINS THE SINGLE MEASUREMENT THE WHOLE DESIGN RESTS ON: per-op reap
// granularity survives a SHARED channel. The token rides as the far-side
// command's environment prefix, so `buildReapScript` — unmodified — kills that
// op's whole process tree and nothing else. A channel-wide token would instead
// kill the channel and every other op on it, and the design would be rejected.
live('an op on a shared channel is reaped by its own token, and the channel survives', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);
  const marker = newMarker();
  const fifo = await blockingFifo(t, d.cli, box, marker);

  const l = launcherFor(t, store, shim.argv);
  await l.hello();
  const afterWarm = await warmChannel(l, shim);
  assert.equal(await bareShellCount(d.cli, box), 1, 'exactly one channel is held open');

  // A `readFile` of a FIFO with an explicit length: the far side blocks in
  // `tail | head` until a writer appears, which never happens. It rides the
  // channel (its script comes from fileops.mjs, admitted by provenance) and it
  // is the only op on it.
  l.send({ type: 'readFile', id: 'blocked', remoteId: 'alpha', path: fifo, length: 1_000_000 });
  assert.equal(await settle(async () => (await markerCount(d.cli, box, marker)) > 0), true,
    'the blocked op must really be running in the container before the reap is asserted');
  assert.equal(await shim.calls().then(c => c.length), afterWarm,
    'and it cost NO docker invocation of its own — it rode the channel');

  l.send({ type: 'close', id: 'blocked' });
  assert.equal(await settle(async () => (await markerCount(d.cli, box, marker)) === 0), true,
    "the op's own container-side tree is reaped");
  assert.equal(await bareShellCount(d.cli, box), 1,
    'and the CHANNEL SHELL IS UNTOUCHED — the whole point of the per-op env prefix');

  // The reaped op settles with its sentinel, so the slot goes back to the pool
  // and the next op rides the SAME channel rather than a replacement — at a cost
  // of ZERO further docker invocations. (`before` is taken after the reap, whose
  // own relay is a `docker exec` this provider legitimately makes.)
  const before = await shim.calls().then(c => c.length);
  l.send(LSTAT('after', '/tmp'));
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'after');
  assert.equal(exit.code, 0, 'the channel still serves ops after a reap');
  assert.equal(await shim.calls().then(c => c.length), before,
    'and it cost nothing: the same channel served it');
});

// PINS "0 PROVIDERS LEFT IN BOX" for the channel itself. A `docker exec` child
// is not an OS descendant, so a provider that exits without closing would leak
// one idle `/bin/sh` per container per generation — the rig's measured standard.
live('a launcher that ends leaves no held-open shell in the container', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);

  const l = launcherFor(t, store, shim.argv);
  await l.hello();
  await warmChannel(l, shim);
  assert.ok(await bareShellCount(d.cli, box) > 0, 'a channel is held open before the shutdown');

  l.closeStdin();
  const { code } = await l.exited;
  assert.equal(code, 0);
  assert.equal(await settle(async () => (await bareShellCount(d.cli, box)) === 0), true,
    'no channel survives the provider that opened it');
  assert.match(l.stderr, /channel carried \d+ of \d+ admitted ops on \d+ channels/,
    'and the census line says what it carried');
});

// PINS THAT ADMISSION IS NOT DEAD CODE, end to end and by COUNT: once a channel
// is open, admitted derivations cost ZERO docker invocations. Deterministic —
// the warm-up polls the shim's own log, and the count is taken from that point.
live('once the channel is open, admitted derivations cost no docker invocation at all', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);

  const l = launcherFor(t, store, shim.argv);
  await l.hello();
  const baseline = await warmChannel(l, shim);

  for (let i = 0; i < 10; i++) {
    l.send(LSTAT(`n${i}`, '/tmp'));
    const exit = await l.waitFor(f => f.type === 'exit' && f.id === `n${i}`);
    assert.equal(exit.code, 0, `stderr=${textOf(l.frames, `n${i}`, 'stderr')}`);
    assert.match(textOf(l.frames, `n${i}`), /^d\t/, 'and the answer is really find\'s');
  }
  const calls = await shim.calls();
  assert.equal(calls.length, baseline,
    `ten admitted ops on an open channel cost nothing: ${JSON.stringify(calls.slice(baseline))}`);
  assert.equal(calls.filter(isChannelCall).length, 1, 'and exactly one channel was ever opened');
});

// PINS THAT THE REFUSED PATH IS TODAY'S PATH. `removeTree` is excluded by name
// and a `shell` frame fails the envelope, so each must still cost its own
// `docker exec` — the fallback is real, not a claim.
live('a removeTree and a shell frame each still cost their own docker exec', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);

  const l = launcherFor(t, store, shim.argv);
  await l.hello();
  const baseline = await warmChannel(l, shim);

  l.send(DERIVE('rt', ['env', 'LC_ALL=C', 'rm', '-rf', '--', '/tmp/cc-nothing-here']));
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'rt')).code, 0);
  l.send({ type: 'exec', id: 'sh', remoteId: 'alpha', cwd: '/tmp', shell: 'printf shell' });
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'sh')).code, 0);

  const calls = (await shim.calls()).slice(baseline);
  assert.equal(calls.length, 2, `one docker exec each, and no more: ${JSON.stringify(calls)}`);
  assert.equal(calls.some(isChannelCall), false, 'neither opened a second channel');
});

// PINS THE FAILURE ASYMMETRY at the box: the in-flight op fails `ETRANSPORT`
// (never a retry — a mutating op that LANDED must not run twice), and the next
// frame is served on a fresh channel with no second backoff layer of our own.
live('killing the container-side channel shell fails the in-flight op with ETRANSPORT', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);
  const marker = newMarker();
  const fifo = await blockingFifo(t, d.cli, box, marker);

  const l = launcherFor(t, store, shim.argv);
  await l.hello();
  await warmChannel(l, shim);

  l.send({ type: 'readFile', id: 'doomed', remoteId: 'alpha', path: fifo, length: 1_000_000 });
  assert.equal(await settle(async () => (await markerCount(d.cli, box, marker)) > 0), true,
    'the op must be in flight on the channel before the channel is killed');

  // Kill the CHANNEL SHELL itself — every bare `/bin/sh` in the container.
  await inContainer(d.cli, box, [
    'for d in /proc/[0-9]*; do',
    '  c=$(tr \'\\0\' \'|\' < "$d/cmdline" 2>/dev/null)',
    '  [ "$c" = "/bin/sh|" ] && kill -9 "${d#/proc/}" 2>/dev/null',
    'done; true',
  ].join('\n'));

  const err = await l.waitFor(f => f.type === 'error' && f.id === 'doomed');
  assert.equal(err.code, 'ETRANSPORT',
    'a dead channel is a TRANSPORT failure, kept out of cc\'s errno classifier');

  l.send(LSTAT('next', '/tmp'));
  assert.equal((await l.waitFor(f => f.type === 'exit' && f.id === 'next')).code, 0,
    'and the very next frame is served, on the spawn path or a fresh channel');
});

// PINS THE UNDRAINED-PAYLOAD HAZARD OVER A REAL CONTAINER, at a size that
// matters. The existing readFile/writeFile row exercises `EEXIST` with a
// 34-byte payload, which fits a pipe buffer and so drains incidentally; this one
// uses 256 KiB, where `head` provably dies of EPIPE with the remainder still in
// the CHANNEL's stdin. The refusal must be correct AND the next, unrelated
// operation must still be served.
live('a 256 KiB write refused EEXIST on the channel leaves the next file op working', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);

  const l = launcherFor(t, store, shim.argv);
  await l.hello();
  await warmChannel(l, shim);
  assert.equal((await inContainer(d.cli, box, 'printf taken > /tmp/occupied')).code, 0);

  // 256 KiB of base64-able bytes, sent the way cc sends a writeFile.
  const payload = Buffer.alloc(256 * 1024, 0x7a);
  // The precondition that makes this test ABOUT the channel: the refused write
  // must ride it, not fall back to a per-op spawn.
  const beforeWrite = await shim.calls().then(c => c.length);
  l.send({ type: 'writeFile', id: 'w1', remoteId: 'alpha', path: '/tmp/occupied', exclusive: true });
  for (let at = 0; at < payload.length; at += 64 * 1024) {
    l.send({ type: 'data', id: 'w1', seq: at / (64 * 1024),
      dataB64: payload.subarray(at, at + 64 * 1024).toString('base64') });
  }
  l.send({ type: 'end', id: 'w1' });
  const err = await l.waitFor(f => (f.type === 'error' || f.type === 'writeFileResult') && f.id === 'w1');
  assert.equal(err.type, 'error', `the write must be refused, not accepted: ${JSON.stringify(err)}`);
  assert.equal(err.code, 'EEXIST', `got ${JSON.stringify(err)}`);
  assert.equal(await shim.calls().then(c => c.length), beforeWrite,
    'the refused write rode the channel — it cost no docker invocation of its own');

  // THE ASSERTION THE HAZARD BREAKS: an unrelated op afterwards.
  l.send({ type: 'readFile', id: 'r1', remoteId: 'alpha', path: '/tmp/occupied' });
  const end = await l.waitFor(f => (f.type === 'end' || f.type === 'error') && f.id === 'r1');
  assert.equal(end.type, 'end', `the next file op must be served: ${JSON.stringify(end)}`);
  assert.equal(bytesOf(l.frames, 'r1').toString('utf8'), 'taken',
    'and answer correctly, not with the poisoned channel\'s leftovers');
  // The target was never touched, which is what `exclusive` promises.
  assert.equal((await inContainer(d.cli, box, 'wc -c < /tmp/occupied')).stdout.trim(), '5');
});

// PINS that `classifyFailure`'s operator-facing message is not lost to the
// channel. A stopped container must still answer ENOREMOTE saying the provider
// is attach-only — which is the answer that tells someone what to do — rather
// than the ETRANSPORT the dead channel produced.
live('a container stopped under an open channel still answers ENOREMOTE', async (t, d) => {
  const box = await withContainer(t, d.cli);
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alpha', box));
  const dir = await tempDir(t);
  const shim = await countingShim(dir, d.cli);

  const l = launcherFor(t, store, shim.argv);
  await l.hello();
  await warmChannel(l, shim);

  // THE FIXTURE stops the container; the provider never may.
  assert.equal((await run([...d.cli, 'stop', '-t', '0', box])).code, 0);

  l.send(LSTAT('afterstop', '/tmp'));
  const err = await l.waitFor(f => f.type === 'error' && f.id === 'afterstop');
  assert.equal(err.code, 'ENOREMOTE', `got ${JSON.stringify(err)}`);
  assert.match(err.message, /ATTACH-ONLY/);
});

// ── registration, and the count proof ────────────────────────────────

let ran = 0;
for (const item of ROSTER) {
  test(`live: ${item.name}`, async (t) => {
    const d = await skipUnlessDocker(t);
    if (!d) return;
    await item.fn(t, d);
    ran += 1;
  });
}

// THE COUNT PROOF, IN BOTH DIRECTIONS — the gap tests/dockerFixture.mjs already
// admits in a comment ("no skip count is asserted anywhere"), and the one
// tests/ssh-live.test.mjs has closed for its own roster since card 2026-0004.
//
// The wrong implementation it catches is the silent one: anything that makes
// `resolveDockerCli` answer null — a future edit dropping the `sudo -n docker`
// fallback from `candidates()`, a probe that stops asking for the SERVER
// version — turns every roster test into a green skip while `npm test` stays clean,
// so a broken transport reads as a clean run.
//
// It also makes a skip-arm claim SELF-CERTIFYING: with this here, "the roster
// skipped" is asserted by the suite rather than argued from someone's terminal.
//
// Deterministic because node:test runs a file's top-level tests sequentially, so
// every roster test has settled before this one is entered. It does NOT skip
// itself — it must assert in both directions.
test('the live docker roster ALL ran or ALL skipped, and it is not empty', async () => {
  const d = await resolveDockerCli();
  assert.ok(ROSTER.length > 0,
    'an empty roster must not be able to pass as a clean skip');
  assert.equal(new Set(ROSTER.map(r => r.name)).size, ROSTER.length, 'no duplicate roster names');
  if (d) {
    assert.equal(ran, ROSTER.length,
      `the gate was OPEN, so every live test must have run: ${ran}/${ROSTER.length}`);
  } else {
    assert.equal(ran, 0,
      `the gate was CLOSED, so no live test may have run: ${ran} did`);
  }
});
