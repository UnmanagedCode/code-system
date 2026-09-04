// THE DOCKER TRANSPORT AGAINST A REAL CONTAINER.
//
// Every test here calls `skipUnlessDocker` FIRST and returns, so `npm test`
// stays green and docker-free — each skip prints a reason naming both
// invocations tried and the CODE_SYSTEM_DOCKER override. On a host where the
// daemon answers, they run for real.
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
  countingShim, inContainer, markerCount, run, settle, skipUnlessDocker, tempDir, withContainer,
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
    ...extraEnv,
  });
  t.after(() => l.kill());
  return l;
}

// ── L1: the happy path, through the SHIPPED launcher ─────────────────

// PINS the whole shipped path — main.mjs arg parsing, kind dispatch,
// StoreRemoteSource lookup, spawnPlan, the frame loop — reaching a real
// container; that `-w` really sets the working directory; and that CC_REMOTE
// really lands in the environment of the child the exec started. The last is
// §10's CC_REMOTE row asserted ON THE CONTAINER'S OWN ANSWER rather than on the
// command merely succeeding, which is what a misroute also looks like.
test('live: a routed exec reaches the container, at the requested cwd, knowing its remote id', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: NEGATIVE CONTROL — killing the host docker client leaves the container process running', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: stdin EOF SIGKILLs every in-flight exec inside the container, inside the grace', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: `close` reaps that id alone and leaves the other execs running', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: a timed-out exec is reaped in the container, not just reported as killed', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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

test('live: a `signal` frame reaps the container-side process too', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: five commands that exit on their own cost exactly five docker invocations', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: an absent env inherits the CONTAINER\'s environment; a supplied env replaces it', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test("live: cwd '/' is served, and `stat` answers with sub-second mtime precision", async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: readFile/writeFile work over docker exec, with every code cc branches on', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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

// ── L10: a real busybox target is refused BY NAME ────────────────────

// PINS acceptance 7 against a live busybox, and the reason the probe asserts on
// OUTPUT SHAPE rather than exit codes: busybox is a PARTIAL failure whose `stat`
// SUCCEEDS while being wrong (no sub-second field), which is the one degradation
// cc never surfaces on its own.
//
// FOUR capabilities, not the three cc's own §11 note lists: our `shell` row is
// `[ -x /bin/bash ]` and busybox has no bash. A test written to three would red.
test('live: a real busybox container fails the baseline, and the launcher refuses it BY NAME', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: a stopped and a non-existent container each answer ENOREMOTE, id-addressed', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
  const live = await withContainer(t, d.cli);
  const stopped = await withContainer(t, d.cli, { stem: 'stopped' });
  // THE FIXTURE may stop a container. The provider never may — pinned in
  // tests/dockerkind.test.mjs.
  assert.equal((await run([...d.cli, 'stop', '-t', '0', stopped])).code, 0);

  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, dockerRecord('alive', live));
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
test('live: every operation routes on its remoteId, and the routed container really differs', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: a frame env key shaped like an option cannot hijack the command', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: the reap script reports `blind` instead of success when it cannot read /proc', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
test('live: reap throws when the relay cannot be proved, and is quiet when the container is gone', async (t) => {
  const d = await skipUnlessDocker(t); if (!d) return;
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
