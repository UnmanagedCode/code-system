// THE KIND REGISTRY, and the seam every provider kind plugs into.
//
// A Transport answers exactly one question: "how do I reach this target from
// cc's host". It never touches frames, ids, chunking, error codes, timeouts or
// file semantics — src/launcher/session.mjs and src/launcher/fileops.mjs own
// all of those, once, for every kind.
//
// ADDING A KIND IS ONE FILE HERE PLUS ONE LINE BELOW. Nothing in
// src/registration.mjs or src/store.mjs changes.

import { KIND_META as DOCKER_META, createDockerTransport } from './docker.mjs';
import { createHostTransport } from './host.mjs';
import { KIND_META as SSH_META, createSshTransport } from './ssh.mjs';

/**
 * @typedef {object} Transport
 * @property {string}  kind          'docker' | 'ssh' | 'host'
 * @property {boolean} processGroupSignal  Advertised verbatim. `true` is a PROMISE
 *                                   that a signal reaches the far side's whole
 *                                   group; systems-protocol.md §11, item 2 calls
 *                                   advertising it falsely "the one lie this
 *                                   protocol cannot detect". Default false.
 * @property {boolean} remotes       Whether this kind advertises the `remotes`
 *                                   capability. CONSTANT PER KIND, never derived
 *                                   from store contents — see the note below.
 * @property {(raw:unknown) => {ok:true,config:object}|{ok:false,error:string}} validateConfig
 * @property {(config:object, req:ExecRequest) => SpawnPlan} spawnPlan  PURE. No I/O,
 *                                   no spawning — the core spawns it, which is what
 *                                   makes every kind's argv assertable with no
 *                                   docker and no ssh.
 * @property {(config:object, ctx:{remoteId:string|null}) => SpawnPlan|null} [channelPlan]
 *   OPTIONAL, and PURE like `spawnPlan`. The argv of ONE long-lived shell on the
 *   target, which src/launcher/channel.mjs holds open and writes framed commands
 *   into instead of paying a process + daemon + container-exec setup per frame
 *   (measured: 84–94 ms → 3.5–4.4 ms per op). It must be INVARIANT across every
 *   op that may ride it — no cwd, no per-op env, no per-exec token — because the
 *   pool keys its channels on this argv and a running shell has no per-op
 *   command line to put anything on.
 *
 *   A KIND WITHOUT IT IS UNTOUCHED. Every call site treats an absent member as
 *   "no channel offered" and takes the per-op spawn path, which is why `ssh` and
 *   `host` are byte-identical although `makeRunner` is shared by every kind.
 * @property {(config:object) => Promise<Reachability>} reachability
 * @property {(config:object, handle:ExecHandle) => Promise<void>} reap
 *   MAY THROW. A kind that cannot prove its relay reached the far side must say
 *   so rather than return quietly — "nothing was killed" and "the kill could not
 *   run" are indistinguishable from the core, and only one of them is a leak.
 *   session.mjs reports a throw on stderr and carries on.
 * @property {(config:object) => Promise<object>} connect
 * @property {(config:object) => Promise<void>} disconnect
 *   REQUIRED ON EVERY REGISTERED KIND. These are the OPERATOR GATE's per-kind
 *   side effect, not a multiplexing feature: the gate itself is `record.enabled`
 *   in the store, written by the backend and enforced in remotes.mjs, and these
 *   are whatever else that kind has to do when it moves. A kind with nothing to
 *   open still implements them — `docker`'s are a documented no-op pass,
 *   because every `docker exec` is a fresh client.
 *
 *   For `ssh` they open and close the ControlMaster: `connect` is the one
 *   operation that BINDS the control socket (and so the only one allowed the
 *   I/O that builds its directory), `disconnect` is `ssh -O exit`. BOTH ARE
 *   IDEMPOTENT — "already open" and "already closed" are each the requested
 *   state, and for `connect` that costs a pre-check because ssh's own
 *   `ControlMaster=yes` over a live socket degrades and exits 0 rather than
 *   failing. They govern the MULTIPLEXED MASTER ONLY, never authorization:
 *   an `exec` after a `disconnect` still succeeds, unmultiplexed. That measured
 *   fact is exactly WHY the gate is a separate mechanism rather than something
 *   derivable from the socket — see .wiki/gotchas/gate-versus-probe.md.
 *
 *   `connect` MAY THROW, and the backend's route leaves the gate OFF when it
 *   does: "enabled" must never mean "enabled but we could not".
 *   `disconnect` throwing is a warning on an otherwise-successful disable —
 *   disabling is a safety action and must not be blockable.
 * @property {(config:object, res:{code:number, stdout:string, stderr:string})
 *            => {code:string, message:string, stderr?:string}|null} [classifyFailure]
 *   OPTIONAL. Reads THE TRANSPORT's own error vocabulary — a docker daemon
 *   response, an ssh refusal — and turns a non-zero exit into a named protocol
 *   failure instead of an `exit` frame. Returns null when the failure is the
 *   COMMAND's own, which is the common case. Only the kind knows its transport's
 *   vocabulary, and remotes.mjs cannot help: for a stopped container the store
 *   record exists, so the lookup succeeds and the failure appears only here.
 */

/**
 * @typedef {{argv:string[]|null, shell:string|null, cwd:string,
 *            env:Record<string,string>|null, stdinMode:'pipe'|'ignore',
 *            remoteId:string|null, token:string}} ExecRequest
 *
 * `env` is THE FRAME'S OWN `env`, passed through unchanged: an object REPLACES
 * the environment exactly as posix_spawn does (§5), and `null` means inherit
 * THE FAR SIDE's — cc's own host for `host`, the container's own PATH/HOME/
 * toolchain for `docker`. The core never substitutes its own `process.env` for
 * an absent field: cc sends no `env` on ANY `exec` it issues — its own plumbing
 * and a caller's command alike, so every command runs in the provider's own
 * environment (§7) — and a launcher that collapsed the two would run every
 * derivation inside a container with cc's host PATH. Each kind composes with
 * `execEnv` (kinds/config.mjs), which is also where `CC_REMOTE` is overlaid —
 * after the replacement, so the provider's binding beats a frame-supplied
 * value.
 *
 * `token` is a per-exec nonce the core generates for `reap` to find
 * its own far-side processes by — a kind that needs it puts it into the remote
 * command's environment itself, inside spawnPlan, which is why the core never
 * injects it into `env` and cannot pollute a frame-supplied environment.
 */

/**
 * @typedef {{file:string, args:string[], cwd?:string,
 *            env?:Record<string,string>|null, detached?:boolean}} SpawnPlan
 *
 * `cwd` is the HOST-side child's working directory. For `host` that is the
 * frame's own cwd; for docker/ssh the frame's cwd rides in argv (`docker exec
 * -w`) and this is left unset.
 */

/** @typedef {{connected:boolean, detail:string, fingerprint:string|null}} Reachability */
/** @typedef {{pid:number|null, token:string, remoteId:string|null}} ExecHandle */

const FACTORIES = {
  docker: createDockerTransport,
  ssh: createSshTransport,
  host: createHostTransport,
};

// The kinds that get a cc System row, in src/registration.mjs. `host` is
// deliberately absent — see the guard in host.mjs and the note in
// docs/architecture.md.
export const REGISTERED_KINDS = ['docker', 'ssh'];

export const ALL_KINDS = Object.keys(FACTORIES);

// The card UI's per-kind form and label, one entry per REGISTERED kind. `host`
// has none deliberately: it is never registered and never gets a card.
const METAS = {
  docker: DOCKER_META,
  ssh: SSH_META,
};

/**
 * What `GET /api/kinds` serves and the card UI renders: each registered kind's
 * human label and the fields its form needs.
 *
 * THROWS for a registered kind with no KIND_META rather than serving a card
 * with an empty form — adding a kind is one file plus one line, and this is
 * what stops that line being added without the form.
 *
 * `kinds` is a parameter only so the completeness guard above is testable
 * without perturbing the registry; production always calls it with no argument.
 */
export function kindDescriptors(kinds = REGISTERED_KINDS) {
  return kinds.map((kind) => {
    const meta = METAS[kind];
    if (!meta) {
      throw new Error(`kind '${kind}' has no KIND_META — every registered kind needs a label and`
        + ' configFields, or the card UI cannot render a form for it');
    }
    return { kind, label: meta.label, configFields: meta.configFields };
  });
}

/**
 * The name of the config field that identifies a kind's TARGET — docker's
 * container, ssh's host. A surface rendering "what does this remote point at"
 * reads it from the kind instead of branching on the kind name.
 *
 * THROWS for a kind with no KIND_META or no `identityField`, for the same
 * reason `kindDescriptors` does: adding a kind is one file plus one line, and
 * this is what stops that line being added without an identifying field.
 *
 * DELIBERATELY NOT part of `kindDescriptors()`'s return value — that is the
 * `GET /api/kinds` wire shape, which this does not change.
 */
export function identityFieldFor(kind) {
  const field = METAS[kind]?.identityField;
  if (!field) {
    throw new Error(`kind '${kind}' has no KIND_META.identityField — every registered kind needs the name`
      + ' of the config field that identifies its target');
  }
  return field;
}

export function isKnownKind(kind) {
  return Object.hasOwn(FACTORIES, kind);
}

/**
 * @param {string} kind
 * @param {{processGroupSignal?:boolean, remotes?:boolean, remoteDescriptors?:boolean}} opts
 *   Effective capabilities, already lowered by any `--no-*` flag cc appended.
 * @returns {Transport|null}
 */
export function createTransport(kind, opts = {}) {
  const make = FACTORIES[kind];
  return make ? make(opts) : null;
}
