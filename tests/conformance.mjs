#!/usr/bin/env node
// Runs CODE-CONDUCTOR'S OWN conformance suite against this launcher.
//
// That suite is the definition of a valid provider ("If a claim [in
// systems-protocol.md] and that suite disagree, the suite is right"), so this
// is the real check on the frame loop, the routing, fileops.mjs and the
// shutdown path — and it is the bar every kind is held to, `docker` included.
//
// POINT CC_CHECKOUT AT A CLONE OF THE PIN, never at a code-conductor worktree
// somebody is working in: this script runs cc's test runner with `cwd:
// <checkout>`. See docs/architecture.md → "The consequence for cards 2026-0003
// and 2026-0004" for the clone recipe.
//
// It runs against the `host` kind because the suite BUILDS ITS FIXTURES WITH
// NODE'S OWN `fs` AND THEN ASKS THE PROVIDER ABOUT THEM, so it verifies a
// provider reaching the same filesystem as the test process. See
// docs/architecture.md → "The `host` kind".
//
// GATED on CC_CHECKOUT and SKIPPING (not failing) without it, so `npm test`
// needs nothing but Node.
//
//   CC_CHECKOUT=/path/to/code-conductor npm run conformance
//
// NOTHING IN THE CHECKOUT IS MODIFIED — the suite is read and run, never
// edited. Editing it is how a provider fakes conformance.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOW_ENV, ALLOW_UNFENCED_ENV } from '../src/launcher/kinds/host.mjs';
import { LAUNCHER_MAIN } from '../src/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const checkout = process.env.CC_CHECKOUT?.trim();

if (!checkout) {
  console.log('conformance: SKIPPED — set CC_CHECKOUT=/path/to/code-conductor to run cc\'s own suite');
  process.exit(0);
}

const suite = path.join('tests', 'systems-protocol-conformance.test.mjs');
const runner = path.join('tests', 'run.mjs');
for (const rel of [runner, suite]) {
  if (!existsSync(path.join(checkout, rel))) {
    console.error(`conformance: ${checkout} does not look like a code-conductor checkout (missing ${rel})`);
    process.exit(1);
  }
}

// THE DRIFT CHECK RUNS FIRST, and aborts the battery. It is the one test that
// needs a checkout, this is the one command that already demands one, and
// running it here is what stops it skipping silently for the rest of its life.
const drift = spawnSync(
  process.execPath,
  ['--test', path.join(HERE, 'protocol-constants.test.mjs')],
  { cwd: path.dirname(HERE), env: { ...process.env, CC_CHECKOUT: checkout }, stdio: 'inherit' },
);
if (drift.status !== 0) {
  console.error('\nconformance: ABORTED — our protocol constants have drifted from cc\'s at this checkout');
  process.exit(drift.status ?? 1);
}

const provider = JSON.stringify([process.execPath, LAUNCHER_MAIN, '--kind', 'host']);
console.log(`\nconformance: ${checkout}\nconformance: provider ${provider}\n`);

const child = spawn(process.execPath, [runner, suite], {
  cwd: checkout,
  env: {
    ...process.env,
    CC_CONFORMANCE_PROVIDER: provider,
    // The suite is the `host` kind's reason to exist, so this is where both
    // guards are opened — deliberately, and nowhere else in the shipped code.
    // The second one is needed because the suite's core capability
    // configurations pass no `--remote`, and therefore serve unfenced.
    [ALLOW_ENV]: '1',
    [ALLOW_UNFENCED_ENV]: '1',
  },
  stdio: 'inherit',
});
child.on('close', (code) => process.exit(code ?? 1));
