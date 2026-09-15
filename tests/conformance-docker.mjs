#!/usr/bin/env node
// THE BOUND RUN: cc's conformance battery against the SHIPPED `docker`
// transport, over a container that shares this process's filesystem at
// byte-identical absolute paths.
//
//   CC_CHECKOUT=/path/to/cc-clone CODE_SYSTEM_DOCKER='["sudo","-n","docker"]' \
//     npm run conformance:docker
//
// WHY, given `npm run conformance` already passes. That run is on the `host`
// kind, and the argument that it carries every kind is a SEAM argument:
// protocol.mjs, session.mjs and fileops.mjs are kind-agnostic and `spawnPlan` is
// pure, so the per-kind residue is argv construction, `reap` and
// `classifyFailure`. This run MEASURES that residue for `docker` under the
// battery's own fixtures instead of generalising to it.
//
// IT CANNOT BE GREEN, and that is the deliverable, not a defect: eight rows have
// causes that are ours and deliberate. tests/boundConformanceExpectations.mjs is
// the manifest of exactly which, with the code that forces each — and ANYTHING
// NOT IN IT MUST PASS, including a row that starts passing.
//
// NEVER PART OF `npm test`: it needs a daemon, a clone of the pin, and a
// writable bound scratch directory.
//
// NOTHING IN THE CHECKOUT IS MODIFIED. Editing that suite is how a provider
// fakes conformance.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROBE_SCRIPT, parseProbeOutput } from '../src/baseline.mjs';
import { CHANNEL_ENV, channelEnabled } from '../src/launcher/channel.mjs';
import { createTransport } from '../src/launcher/kinds/index.mjs';
import { makeRunner } from '../src/launcher/run.mjs';
import { LAUNCHER_MAIN } from '../src/paths.mjs';
import { makeRecord, writeRemote } from '../src/store.mjs';
import {
  CC_FILE_KILL_MS, REPO_ROOT, assertNoDrift, checkTally, checkoutOrSkip, parseSpecReport, spawnSuite,
} from './ccCheckout.mjs';
import { EXPECTED, checkTotal, compareOutcomes } from './boundConformanceExpectations.mjs';
import { IdentityError, proveIdentity, resolveHostPath } from './boundConformanceFixture.mjs';
import { readLauncherDiagnostics } from './launcherDiagnostics.mjs';
import { SKIP_REASON, resolveDockerCli, run, withContainer } from './dockerFixture.mjs';

// ── THE TWO ARMS ────────────────────────────────────────────────────
//
// The invariant card 2026-0021 has to hold is that the held-open channel
// changes NO observable outcome, so both arms are compared to the ONE shipped
// manifest: any divergence between them is a failure, and the off arm is
// today's behaviour unchanged.
//
// EACH ARM IS ITS OWN PROCESS, re-spawned from this file rather than `main()`
// being called twice. That sidesteps this module's scope-level singletons
// entirely — `suiteRun`, `cleanups`, the memoised `teardownRun`, and
// `resolveDockerCli`'s per-environment memo — none of which is written to be
// reused inside one run.
const ARM_FLAG = '--arm';
const ARMS = [
  { name: 'on', channel: '1' },
  { name: 'off', channel: '0' },
];

const armName = (() => {
  const i = process.argv.indexOf(ARM_FLAG);
  return i === -1 ? null : String(process.argv[i + 1] ?? '');
})();

const SCRIPT = armName === null ? 'conformance:docker' : `conformance:docker[channel=${armName}]`;

// The wall clock at which this run stops being comfortably inside cc's per-file
// hang guard (`CC_FILE_KILL_MS`, mirrored and drift-checked in ccCheckout.mjs).
const MARGIN_WARN_MS = 60_000;

// B2's opt-in. `--pid=container:<self>` is what makes the pid cc's suite records
// from the FAR SIDE a real pid in the namespace it then SIGKILLs; without it the
// suite signals whatever local process happens to hold that number. That the
// low pids on a given box happen to be unoccupied is LUCK, not a guard, so the
// unshared run is REFUSED by default and this is the only way to take it.
const ALLOW_UNSHARED_PID_ENV = 'CODE_SYSTEM_ALLOW_UNSHARED_PID';

// The scratch lives under the REPO, not under /tmp: a `-v` source path is
// resolved by the daemon ON THE HOST, and /tmp in this container is its own
// overlay that the host cannot name. The repo is inside a host bind, so it can.
const SCRATCH_PARENT = path.join(REPO_ROOT, '.conformance-tmp');

const REMOTE_ID = 'boundconf';

const log = (s) => console.log(s);
const cleanups = [];
// `withContainer` wants only an `after`, so a plain registrar stands in for a
// test context and the container's removal is registered before it can leak.
const lifecycle = { after: (fn) => cleanups.push(fn) };

/**
 * THE ONE DIAGNOSTIC OUR SIDE CAN CONTRIBUTE about cc's cross-namespace kill.
 *
 * `systems-protocol-conformance.test.mjs`'s process-group row has the FAR SIDE
 * write a grandchild's pid (`echo $! > <root>/grandchild.pid`) and then, in a
 * `finally`, SIGKILLs that number HERE. `<root>` is a `cc-conformance-*`
 * mkdtemp directly under the TMPDIR we point at the scratch, so polling for the
 * file is how this process gets to see the number at all — and a snapshot of
 * `/proc/<pid>/cmdline` taken at that moment is what makes a
 * killed-something-else event ATTRIBUTABLE rather than mysterious.
 *
 * Best-effort by construction: it is a diagnostic, not a gate, and a miss costs
 * nothing but the diagnostic. The file lives for the row's 300 ms timeout plus
 * its settle, so a 40 ms poll sees it comfortably.
 */
function watchFarSidePids(scratchDir) {
  const seen = new Map(); // pid -> what this namespace called it when we looked
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const dir of await fs.readdir(scratchDir).catch(() => [])) {
        if (!dir.startsWith('cc-conformance-')) continue;
        const raw = await fs.readFile(path.join(scratchDir, dir, 'grandchild.pid'), 'utf8').catch(() => null);
        const pid = Number(raw?.trim());
        if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
        const cmd = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')
          .then(t => t.replaceAll('\0', ' ').trim() || '<empty cmdline>')
          .catch(e => `<no /proc/${pid}: ${e.code}>`);
        seen.set(pid, cmd);
      }
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, 40);
  timer.unref?.();
  return { stop: () => { clearInterval(timer); return seen; } };
}

// MEMOISED, not flagged. There are two callers — `main`'s own `finally` and the
// signal handler — and on a signal they run CONCURRENTLY: the kill that stops the
// battery is also what resolves `main`'s wait on the child. A `if (done) return`
// guard lets the second caller return IMMEDIATELY, so the handler re-raised the
// signal and killed the process while the first caller was still awaiting its
// first `fs.rm` — measured: container, scratch and store all survived a Ctrl-C.
// Returning the same promise makes the second caller WAIT for the first.
let teardownRun = null;
function teardown() {
  teardownRun ??= (async () => {
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch (e) { console.error(`${SCRIPT}: cleanup failed: ${e?.message ?? e}`); }
    }
  })();
  return teardownRun;
}

// The battery, while it is running — at MODULE scope, because the signal handler
// below has to reach it and `main`'s local would not be visible there.
let suiteRun = null;

/**
 * KILL THE WHOLE RUN, and wait for it. Ordered BEFORE teardown, and that
 * ordering is the point: teardown removes the container the battery is exec'ing
 * into and `rm -rf`s the scratch its fixtures live in, so a battery still
 * running at that moment is left parentless against a deleted TMPDIR and a
 * removed container until it exits on its own.
 *
 * The GROUP, not the pid: cc's runner spawns a child per test file, so killing
 * the direct child alone reopens the same hole one level down. `spawnSuite` is
 * given `detached: true` for exactly this.
 */
async function killSuiteRun() {
  const child = suiteRun;
  suiteRun = null;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  console.error(`${SCRIPT}: killing the battery (process group ${child.pid})`);
  await new Promise((resolve) => {
    child.once('close', resolve);
    // Bounded, so a wedged group cannot hold the teardown that frees the
    // container. Whatever survives is named by the sweep below.
    const bail = setTimeout(resolve, 5_000);
    bail.unref?.();
    // RE-CHECKED ADJACENT TO THE KILL, because `kill(-pid)` is the most
    // dangerous call in this file: if the group is gone and the OS has recycled
    // the pgid, it lands on somebody else's processes.
    //
    // IT NARROWS NOTHING TODAY, AND IT CLOSES NOTHING EVER. Measured: the guard
    // above, this line and the kill are ONE synchronous span — no event-loop
    // turn between them — so `exitCode` cannot transition inside it, and the
    // case that actually matters (the group gone at the OS level, not yet reaped
    // by node) reads `null` at both points and is invisible from here. POSIX
    // offers no atomic "signal this group if it is still the group I meant".
    // What this line buys is that the check cannot be SEPARATED from the kill:
    // an `await` inserted above would open a real window, and this check is
    // already inside it.
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { resolve(); }
  });
  console.error(`${SCRIPT}: battery gone`);
}

// `try/finally` COVERS EXCEPTIONS, NOT SIGNALS. A Ctrl-C between `docker run`
// and the finally would leak the container AND the scratch tree, and the
// container is the expensive one. Re-raised with the default handler so the
// caller still sees a signal death rather than a fabricated exit code.
//
// SIGKILL IS UNCOVERABLE BY ANY TRAP — if the runner is `kill -9`ed, sweep by
// hand, all three:
//   docker ps -a --filter name=code-system-test-boundconf
//   rm -rf <repo>/.conformance-tmp
//   rm -rf /tmp/code-system-boundconf-*        # the seeded store
let interruptedBy = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    interruptedBy = sig;
    console.error(`\n${SCRIPT}: ${sig} — stopping the battery, then tearing down`);
    void killSuiteRun()
      .then(teardown)
      .finally(() => {
        process.removeAllListeners(sig);
        process.kill(process.pid, sig);
      });
  });
}

async function main() {
  // ── 1. the daemon ────────────────────────────────────────────────
  // Gated FIRST so this script's own precondition is what an operator without a
  // daemon hears about, and so the CC_CHECKOUT gate below is reachable on a box
  // that has one.
  const found = await resolveDockerCli();
  if (!found) { console.log(`${SCRIPT}: SKIPPED — ${SKIP_REASON}`); return 0; }
  const { cli, serverVersion } = found;
  // NAME THE RESOLVED ARGV. Two invocations are tried, so a green run is no
  // evidence about which one answered (tests/dockerFixture.mjs).
  log(`${SCRIPT}: docker ${JSON.stringify(cli)} → server ${serverVersion}`);

  const checkout = checkoutOrSkip(SCRIPT);
  assertNoDrift(SCRIPT, checkout);

  // ── 2. filesystem identity, BY MEASUREMENT ───────────────────────
  // Before the battery, so a broken bind can never be read as a conformance
  // failure. Every value is printed and every check refuses by name.
  await fs.mkdir(SCRATCH_PARENT, { recursive: true });
  const { selfId, hostPath, destination } = await resolveHostPath({ cli, containerPath: SCRATCH_PARENT, log });
  log(`${SCRIPT}: scratch parent ${SCRATCH_PARENT} → host ${hostPath}`);

  const scratchDir = await fs.mkdtemp(path.join(SCRATCH_PARENT, 'run-'));
  // ONE cleanup for both, in this order: `teardown` runs them LIFO, so a second
  // entry for the parent would fire BEFORE its own child was removed and always
  // find it non-empty. The parent goes only if this run emptied it — a concurrent
  // run's scratch makes the rmdir ENOTEMPTY, which is the right answer.
  cleanups.push(async () => {
    await fs.rm(scratchDir, { recursive: true, force: true });
    await fs.rmdir(SCRATCH_PARENT).catch(() => {});
  });

  // THE CONTAINER. Every argument is measured, none is a literal:
  //  --user      the suite's EACCES row (readFile of a 000 file) requires a
  //              non-root far side, and node:24-slim defaults to root.
  //  -v          the STABLE PARENT, since the per-run mkdtemp does not exist
  //              yet at `docker run` time. Source is the host path the daemon
  //              resolves; destination is the byte-identical path we see.
  //  --pid       shares THIS container's PID namespace, which is what makes the
  //              pid the suite records from the far side (`echo $!`, executed by
  //              the provider) a real pid here — the same number its own
  //              host-side `process.kill` and `alive()` then use. Without it the
  //              suite signals an unrelated local process.
  const base = ['--user', `${process.getuid()}:${process.getgid()}`, '-v', `${hostPath}:${SCRATCH_PARENT}`];
  let container;
  let sharedPidNs = true;
  try {
    container = await withContainer(lifecycle, cli,
      { stem: 'boundconf', args: [...base, `--pid=container:${selfId}`] });
    log(`${SCRIPT}: container ${container} shares this container's PID namespace (${selfId})`);
  } catch (e) {
    // REFUSED BY DEFAULT, not warned about and then run. cc's suite records a
    // grandchild's pid from a command the FAR SIDE ran and then SIGKILLs that
    // number in ITS OWN namespace; unshared, the number means something else
    // here, and "the low pids on this box happen to be unoccupied" is luck, not
    // a guard. The battery is not worth signalling an unrelated local process.
    if (process.env[ALLOW_UNSHARED_PID_ENV]?.trim() !== '1') {
      throw new IdentityError('shared PID namespace',
        `--pid=container:${selfId} was refused by the daemon (${e?.message ?? e}).`
        + ' Without it, cc\'s `process-group signalling` row SIGKILLs a FAR-SIDE pid in THIS'
        + ' namespace and may hit an unrelated local process. Refusing rather than running on luck.'
        + ` Set ${ALLOW_UNSHARED_PID_ENV}=1 to take that risk deliberately — the observed far-side`
        + ' pid is printed either way, so a killed-something-else event stays attributable.');
    }
    sharedPidNs = false;
    console.error(`${SCRIPT}: WARNING — --pid=container:${selfId} was refused (${e?.message ?? e}),`
      + ` and ${ALLOW_UNSHARED_PID_ENV}=1 permits running anyway.`);
    console.error(`${SCRIPT}: WARNING — cc's \`process-group signalling\` row will SIGKILL a`
      + ' FAR-SIDE pid in THIS namespace. Nothing our side can do about that: the kill is cc\'s'
      + ' suite\'s and the pid is the far side\'s. The pid it used is printed at the end.');
    container = await withContainer(lifecycle, cli, { stem: 'boundconf', args: base });
  }

  await proveIdentity({ cli, scratchDir, container, log });

  // ── 3. the baseline probe, so a green run cannot be vacuous ──────
  // THE RESOLVED cli, not `process.env`. `createDockerTransport` falls back to
  // `dockerCliArgv()` — bare `docker` by default — so with CODE_SYSTEM_DOCKER
  // unset this probe would hit the socket and abort a run whose battery (which
  // IS given the resolved argv, below) would have worked.
  const transport = createTransport('docker', { cli });
  const config = { container };
  const probe = await makeRunner(transport, config, REMOTE_ID)({ script: PROBE_SCRIPT });
  const baselineVerdict = parseProbeOutput(probe);
  if (baselineVerdict.state !== 'ok') {
    throw new IdentityError('tooling baseline',
      `the fixture container fails cc's tooling baseline (${baselineVerdict.state},`
      + ` missing ${JSON.stringify(baselineVerdict.missing)}) — fileops would be gated off and`
      + ' every derived row would fail for that reason rather than a transport one');
  }
  log(`${SCRIPT}: tooling baseline ok`);

  // ── 4. the store, seeded with exactly one remote ─────────────────
  // CODE_SYSTEM_STORE goes under /tmp: `storeRoot()` is read by OUR launcher, in
  // this container, so it needs no container visibility at all.
  const storeRoot = await fs.mkdtemp('/tmp/code-system-boundconf-');
  cleanups.push(() => fs.rm(storeRoot, { recursive: true, force: true }));
  // Set BEFORE writeRemote: paths.mjs reads the variable per call.
  process.env.CODE_SYSTEM_STORE = storeRoot;
  await writeRemote(makeRecord({
    remoteId: REMOTE_ID,
    kind: 'docker',
    config,
    // The OPERATOR GATE. Off is the default, and off would refuse every frame.
    enabled: true,
    baseline: { ...baselineVerdict, fingerprint: null, checkedAt: new Date().toISOString() },
  }));
  log(`${SCRIPT}: store ${storeRoot}, remote '${REMOTE_ID}' → container ${container}`);

  // ── 5. the battery ───────────────────────────────────────────────
  // NO `--remote`. systems-protocol.md §10 says CC_CONFORMANCE_REMOTE_ID
  // presupposes it, and this run clears the harness's bound-run precondition
  // only because StoreRemoteSource.hasRemotes() is CONSTANT TRUE
  // (src/launcher/remotes.mjs) — a legitimate but off-spec shape, and the
  // constant is the reason it is legitimate.
  //
  // No host-kind guard variables either: this is the shipped `docker` kind.
  //
  // THE LAUNCHER'S STDERR IS REDIRECTED TO A FILE OF THIS ARM'S OWN, because
  // otherwise nothing in this repo can observe it on a real run: cc's
  // ProviderConnection spawns the provider with piped stdio and drains stderr
  // into a BOUNDED TAIL it prints only inside an ETRANSPORT message, so a
  // launcher that exits cleanly has its diagnostics discarded — the admission
  // drift alarm included, and an alarm nobody can hear is not an alarm.
  //
  // `exec` REPLACES THE SHELL, so the launcher keeps the pid and the position in
  // the process tree that cc's kill and this file's watchdogs address, and
  // `"$@"` carries its argv byte-for-byte with no quoting in the contract. The
  // log path rides as `$1` rather than being interpolated into the `-c` string,
  // so a scratch path is never shell syntax.
  //
  // One file per arm, appended to by every launcher cc spawns during it, and
  // read back in full after the battery — which is strictly more than the tail
  // it replaces. The trade is that cc's own ETRANSPORT messages no longer quote
  // a stderr tail, so the digest below is printed unconditionally.
  const launcherLog = path.join(storeRoot, 'launcher-stderr.log');
  const provider = JSON.stringify([
    '/bin/sh', '-c', 'log=$1; shift; exec "$@" 2>>"$log"', 'sh', launcherLog,
    process.execPath, LAUNCHER_MAIN, '--kind', 'docker',
  ]);
  log(`\n${SCRIPT}: ${checkout}\n${SCRIPT}: provider ${provider}`);
  log(`${SCRIPT}: launcher stderr → ${launcherLog}\n`);

  const started = Date.now();
  const child = suiteRun = spawnSuite(checkout, {
    CC_CONFORMANCE_PROVIDER: provider,
    CC_CONFORMANCE_REMOTE_ID: REMOTE_ID,
    // EXPLICIT, never inherited: `dockerFixture`'s candidate list appends
    // `sudo -n docker` unconditionally, so passing our own resolved argv is the
    // only way the launcher runs the invocation we actually probed.
    CODE_SYSTEM_DOCKER: JSON.stringify(cli),
    // THE SEAM THAT MAKES THE WHOLE RUN POSSIBLE. Every fixture root in the
    // suite is `mkdtemp(path.join(os.tmpdir(), …))`, and node's `os.tmpdir()`
    // reads TMPDIR on every call — so the fixtures land in the bound scratch
    // with no edit to cc. It survives cc's own run isolation because
    // tests/safeStoreRoot.mjs computes its REAL_TMP from `os.tmpdir()` too.
    TMPDIR: scratchDir,
    CODE_SYSTEM_STORE: storeRoot,
    // ITS OWN PROCESS GROUP, so a signal can take the whole run down before the
    // scratch it is reading goes away. See killSuiteRun.
  }, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

  const pidWatch = watchFarSidePids(scratchDir);
  // Tee'd rather than captured, so the run stays watchable while it happens.
  let out = '';
  child.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
  child.stderr.on('data', (b) => process.stderr.write(b));
  const suiteExit = await new Promise((resolve) => child.on('close', resolve));
  suiteRun = null;
  const elapsed = Date.now() - started;
  const farSidePids = pidWatch.stop();

  // ── 6. parse, compare, report ────────────────────────────────────
  const report = parseSpecReport(out);
  // FOUR INDEPENDENT GUARDS, and they catch different things. `checkTotal` is
  // the ABSOLUTE one: the other two reporter guards are relative to what the run
  // reported, so a row that vanished from the suite moves the tally and the
  // parse together and is invisible to both. The fourth reads a surface cc never
  // shows at all — see the launcher-stderr redirect above.
  const parseProblems = checkTally(report);
  const sizeProblems = checkTotal(report.tally);
  const problems = compareOutcomes(report.tests);
  // A FOURTH GUARD, and the only one reading a surface cc never shows: the
  // launcher's own stderr.
  //
  // `expectCensus` uses THE LAUNCHER'S OWN PREDICATE over the same variable the
  // arm exported, so the runner cannot disagree with the launchers it spawned
  // about whether a pool was built — and an on-arm whose log holds no census at
  // all reds instead of reporting a drift-free run it has no evidence for.
  const diag = readLauncherDiagnostics(
    await fs.readFile(launcherLog, 'utf8').catch(() => ''),
    { expectCensus: channelEnabled(process.env) },
  );

  log('');
  log(`${SCRIPT}: ${report.tally.pass ?? '?'} pass / ${report.tally.fail ?? '?'} fail`
    + ` / ${report.tally.skipped ?? '?'} skip of ${report.tally.tests ?? '?'}`
    + ` (cc's runner exited ${suiteExit})`);
  log(`${SCRIPT}: wall clock ${elapsed}ms; margin against the ${CC_FILE_KILL_MS}ms per-file hang guard`
    + ` = ${CC_FILE_KILL_MS - elapsed}ms (${(CC_FILE_KILL_MS / Math.max(elapsed, 1)).toFixed(2)}x)`);
  if (elapsed > MARGIN_WARN_MS) {
    log(`${SCRIPT}: WARNING — this run is within ${CC_FILE_KILL_MS - MARGIN_WARN_MS}ms of the guard.`
      + ' Do NOT raise CC_TEST_FILE_KILL_MS; find what got slow.');
  }
  // PRINTED WHETHER OR NOT THE NAMESPACE IS SHARED. Shared, it says the kill
  // landed on the process it names; unshared, it is the only record of which
  // local pid cc's suite signalled.
  if (farSidePids.size === 0) {
    log(`${SCRIPT}: far-side pid — none observed (the process-group row's grandchild.pid was not`
      + ' caught by the poll; that row\'s own result above is unaffected)');
  } else {
    for (const [pid, cmd] of farSidePids) {
      log(`${SCRIPT}: far-side pid ${pid} — this namespace saw ${cmd}`
        + (sharedPidNs ? ' (shared PID namespace: the same process)' : ' (NOT shared: cc SIGKILLed this)'));
    }
  }
  log(`${SCRIPT}: launcher said — ${diag.sessions} session(s) reported a channel census:`
    + ` carried ${diag.carried} of ${diag.admitted} admitted ops on ${diag.channels} channels`
    + `; ${diag.drift.length} admission-drift alarm(s)`);
  for (const line of diag.other) log(`${SCRIPT}: launcher said — ${line}`);
  log(`${SCRIPT}: ${EXPECTED.length} rows are expected not to pass`
    + ` (${EXPECTED.filter(e => e.outcome === 'skip').length} skip, `
    + `${EXPECTED.filter(e => e.outcome === 'fail').length} fail) — see`
    + ' tests/boundConformanceExpectations.mjs for each one\'s cause');

  // TWO PREFIXES, because they are different events: a PARSE problem means this
  // script can no longer read cc's reporter, while a SIZE one means cc's suite
  // itself changed shape.
  for (const p of parseProblems) console.error(`${SCRIPT}: PARSE — ${p}`);
  for (const p of sizeProblems) console.error(`${SCRIPT}: SIZE — ${p}`);
  for (const p of problems) console.error(`${SCRIPT}: ${p.kind.toUpperCase()} — ${p.name}\n      ${p.message}`);
  for (const p of diag.problems) console.error(`${SCRIPT}: LAUNCHER — ${p}`);

  if (parseProblems.length || sizeProblems.length || problems.length || diag.problems.length) {
    console.error(`\n${SCRIPT}: FAILED — the run did not match the manifest, or the launcher`
      + ' reported a condition no outcome in the battery can show');
    return 1;
  }
  // THE VERDICT NAMES ONLY WHAT THIS ARM COULD OBSERVE. With the channel off no
  // pool is built, so `admits` is never consulted and the drift alarm cannot
  // fire — claiming it was silent there would assert a fact the arm has no
  // evidence for, which is the failure the census check above exists to catch.
  log(`\n${SCRIPT}: OK — every unlisted row passed, every listed row produced exactly its`
    + ' recorded outcome' + (diag.sessions > 0
      ? `, and ${diag.sessions} launcher sessions reported a census with no admission-drift alarm`
      : ' (channel off: no pool, so no admission table to drift)'));
  return 0;
}

/**
 * THE DRIVER. Runs this same file once per arm, inheriting stdio so the whole
 * output is watchable, and fails if EITHER arm fails.
 */
async function runArms() {
  const { spawn } = await import('node:child_process');
  let worst = 0;
  for (const arm of ARMS) {
    console.log(`\n================ conformance:docker — channel ${arm.name}`
      + ` (${CHANNEL_ENV}=${arm.channel}) ================\n`);
    const child = spawn(process.execPath, [process.argv[1], ARM_FLAG, arm.name], {
      stdio: 'inherit',
      // The launcher is spawned by cc's runner, which is spawned by the arm, and
      // both inherit this — so setting it here is what reaches the provider.
      env: { ...process.env, [CHANNEL_ENV]: arm.channel },
    });
    const forward = (sig) => { try { child.kill(sig); } catch { /* gone */ } };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, forward);
    const status = await new Promise(r => child.on('close', (c, sg) => r(sg ? 1 : (c ?? 1))));
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(sig, forward);
    console.log(`\nconformance:docker: channel ${arm.name} arm exited ${status}`);
    if (status !== 0) worst = status;
    // A SKIPPED arm skips the other too: the gates (a daemon, CC_CHECKOUT) are
    // the same for both, and a second identical skip line says nothing.
    if (status === 0 && !process.env.CC_CHECKOUT?.trim()) break;
  }
  return worst;
}

if (armName === null) {
  process.exitCode = await runArms();
} else {

let code = 1;
try {
  code = await main();
} catch (e) {
  // A SIGNAL CANCELS WHATEVER WAS IN FLIGHT, and that shows up here as an
  // ordinary failure of whichever check was mid-`docker exec` — measured: a
  // Ctrl-C during the identity probe surfaces as "uid mapping: `docker exec
  // id -u` answered ''". Say which it was, so the message below is not read as
  // a real verdict.
  if (interruptedBy) {
    console.error(`\n${SCRIPT}: INTERRUPTED by ${interruptedBy} — anything below is the in-flight`
      + ' check being cancelled, not a finding');
  }
  console.error(`\n${SCRIPT}: ABORTED — ${e instanceof IdentityError ? e.message : (e?.stack ?? e)}`);
} finally {
  await teardown();
}
// `exitCode` RATHER THAN `process.exit()`: writes to a pipe are asynchronous, and
// exiting outright can truncate the verdict lines above — which are the whole
// output an operator reads.
process.exitCode = code;

}
