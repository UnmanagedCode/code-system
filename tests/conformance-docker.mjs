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
import { createTransport } from '../src/launcher/kinds/index.mjs';
import { makeRunner } from '../src/launcher/run.mjs';
import { LAUNCHER_MAIN } from '../src/paths.mjs';
import { makeRecord, writeRemote } from '../src/store.mjs';
import {
  REPO_ROOT, assertNoDrift, checkTally, checkoutOrSkip, parseSpecReport, spawnSuite,
} from './ccCheckout.mjs';
import { EXPECTED, compareOutcomes } from './boundConformanceExpectations.mjs';
import { IdentityError, proveIdentity, resolveHostPath } from './boundConformanceFixture.mjs';
import { SKIP_REASON, resolveDockerCli, run, withContainer } from './dockerFixture.mjs';

const SCRIPT = 'conformance:docker';

// cc's per-file hang guard (tests/hangGuardConfig.mjs). WE DO NOT RAISE IT —
// `CC_TEST_FILE_KILL_MS` is deliberately never set here. Raising a guard
// pre-emptively is how a slow run becomes invisible; measuring the margin and
// printing it is how it stays visible.
const FILE_KILL_MS = 90_000;
const MARGIN_WARN_MS = 60_000;

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

async function teardown() {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch (e) { console.error(`${SCRIPT}: cleanup failed: ${e?.message ?? e}`); }
  }
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
  cleanups.push(() => fs.rm(scratchDir, { recursive: true, force: true }));

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
  const shared = [`--pid=container:${selfId}`];
  const base = ['--user', `${process.getuid()}:${process.getgid()}`, '-v', `${hostPath}:${SCRATCH_PARENT}`];
  let container;
  try {
    container = await withContainer(lifecycle, cli, { stem: 'boundconf', args: [...base, ...shared] });
    log(`${SCRIPT}: container ${container} shares this container's PID namespace (${selfId})`);
  } catch (e) {
    // A GENUINE, LOGGED DEGRADATION — never silent. Everything else still holds;
    // what is lost is the honesty of one row's pid.
    console.error(`${SCRIPT}: WARNING — --pid=container:${selfId} was refused (${e?.message ?? e}).`);
    console.error(`${SCRIPT}: WARNING — running WITHOUT a shared PID namespace. cc's`
      + ' `process-group signalling` row records a pid from the FAR SIDE and then SIGKILLs that'
      + ' number in THIS namespace, so it may signal an unrelated local process. Nothing our side'
      + ' can do about that: the kill is cc\'s suite\'s and the pid is the far side\'s.');
    container = await withContainer(lifecycle, cli, { stem: 'boundconf', args: base });
  }

  await proveIdentity({ cli, scratchDir, container, log });

  // ── 3. the baseline probe, so a green run cannot be vacuous ──────
  const transport = createTransport('docker', {});
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
  const provider = JSON.stringify([process.execPath, LAUNCHER_MAIN, '--kind', 'docker']);
  log(`\n${SCRIPT}: ${checkout}\n${SCRIPT}: provider ${provider}\n`);

  const started = Date.now();
  const child = spawnSuite(checkout, {
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
  }, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Tee'd rather than captured, so the run stays watchable while it happens.
  let out = '';
  child.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
  child.stderr.on('data', (b) => process.stderr.write(b));
  const suiteExit = await new Promise((resolve) => child.on('close', resolve));
  const elapsed = Date.now() - started;

  // ── 6. parse, compare, report ────────────────────────────────────
  const report = parseSpecReport(out);
  const tallyProblems = checkTally(report);
  const problems = compareOutcomes(report.tests);

  log('');
  log(`${SCRIPT}: ${report.tally.pass ?? '?'} pass / ${report.tally.fail ?? '?'} fail`
    + ` / ${report.tally.skipped ?? '?'} skip of ${report.tally.tests ?? '?'}`
    + ` (cc's runner exited ${suiteExit})`);
  log(`${SCRIPT}: wall clock ${elapsed}ms; margin against the ${FILE_KILL_MS}ms per-file hang guard`
    + ` = ${FILE_KILL_MS - elapsed}ms (${(FILE_KILL_MS / Math.max(elapsed, 1)).toFixed(2)}x)`);
  if (elapsed > MARGIN_WARN_MS) {
    log(`${SCRIPT}: WARNING — this run is within ${FILE_KILL_MS - MARGIN_WARN_MS}ms of the guard.`
      + ' Do NOT raise CC_TEST_FILE_KILL_MS; find what got slow.');
  }
  log(`${SCRIPT}: ${EXPECTED.length} rows are expected not to pass`
    + ` (${EXPECTED.filter(e => e.outcome === 'skip').length} skip, `
    + `${EXPECTED.filter(e => e.outcome === 'fail').length} fail) — see`
    + ' tests/boundConformanceExpectations.mjs for each one\'s cause');

  for (const p of tallyProblems) console.error(`${SCRIPT}: PARSE — ${p}`);
  for (const p of problems) console.error(`${SCRIPT}: ${p.kind.toUpperCase()} — ${p.name}\n      ${p.message}`);

  if (tallyProblems.length || problems.length) {
    console.error(`\n${SCRIPT}: FAILED — the run did not match the manifest`);
    return 1;
  }
  log(`\n${SCRIPT}: OK — every unlisted row passed, and every listed row produced exactly its`
    + ' recorded outcome');
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`\n${SCRIPT}: ABORTED — ${e instanceof IdentityError ? e.message : (e?.stack ?? e)}`);
} finally {
  await teardown();
}
process.exit(code);
