// The store's one-shot, idempotent startup pass.
//
// It has TWO jobs, in this order:
//
//   1. UPGRADE a record at the immediately previous schema in place, so an
//      operator's existing remotes survive a plugin update.
//   2. QUARANTINE a record the current readers still cannot understand, so it is
//      moved aside rather than deleted or silently skipped forever.
//
// THE ORDER IS LOAD-BEARING, and stays load-bearing for schema 3. `readRemote`
// refuses an unrecognised schema with reason `'schema'`, which is in
// QUARANTINE_REASONS — an upgrade ordered AFTER the quarantine branch would move
// every existing remote aside instead of upgrading it. So an upgrade reads the
// raw JSON itself, before anything asks `readRemote` for an opinion.
//
// AN UPGRADE GOES HERE AND NOWHERE ELSE: application code — the backend AND the
// launcher — assumes the current schema only, with no read-time dual-shape
// parsing, no legacy key aliases and no back-compat defaults.
//
// The "already applied" self-check is the store's own contents — a record is
// upgraded only from the exact previous schema, and one already at the current
// schema is left untouched — so running the pass twice is a no-op without a
// marker file to keep in sync.
//
// NO ONE RECORD MAY TAKE THE PASS DOWN. server.mjs awaits it BEFORE `listen`,
// and the backend is the operator's only repair tool — so a PER-RECORD failure
// (a full disk, an unrenameable file) is logged and skipped, never allowed to
// cost every other remote its UI and API. Guarded individually: the upgrade
// write, and the quarantine move.
//
// DELIBERATELY NOT GUARDED: ensuring the remotes directory itself exists, at the
// top of `migrate`. That is not one record's problem — a backend that cannot
// create its own store has nothing to serve, and failing loudly at boot is the
// honest answer.
//
// SCHEMA 1 → 2 (card 2026-0017) added `mirror`, the per-remote mirror
// advertisement, as a top-level field beside `enabled` (src/store.mjs). A
// schema-1 record advertised nothing, so the upgrade writes `mirror: null`,
// which is the same "I advertise nothing" it already had.
//
// KNOWN TRANSIENT: a launcher spawned against a schema-1 record BEFORE the
// backend has run refuses that remote with the existing ENOREMOTE, whose
// message already names the repair ("start the code-system backend, which moves
// a record it cannot read aside"). server.mjs migrates before it serves, so the
// window is "plugin updated, backend not yet started".

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { quarantineDir, remotesDir } from './paths.mjs';
import { SCHEMA, isValidRemoteId, readRemote, writeRemote } from './store.mjs';

// Reasons a record cannot be read that mean "we do not understand this file",
// as opposed to "this file is not there" or "the disk refused us". Only these
// are moved aside; an unreadable-because-of-permissions record is a host
// problem and destroying it would not help.
const QUARANTINE_REASONS = new Set(['malformed', 'schema']);

// Rewrite a schema-1 record as schema 2.
//
// NEVER THROWS, AND THAT IS NOT A NICETY: this runs at backend boot, before
// `listen`, and the backend IS the operator's repair tool. One unreadable file,
// one full disk or one read-only mount must not take the whole UI and API down
// for every other remote.
//
// Three outcomes, because they need three different responses:
//   'upgraded' — rewritten at schema 2
//   'skip'     — not ours to rewrite; the quarantine branch decides
//   'failed'   — we could not write it. The record is UNTOUCHED and still at
//                schema 1, so the caller must NOT let it fall through to the
//                quarantine branch: a transient disk error would move aside a
//                record that is perfectly upgradable on the next boot.
async function upgradeToSchema2(id, log) {
  let raw;
  try { raw = JSON.parse(await fs.readFile(path.join(remotesDir(), `${id}.json`), 'utf8')); }
  catch { return 'skip'; }  // absent or malformed — the quarantine branch's business
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'skip';
  // EXACT VERSION, which is what makes the pass idempotent with no marker: a
  // record already at 2 falls straight through, and one from the future is
  // quarantined below rather than guessed at.
  if (raw.schema !== 1) return 'skip';
  // A record whose id does not match its filename is not one we can rewrite —
  // writeRemote addresses the file BY the record's remoteId, so rewriting it
  // would write the wrong file (or throw at boot on an unaddressable id). Let
  // readRemote refuse it and the quarantine branch move it aside.
  if (raw.remoteId !== id || !isValidRemoteId(id)) return 'skip';
  try {
    await writeRemote({ ...raw, schema: 2, mirror: null });
  } catch (e) {
    log(`migrate: could not upgrade remote '${id}' schema 1 → 2 (${e?.message ?? e})`
      + ' — left untouched for the next backend start');
    return 'failed';
  }
  return 'upgraded';
}

export async function migrate({ log = () => {} } = {}) {
  await fs.mkdir(remotesDir(), { recursive: true });
  const result = { schema: SCHEMA, scanned: 0, upgraded: [], quarantined: [] };

  let names;
  try { names = await fs.readdir(remotesDir()); }
  catch { return result; }

  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    result.scanned++;

    // BEFORE readRemote, for the ordering reason at the top of this file.
    const upgrade = await upgradeToSchema2(id, log);
    // An upgrade we could not WRITE leaves a schema-1 record on disk, which
    // readRemote refuses with reason 'schema' — a quarantine reason. Skipping
    // the rest of this iteration is what keeps a full disk from moving aside a
    // record the next boot would upgrade cleanly.
    if (upgrade === 'failed') continue;
    if (upgrade === 'upgraded') {
      result.upgraded.push(id);
      log(`migrate: upgraded remote '${id}' schema 1 → 2`);
    }

    const r = await readRemote(id);
    if (r.ok) continue;
    if (!QUARANTINE_REASONS.has(r.reason)) continue;

    // NEVER DESTROY WHAT CANNOT BE RECONSTRUCTED — move it aside. The stamp
    // keeps a second quarantine of the same id from overwriting the first.
    //
    // GUARDED for the same boot-time reason as the upgrade write: an
    // unrenameable file, or a quarantine directory that cannot be created, is
    // logged and skipped. The record stays where it is and is refused by name
    // at every read, which is the state it was already in.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const to = path.join(quarantineDir(), `${id}.${stamp}.json`);
    try {
      await fs.mkdir(quarantineDir(), { recursive: true });
      await fs.rename(path.join(remotesDir(), name), to);
    } catch (e) {
      log(`migrate: could not quarantine remote '${id}' (${e?.message ?? e})`
        + ' — left in place, and still refused by name at every read');
      continue;
    }
    result.quarantined.push({ remoteId: id, reason: r.reason, movedTo: to, message: r.message });
    log(`migrate: quarantined remote '${id}' (${r.reason}) → ${to}`);
  }
  return result;
}
