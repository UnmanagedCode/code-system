// THE KIND REGISTRY, and the seam every provider kind plugs into.
//
// A Transport answers exactly one question: "how do I reach this target from
// cc's host". It never touches frames, ids, chunking, error codes, timeouts or
// file semantics — src/launcher/session.mjs and src/launcher/fileops.mjs own
// all of those, once, for every kind.
//
// ADDING A KIND IS ONE FILE HERE PLUS ONE LINE BELOW. Nothing in
// src/registration.mjs or src/store.mjs changes.

import { createDockerTransport } from './docker.mjs';
import { createHostTransport } from './host.mjs';
import { createSshTransport } from './ssh.mjs';

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
 * @property {(config:object) => Promise<Reachability>} reachability
 * @property {(config:object, handle:ExecHandle) => Promise<void>} reap
 *   MAY THROW. A kind that cannot prove its relay reached the far side must say
 *   so rather than return quietly — "nothing was killed" and "the kill could not
 *   run" are indistinguishable from the core, and only one of them is a leak.
 *   session.mjs reports a throw on stderr and carries on.
 * @property {(config:object) => Promise<object>} [connect]
 * @property {(config:object) => Promise<void>} [disconnect]
 *   OPTIONAL, and only meaningful for a kind whose transport multiplexes. For
 *   `ssh` they open and close the ControlMaster: `connect` is the one operation
 *   that BINDS the control socket (and so the only one allowed the I/O that
 *   builds its directory), `disconnect` is `ssh -O exit` and is IDEMPOTENT.
 *   They govern the MULTIPLEXED MASTER ONLY, never authorization: an `exec`
 *   after a `disconnect` still succeeds, unmultiplexed. Nothing in the core
 *   calls them — the live fixture's setup/teardown does, and card 2026-0005's
 *   buttons will.
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
