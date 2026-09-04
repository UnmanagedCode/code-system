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
