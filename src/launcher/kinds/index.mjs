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
 */

/**
 * @typedef {{argv:string[]|null, shell:string|null, cwd:string,
 *            env:Record<string,string>|null, stdinMode:'pipe'|'ignore',
 *            remoteId:string|null, token:string}} ExecRequest
 *
 * `env` REPLACES the environment exactly as posix_spawn does; null means
 * inherit. `token` is a per-exec nonce the core generates for `reap` to find
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
