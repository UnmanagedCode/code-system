// The store's one-shot, idempotent startup pass.
//
// It has EXACTLY ONE JOB: quarantine a record the current readers cannot
// understand, so it is moved aside rather than deleted or silently skipped
// forever. There is no upgrade pass, and there is no version-handling code
// anywhere in this tree.
//
// DO NOT ADD AN UPGRADE PASS FOR SCHEMA 1. There is no earlier shape to upgrade
// FROM: schema 1 is the first and only schema, and it has always included every
// field the current readers expect — `enabled` among them. A record at any
// other `schema` value is from the future or is corrupt, and either way we
// cannot know what it means, so quarantining it is the honest answer rather
// than a guess.
//
// When a schema 2 genuinely arrives, its upgrade goes here and NOWHERE else:
// application code — the backend AND the launcher — assumes the current schema
// only, with no read-time dual-shape parsing, no legacy key aliases and no
// back-compat defaults. It will also have to run BEFORE the quarantine branch
// below and read the raw JSON itself, because `readRemote` refuses an
// unrecognised schema with reason `'schema'`, which is in QUARANTINE_REASONS —
// an upgrade ordered after it would move every existing remote aside instead of
// upgrading it.
//
// The "already applied" self-check is the store's own contents — every record
// that reads at the current schema is left untouched — so running it twice is a
// no-op without a marker file to keep in sync.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { quarantineDir, remotesDir } from './paths.mjs';
import { SCHEMA, readRemote } from './store.mjs';

// Reasons a record cannot be read that mean "we do not understand this file",
// as opposed to "this file is not there" or "the disk refused us". Only these
// are moved aside; an unreadable-because-of-permissions record is a host
// problem and destroying it would not help.
const QUARANTINE_REASONS = new Set(['malformed', 'schema']);

export async function migrate({ log = () => {} } = {}) {
  await fs.mkdir(remotesDir(), { recursive: true });
  const result = { schema: SCHEMA, scanned: 0, quarantined: [] };

  let names;
  try { names = await fs.readdir(remotesDir()); }
  catch { return result; }

  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    result.scanned++;
    const r = await readRemote(id);
    if (r.ok) continue;
    if (!QUARANTINE_REASONS.has(r.reason)) continue;

    // NEVER DESTROY WHAT CANNOT BE RECONSTRUCTED — move it aside. The stamp
    // keeps a second quarantine of the same id from overwriting the first.
    await fs.mkdir(quarantineDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const to = path.join(quarantineDir(), `${id}.${stamp}.json`);
    await fs.rename(path.join(remotesDir(), name), to);
    result.quarantined.push({ remoteId: id, reason: r.reason, movedTo: to, message: r.message });
    log(`migrate: quarantined remote '${id}' (${r.reason}) → ${to}`);
  }
  return result;
}
