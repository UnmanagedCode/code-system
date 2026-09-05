// THE `CC_CHECKOUT` PLUMBING, shared by both conformance runners. No tests of
// its own.
//
// Extracted from tests/conformance.mjs when tests/conformance-docker.mjs
// arrived, so the two cannot disagree about what a checkout is, when the drift
// check runs, or how cc's runner is spawned. Everything KIND-SPECIFIC — which
// provider argv, which environment seams, what to do with the output — stays in
// the caller.
//
// POINT CC_CHECKOUT AT A CLONE OF THE PIN, never at a code-conductor worktree
// somebody is working in: `spawnSuite` runs cc's test runner with
// `cwd: <checkout>`. See docs/architecture.md → "The gated conformance run".
//
// NOTHING IN THE CHECKOUT IS MODIFIED — the suite is read and run, never
// edited. Editing it is how a provider fakes conformance.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** This repo's root — the cwd every spawn of OUR code must use. */
export const REPO_ROOT = path.dirname(HERE);

export const SUITE_REL = path.join('tests', 'systems-protocol-conformance.test.mjs');
export const RUNNER_REL = path.join('tests', 'run.mjs');

// cc's PER-FILE hang guard, mirrored so a bound run can print its own margin
// against it. It lives in the CHECKOUT (`tests/hangGuardConfig.mjs`), so this
// copy is DRIFT-CHECKED against cc's, by the gated half of
// tests/protocol-constants.test.mjs — the mechanism this project already uses
// for every mirrored constant. An undrift-checked copy would silently measure
// the margin against the wrong number the day cc moved it.
//
// WE NEVER RAISE IT. `CC_TEST_FILE_KILL_MS` is deliberately never set by either
// runner: raising a guard pre-emptively is how a slow run becomes invisible.
// Measuring the margin and printing it is how it stays visible.
export const CC_FILE_KILL_MS = 90_000;

/**
 * The checkout, or a CLEAN SKIP (exit 0) naming the variable. Gating this way —
 * skipping, not failing — is what lets `npm test` need nothing but Node.
 * @param {string} script the runner's own name, so a skip line says which one skipped
 * @returns {string} an absolute-enough checkout path that has both files
 */
export function checkoutOrSkip(script) {
  const checkout = process.env.CC_CHECKOUT?.trim();
  if (!checkout) {
    console.log(`${script}: SKIPPED — set CC_CHECKOUT=/path/to/code-conductor to run cc's own suite`);
    process.exit(0);
  }
  for (const rel of [RUNNER_REL, SUITE_REL]) {
    if (!existsSync(path.join(checkout, rel))) {
      console.error(`${script}: ${checkout} does not look like a code-conductor checkout (missing ${rel})`);
      process.exit(1);
    }
  }
  return checkout;
}

/**
 * THE DRIFT CHECK RUNS FIRST, and aborts the battery. It is the one test that
 * needs a checkout, these are the commands that already demand one, and running
 * it here is what stops it skipping silently for the rest of its life.
 *
 * Exits the process on drift; returns on agreement.
 */
export function assertNoDrift(script, checkout) {
  const drift = spawnSync(
    process.execPath,
    ['--test', path.join(HERE, 'protocol-constants.test.mjs')],
    { cwd: REPO_ROOT, env: { ...process.env, CC_CHECKOUT: checkout }, stdio: 'inherit' },
  );
  if (drift.status !== 0) {
    console.error(`\n${script}: ABORTED — our protocol constants have drifted from cc's at this checkout`);
    process.exit(drift.status ?? 1);
  }
}

/**
 * cc's own test runner over the conformance suite, with `cwd: <checkout>`.
 * `env` is overlaid on `process.env`; `stdio` is the caller's (the host run
 * inherits, the bound run pipes so it can parse).
 *
 * `detached` PUTS THE RUN IN ITS OWN PROCESS GROUP, so a caller that has to
 * abandon it can kill the WHOLE run — cc's runner spawns a child per test file,
 * and killing only the direct child orphans those. The bound runner needs that
 * (it deletes the scratch those children are reading); the `host` runner does
 * NOT take it, because it inherits stdio and detaching would stop the terminal's
 * own Ctrl-C reaching the run at all.
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnSuite(checkout, env, { stdio, detached = false }) {
  return spawn(process.execPath, [RUNNER_REL, SUITE_REL], {
    cwd: checkout,
    env: { ...process.env, ...env },
    stdio,
    detached,
  });
}

// ── Reading what cc's runner prints ──────────────────────────────────
//
// cc's tests/run.mjs composes node's own `spec` reporter unconditionally, so
// the format is node's, not cc's: `formatTestReport` renders one line per test
// as `<symbol><name> (<ms>ms)`, with ` # <verbatim reason>` appended for a skip,
// and the run summary as `<info-symbol> <key> <n>` diagnostics. Colours are off
// on a pipe; the ANSI strip below is defence against a run that forces them on.
//
// A MIS-PARSE MUST BE LOUD, because an empty parse of a red run looks exactly
// like a green one. `parseSpecReport` therefore also reads the reporter's OWN
// tally, and `checkTally` compares the two — so a format change reds the gate
// instead of silently emptying the result.
//
// BE PRECISE ABOUT WHAT THAT CROSS-CHECK CATCHES: a parse that lost rows the
// reporter still counted, i.e. a corrupt or empty parse. It CANNOT catch
// consistent shrinkage — a row vanishing from the suite moves the tally and the
// parse together, and both stay self-consistent. The absolute-total pin in
// tests/boundConformanceExpectations.mjs is what catches that, and it is a
// separate guard for exactly that reason.

const ANSI = new RegExp('\\u001b\\[[0-9;]*m', 'g');

// The three symbols node's spec reporter uses, and nothing else: a line that
// does not start with one is not a test result.
const SYMBOLS = new Map([['✔', 'pass'], ['✖', 'fail'], ['﹣', 'skip']]);

// The `info` diagnostic the summary lines carry: `<U+2139> <key> <n>`.
const DIAG_RE = new RegExp('^ℹ (\\w+) (\\d+)$');

// `<name> (<ms>ms)` with an optional ` # <reason>`. `(.*)` is greedy so a test
// name that itself contains a parenthesised duration keeps it.
const RESULT_RE = /^(.*) \((\d+(?:\.\d+)?)ms\)(?: # (.*))?$/;

/**
 * @param {string} text everything cc's runner wrote to stdout
 * @returns {{tests: Map<string,{outcome:string, reason:string|null}>, tally: Record<string,number>}}
 */
export function parseSpecReport(text) {
  const tests = new Map();
  const tally = {};
  for (const raw of text.replace(ANSI, '').split('\n')) {
    const line = raw.trim();
    const outcome = SYMBOLS.get(line[0]);
    if (outcome) {
      const m = RESULT_RE.exec(line.slice(1).trim());
      // A result line that does not match is NOT dropped quietly: leaving it out
      // makes the tally cross-check below disagree, which is the point.
      if (m) tests.set(m[1], { outcome, reason: m[3] ?? null });
      continue;
    }
    const diag = DIAG_RE.exec(line);
    // LAST OCCURRENCE WINS: node emits a per-file summary and a run-level one,
    // and the run-level figure is the whole run's.
    if (diag) tally[diag[1]] = Number(diag[2]);
  }
  return { tests, tally };
}

/**
 * The parse's self-check against the reporter's own arithmetic. Catches a parse
 * that DISAGREES with the reporter; see the note above for what it does not
 * catch, and which guard does.
 * @returns {string[]} empty when they agree
 */
export function checkTally({ tests, tally }) {
  const counted = { pass: 0, fail: 0, skipped: 0 };
  for (const { outcome } of tests.values()) counted[outcome === 'skip' ? 'skipped' : outcome]++;
  const problems = [];
  for (const key of ['pass', 'fail', 'skipped']) {
    if (tally[key] === undefined) {
      problems.push(`the run printed no \`${key}\` summary diagnostic — the reporter format changed`);
    } else if (tally[key] !== counted[key]) {
      problems.push(`parsed ${counted[key]} ${key} result lines but the reporter tallied ${tally[key]}`
        + ' — the per-test line format changed and this parse is not to be trusted');
    }
  }
  return problems;
}
