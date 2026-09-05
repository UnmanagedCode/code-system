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
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnSuite(checkout, env, { stdio }) {
  return spawn(process.execPath, [RUNNER_REL, SUITE_REL], {
    cwd: checkout,
    env: { ...process.env, ...env },
    stdio,
  });
}
