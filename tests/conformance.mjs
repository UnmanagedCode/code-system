#!/usr/bin/env node
// Runs CODE-CONDUCTOR'S OWN conformance suite against this launcher, on the
// `host` kind.
//
// That suite is the definition of a valid provider ("If a claim [in
// systems-protocol.md] and that suite disagree, the suite is right"), so this
// is the real check on the frame loop, the routing, fileops.mjs and the
// shutdown path — and it is the bar every kind is held to, `docker` included.
//
// It runs against the `host` kind because the suite BUILDS ITS FIXTURES WITH
// NODE'S OWN `fs` AND THEN ASKS THE PROVIDER ABOUT THEM, so it verifies a
// provider reaching the same filesystem as the test process. See
// docs/architecture.md → "The `host` kind".
//
//   CC_CHECKOUT=/path/to/code-conductor npm run conformance
//
// The BOUND counterpart — the same battery against the shipped `docker`
// transport, over a container that shares this filesystem — is
// `npm run conformance:docker` (tests/conformance-docker.mjs). Everything the
// two share lives in tests/ccCheckout.mjs.

import { LAUNCHER_MAIN } from '../src/paths.mjs';
import { ALLOW_ENV, ALLOW_UNFENCED_ENV } from '../src/launcher/kinds/host.mjs';
import { assertNoDrift, checkoutOrSkip, spawnSuite } from './ccCheckout.mjs';

const SCRIPT = 'conformance';

const checkout = checkoutOrSkip(SCRIPT);
assertNoDrift(SCRIPT, checkout);

const provider = JSON.stringify([process.execPath, LAUNCHER_MAIN, '--kind', 'host']);
console.log(`\n${SCRIPT}: ${checkout}\n${SCRIPT}: provider ${provider}\n`);

const child = spawnSuite(checkout, {
  CC_CONFORMANCE_PROVIDER: provider,
  // The suite is the `host` kind's reason to exist, so this is where both
  // guards are opened — deliberately, and nowhere else in the shipped code.
  // The second one is needed because the suite's core capability
  // configurations pass no `--remote`, and therefore serve unfenced.
  [ALLOW_ENV]: '1',
  [ALLOW_UNFENCED_ENV]: '1',
}, { stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 1));
