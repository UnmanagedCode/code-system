// The store's one-shot, idempotent startup migration.
//
// Application code — the backend AND the launcher — assumes the current schema
// only: no read-time dual-shape parsing, no legacy key aliases, no
// back-compat defaults. This is the single place that knows any other shape
// ever existed.
//
// It has two jobs, IN THIS ORDER: upgrade what it recognises, then quarantine
// what it does not — so a record we cannot read is moved aside rather than
// deleted or silently skipped forever.
//
// The "already applied" self-check is the store's own contents — every record
// that reads at the current schema is left untouched — so running it twice is a
// no-op without a marker file to keep in sync.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { quarantineDir, remotesDir } from './paths.mjs';
import { SCHEMA, makeRecord, readRemote, writeRemote } from './store.mjs';

// Reasons a record cannot be read that mean "we do not understand this file",
// as opposed to "this file is not there" or "the disk refused us". Only these
// are moved aside; an unreadable-because-of-permissions record is a host
// problem and destroying it would not help.
const QUARANTINE_REASONS = new Set(['malformed', 'schema']);

// SCHEMA 1 → 2 ADDS THE OPERATOR GATE (`enabled`, src/store.mjs).
//
// THE ORDERING BELOW IS LOAD-BEARING, AND GETTING IT WRONG DESTROYS THE USER'S
// CONFIGURATION. `readRemote` refuses a schema-1 record with reason `'schema'`,
// and `'schema'` is in QUARANTINE_REASONS above — so an upgrade that ran after
// the quarantine branch, or not at all, would move EVERY EXISTING REMOTE aside
// and the user would open the UI to an empty list. Pinned by
// tests/migrate.test.mjs.
//
// It therefore reads the raw JSON itself rather than going through
// `readRemote`, which by construction can no longer read the shape it is
// upgrading FROM.
//
// THE GATE DEFAULTS OFF. An existing remote comes up switched off after the
// upgrade and the operator connects it — a `true` here would silently enable
// targets nobody has looked at since the gate existed.
async function upgrade(id, name) {
  let raw;
  try { raw = JSON.parse(await fs.readFile(path.join(remotesDir(), name), 'utf8')); }
  catch { return false; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 1) return false;

  // Built through `makeRecord` so an upgraded record and a freshly created one
  // are the SAME SHAPE — this file is the only place that knows schema 1 ever
  // existed, and it must not leave a third shape behind. The FILENAME STEM is
  // the address every reader uses (`readRemote(id)` opens `<id>.json`), so it,
  // not the record's own field, is what the upgraded record carries.
  const rec = makeRecord({
    remoteId: id,
    kind: raw.kind,
    label: raw.label,
    config: raw.config,
    enabled: false,
    baseline: raw.baseline,
    createdAt: raw.createdAt,
  });
  // The STORAGE SHAPE changed; the user's configuration did not. Letting
  // makeRecord's `now` stand would tell every card it was edited at startup.
  if (typeof raw.updatedAt === 'string') rec.updatedAt = raw.updatedAt;

  // Through the store's own atomic write: a half-written record is unreadable
  // configuration, and this one is being rewritten in place.
  await writeRemote(rec);
  return true;
}

export async function migrate({ log = () => {} } = {}) {
  await fs.mkdir(remotesDir(), { recursive: true });
  const result = { schema: SCHEMA, scanned: 0, upgraded: 0, quarantined: [] };

  let names;
  try { names = await fs.readdir(remotesDir()); }
  catch { return result; }

  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    result.scanned++;
    const r = await readRemote(id);
    if (r.ok) continue;

    // UPGRADE BEFORE QUARANTINE — see the note on `upgrade` above. A record at
    // a schema we do not recognise (a downgrade, a future version) returns
    // false and falls through to be moved aside.
    if (r.reason === 'schema' && await upgrade(id, name)) {
      result.upgraded++;
      log(`migrate: upgraded remote '${id}' to schema ${SCHEMA}`);
      continue;
    }

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
