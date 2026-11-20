// The two absolute paths this plugin has to agree on across two processes, and
// the ONLY place either is spelled.
//
// The backend and the launcher are separate processes with different
// environments: cc spawns the launcher with the ORCHESTRATOR's env and cwd
// (src/systems/providerConnection.ts — `env: this.#launch.env ?? process.env`,
// `cwd` undefined), so the launcher carries no CONDUCTOR_PLUGIN_ID, no
// PROJECTS_ROOT and no reliable cwd. A home-relative absolute path is the only
// store location both processes can compute identically from nothing.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// An env seam whose only job is to make the store swappable under test,
// following cc's own precedent for exactly this (CC_LOCAL_SYSTEM_PROVIDER,
// src/systems/registry.ts). Every test gets its own mkdtemp store through it.
export function storeRoot() {
  const override = process.env.CODE_SYSTEM_STORE?.trim();
  return override || path.join(os.homedir(), '.code-system');
}

export function remotesDir() {
  return path.join(storeRoot(), 'remotes');
}

// Where migrate.mjs moves a record it cannot READ. Never deleted, because a
// record we cannot read is still the user's configuration.
export function quarantineDir() {
  return path.join(storeRoot(), 'quarantine');
}

// The launcher entry point, absolute. This is what goes in the cc System row's
// `launch` argv, so it must not depend on the orchestrator's cwd.
export const LAUNCHER_MAIN = path.join(HERE, 'launcher', 'main.mjs');

// ── the agent kind's on-disk names ─────────────────────────────────────
//
// The broker (src/agent/broker.mjs) is a detached process that outlives the
// backend and every launcher, so its rendezvous is a path every one of them
// computes the same way: under the store, beside the remotes.

const REPO = path.dirname(HERE);

// The single-file Python agent the broker serves at `GET /agent.py`, and whose
// PROTOCOL block src/agent/protocol.mjs reads.
export const AGENT_PY = path.join(REPO, 'agent', 'agent.py');
export const BROKER_MAIN = path.join(HERE, 'agent', 'broker.mjs');
export const BRIDGE_MAIN = path.join(HERE, 'agent', 'bridge.mjs');
// The directory whose *.mjs files, with AGENT_PY, make up the broker's build id.
export const AGENT_SRC_DIR = path.join(HERE, 'agent');

// 0700, refused rather than repaired when its owner or mode is wrong.
export function agentDir() {
  return path.join(storeRoot(), 'agent');
}

export function agentSocketPath(dir = agentDir()) {
  return path.join(dir, 'broker.sock');
}

// Written by a broker that could not start (`{at, message}`), read only when the
// socket does not answer, deleted by the next broker that starts.
export function agentErrorPath(dir = agentDir()) {
  return path.join(dir, 'broker-error.json');
}

// A record-sized file that EXISTS, which the broker reads in place of a record
// that does not, so an absent remote's handshake costs a successful read too
// (src/agent/broker.mjs `lookupSecret`). Outside `remotes/`, so nothing lists it.
export function agentHandshakeDummyPath(dir = agentDir()) {
  return path.join(dir, 'handshake-dummy.json');
}

// And one that NEVER exists (the broker removes it at startup), read where no
// record was missing, so every handshake also pays exactly one failing open.
// In the broker's own directory, so no remote id can make it exist.
export function agentHandshakeMissPath(dir = agentDir()) {
  return path.join(dir, 'handshake-absent.json');
}

// The broker's stdout and stderr.
export function agentLogPath(dir = agentDir()) {
  return path.join(dir, 'broker.log');
}

// A unix socket path has a hard length limit (sun_path: 108 bytes on Linux,
// 104 on macOS); past it bind/connect fail with a message that names nothing.
export const SOCKET_PATH_MAX = 100;

/** Why `p` cannot be the broker's socket, or null. */
export function socketPathDefect(p = agentSocketPath()) {
  if (Buffer.byteLength(p) <= SOCKET_PATH_MAX) return null;
  return `the agent listener's socket path ${JSON.stringify(p)} is longer than ${SOCKET_PATH_MAX} bytes,`
    + ' which a unix socket cannot bind — point CODE_SYSTEM_STORE at a shorter directory';
}
