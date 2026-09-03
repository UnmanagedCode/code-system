// THE CONFORMANCE VEHICLE: a kind that execs directly on cc's own host.
//
// It exists because cc's conformance suite "builds its fixtures with node's own
// `fs` and then asks the provider about them, so it verifies a provider that
// reaches THE SAME FILESYSTEM as the test process"
// (code-conductor tests/referenceProviderHarness.mjs:58-62). A docker or ssh
// target does not share that filesystem, so NOTHING BUT A HOST KIND CAN RUN
// CC'S SUITE AGAINST THIS CODE. Deleting it removes the only way to check the
// frame loop, the routing, fileops and the shutdown path against cc's own
// assertions. See docs/architecture.md → "The `host` kind".
//
// IT IS NEVER AUTO-REGISTERED (it is absent from REGISTERED_KINDS), but "we
// never register it" is not a fence. A row registered by hand with
// `--kind host` is an unfenced arbitrary-exec provider on cc's own machine,
// reachable by any project pointed at it. cc gates its own equivalent
// (CC_LOCAL_SYSTEM_PROVIDER) behind an env var for exactly this reason
// (src/systems/registry.ts:58-71), and so do we — see assertHostKindAllowed.

import os from 'node:os';
import path from 'node:path';

// The test seam, sibling to CODE_SYSTEM_STORE. cc spawns the launcher with the
// ORCHESTRATOR's environment (providerConnection.ts:157-159), so a
// hand-registered row inherits whatever the orchestrator has — which will not
// carry this unless someone deliberately exported it into the orchestrator
// process.
export const ALLOW_ENV = 'CODE_SYSTEM_ALLOW_HOST_KIND';

// Returns null when allowed, or the refusal text. main.mjs writes it to stderr
// and exits 2 BEFORE ANY FRAME, so cc's registration answers 502 quoting it.
export function hostKindRefusal(env = process.env) {
  if (env[ALLOW_ENV] === '1') return null;
  return `the 'host' kind execs directly on cc's own machine and is a TEST VEHICLE for`
    + ` code-conductor's conformance suite, not a provider to register.`
    + ` Set ${ALLOW_ENV}=1 in the launcher's environment to enable it.`;
}

export function createHostTransport({
  persistentShell = true,
  processGroupSignal = true,
  remotes = false,
  remoteDescriptors = false,
} = {}) {
  return {
    kind: 'host',

    // Absolute, and a constant: it is answered at a handshake that happens with
    // zero remotes configured, so there is nothing to probe it against.
    defaultShell: '/bin/bash',

    // HOST KEEPS persistentShell, AND THAT IS DELIBERATE — do not "fix" it to
    // match docker/ssh. Two of cc's three CAPABILITY_CONFIGS deep-equal
    // `persistentShell: true` (tests/referenceProviderHarness.mjs:79,89), so a
    // hardcoded `false` here would lose two of the three core configurations —
    // most of the exec-lifecycle, fileops, derivation and error-taxonomy
    // coverage, none of which is about shells. It costs nothing to support: a
    // host exec already holds its child's stdin open.
    //
    // `--no-persistent-shell` maps onto it (the harness's "or map them"
    // clause), and with the flag we advertise false and refuse `stdin` frames
    // EUNSUPPORTED, which is what the suite asserts at :368/:375.
    persistentShell,

    processGroupSignal,

    // DERIVED FROM FLAGS, not declared — which is what makes cc's three core
    // capability configurations runnable at all: they pass no flags and
    // deep-equal `remotes:false`. This is the same shape cc's own reference
    // provider uses (`remotes: this.#opts.remotes.size > 0`,
    // referenceProvider.ts:194), and the suite's assertion message says the
    // intent out loud: "the flags the provider was launched with are what it
    // advertises".
    remotes,
    remoteDescriptors,

    // Nothing to configure: the target is the machine we are already on.
    validateConfig() { return { ok: true, config: {} }; },

    // PURE. The core spawns what this returns.
    spawnPlan(_config, req) {
      const [file, args] = req.shell !== null
        // `bash -lc` is the contract's own definition of the `shell` exec form
        // (docs/systems-protocol.md:329).
        ? ['bash', ['-lc', req.shell]]
        : [String(req.argv?.[0]), (req.argv ?? []).slice(1)];
      return {
        file,
        args,
        cwd: req.cwd,
        env: req.env,
        // `detached` makes the child its own process-GROUP leader, which is the
        // whole of the processGroupSignal capability: without it one kill
        // cannot reach a grandchild.
        detached: processGroupSignal,
      };
    },

    // A host-side artifact only, so the backend and the launcher can each ask
    // independently and get the same answer. We are the host.
    async reachability() {
      return { connected: true, detail: `cc's own host (${os.hostname()})`, fingerprint: `host:${process.platform}` };
    },

    // A host child IS our OS descendant, so killing its group — which the core
    // already does before calling this — suffices. docker and ssh implement
    // this for real in cards 2026-0003 and 2026-0004.
    async reap() {},

    // Advisory handshake fields.
    descriptor() {
      return { os: process.platform, pathSep: path.sep, home: os.homedir() };
    },
  };
}
