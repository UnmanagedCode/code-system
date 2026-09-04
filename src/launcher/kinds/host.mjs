// THE CONFORMANCE VEHICLE: a kind that execs directly on cc's own host.
//
// TWO REASONS IT EXISTS, each load-bearing on its own:
//
//  (a) It is the only far side that reaches THE TEST PROCESS'S OWN FILESYSTEM.
//      cc's suite "builds its fixtures with node's own `fs` and then asks the
//      provider about them" (systems-protocol.md §10), so only a host kind can
//      answer them. `CC_CONFORMANCE_REMOTE_ID` fixes ADDRESSING, not filesystem
//      identity, so binding a docker target does not substitute. The same
//      requirement makes `host` the far side for tests/fileops.test.mjs (the
//      only real-shell proof the generated read/write scripts are correct) and
//      tests/baseline.test.mjs (the only proof PROBE_SCRIPT is valid POSIX sh).
//
//  (b) `npm run conformance` drives the battery THROUGH THE SHIPPED LAUNCHER —
//      `[node, src/launcher/main.mjs, --kind, host]` — so it exercises arg
//      parsing, kind dispatch, the frame loop, routing and shutdown. A
//      test-only provider entry point would prove the transport speaks the
//      protocol but not that the shipped launcher does; recovering that means
//      importing main.mjs from the entry point, which is `--kind host` with
//      extra steps. Considered and rejected — do not re-litigate.
//
// See docs/architecture.md → "The `host` kind".
//
// WHAT THE TWO ENV SEAMS ACTUALLY BUY. A cc System row's `launch` is a string[]
// cc validates only for SHAPE and REACHABILITY: `validateLaunch`
// (src/appSettings.ts) checks a non-empty array of non-empty strings, and
// `verifySystemLaunch` proves it works by spawning it and handshaking.
// `getSystems()` then reads it back with no content check. There is no
// allow-list and no path check anywhere — nothing constrains WHICH executable
// an argv names. So anyone able to register a row can ALREADY have cc spawn an
// arbitrary argv on cc's host, and
// these seams are not what stands between an attacker and host execution. What
// `--kind host` adds over an arbitrary argv is narrower: it turns a one-shot
// argv into a STANDING, protocol-speaking exec service any cc project can be
// pointed at via its Remote field. The seams stop a MISCONFIGURATION becoming
// that — they do not stop a compromise. The REGISTERED_KINDS omission is the
// separate half: it is what stops US ever creating such a row.

import os from 'node:os';

import { execEnv } from './config.mjs';

// The test seam, sibling to CODE_SYSTEM_STORE. cc spawns the launcher with the
// ORCHESTRATOR's environment (providerConnection.ts, the provider spawn), so a
// hand-registered row inherits whatever the orchestrator has — which will not
// carry this unless someone deliberately exported it into the orchestrator
// process.
export const ALLOW_ENV = 'CODE_SYSTEM_ALLOW_HOST_KIND';

// THE SECOND SEAM, and it gates only the UNFENCED-serving path.
//
// The original plan made at least one `--remote <id>=<root>` fence MANDATORY.
// That is unimplementable, and the reason is entirely on OUR side of the wire:
// cc's CAPABILITY_CONFIGS pass no flags at all, so no `--remote` ever reaches
// us in the core battery, so hostUnfencedRefusal() would fire and main.mjs
// would exit 2 before any frame — every core configuration dead at the launch,
// not at an assertion. That kills reason (b) above.
//
// A fenced `host` needs only ALLOW_ENV. Serving UNFENCED — the shape a
// hand-registered row would take — additionally needs a variable with UNFENCED
// in its name. NO SHIPPED CODE PATH SETS IT: it is set only under tests/, which
// is the property that matters and the one to preserve when adding a test.
// So the residual risk is no longer "someone exported the general test var",
// it is "someone deliberately exported a variable that says UNFENCED into the
// orchestrator's environment".
export const ALLOW_UNFENCED_ENV = 'CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED';

// Returns null when allowed, or the refusal text. main.mjs writes it to stderr
// and exits 2 BEFORE ANY FRAME, so cc's registration answers 502 quoting it.
export function hostKindRefusal(env = process.env) {
  if (env[ALLOW_ENV] === '1') return null;
  return `the 'host' kind execs directly on cc's own machine and is a TEST VEHICLE for`
    + ` code-conductor's conformance suite, not a provider to register.`
    + ` Set ${ALLOW_ENV}=1 in the launcher's environment to enable it.`;
}

// Returns null when this launch is allowed to serve with no `--remote` fence.
export function hostUnfencedRefusal(remoteCount, env = process.env) {
  if (remoteCount > 0) return null;
  if (env[ALLOW_UNFENCED_ENV] === '1') return null;
  return `the 'host' kind was given no --remote <id>=<absolute root> fence, so it would serve`
    + ` arbitrary exec anywhere on cc's own machine. Pass at least one --remote, or set`
    + ` ${ALLOW_UNFENCED_ENV}=1 (which code-conductor's conformance suite needs, because its`
    + ` core capability configurations pass no flags).`;
}

export function createHostTransport({
  processGroupSignal = true,
  remotes = false,
  remoteDescriptors = false,
} = {}) {
  return {
    kind: 'host',

    processGroupSignal,

    // DERIVED FROM FLAGS, not declared. systems-protocol.md §10's launch
    // surface makes each capability advertised IFF at least one of its flags is
    // given, and "every configuration runs whatever the provider does with
    // those flags" — so a hardcoded value breaks one group or the other: the
    // core fixtures pass no `--remote`/`--mirror` and build UNBOUND handles,
    // while the remotes and mirror fixtures pass them and need the opposite.
    // Same shape cc's own reference provider uses
    // (`remotes: this.#opts.remotes.size > 0`, the hello capabilities block in
    // referenceProvider.ts), and the suite's assertion message says the intent
    // out loud: "the flags the provider was launched with are what it
    // advertises".
    remotes,
    remoteDescriptors,

    // Nothing to configure: the target is the machine we are already on.
    validateConfig() { return { ok: true, config: {} }; },

    // PURE. The core spawns what this returns.
    spawnPlan(_config, req) {
      const [file, args] = req.shell !== null
        // `bash -lc` is the contract's own definition of the `shell` exec form
        // (systems-protocol.md §5).
        ? ['bash', ['-lc', req.shell]]
        : [String(req.argv?.[0]), (req.argv ?? []).slice(1)];
      return {
        file,
        args,
        cwd: req.cwd,
        // The frame's env (an object REPLACES, null inherits — and on this kind
        // the far side IS cc's own host, so inheriting is process.env), with
        // CC_REMOTE overlaid last. Composed in kinds/config.mjs so docker and
        // host cannot disagree about the overlay order.
        env: execEnv(req.env, req.remoteId),
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
    // already does before calling this — suffices. `docker` implements this for
    // real (a token scan inside the container); `ssh` in card 2026-0004.
    async reap() {},
  };
}
