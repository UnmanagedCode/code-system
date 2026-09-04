// The per-remoteId config store: one JSON file per remote at
// <store>/remotes/<remoteId>.json.
//
// ONE FILE PER REMOTE, not one catalog file, for three reasons: a per-frame
// lookup is one small read instead of a parse of every remote; two concurrent
// backend writes cannot clobber each other's remote; and delete is an unlink.
//
// THERE IS NO CACHE. `readRemote` is readFile + JSON.parse on every call, with
// no memoisation and no fs.watch. That absence is the whole mechanism behind
// "the launcher reads the store fresh": it holds no remote state between
// frames, so there is nothing for the backend to invalidate. The cost is one
// ~200-byte local read per request frame, against an operation that is already
// a round trip to a container or another machine.
//
// THE BACKEND IS THE ONLY WRITER. The launcher calls readRemote/listRemotes and
// nothing else.
//
// `enabled` IS THE OPERATOR GATE, and it lives here rather than in backend
// memory because the backend and the launcher are DIFFERENT PROCESSES — cc
// spawns the launcher per System row, so an in-memory flag would never reach
// it. Being a store field, it inherits the no-cache property above: a toggle
// flipped in the UI is visible to the very next request frame the launcher
// handles, with no restart, no IPC and nothing to invalidate.
//
// IT IS NOT `reachability.connected`. That is the PROBED state — whether the
// container is running, whether an ssh master is up — re-asked on every card
// render and never stored. `enabled` is what the operator SET, and it is the
// only thing that decides whether an operation is allowed to run. The two
// disagree routinely (.wiki/gotchas/gate-versus-probe.md).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { remotesDir } from './paths.mjs';

export const SCHEMA = 2;

// A remoteId is TWO things at once, and both constrain it: it is a filename
// stem, and it is the entire hand-off contract to cc — a user reads it off the
// card UI and pastes it into a project's Remote field
// (.wiki/gotchas/no-remote-discovery.md), so it must be human-typable rather
// than an opaque token. It is never renamed once created.
export const REMOTE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidRemoteId(id) {
  return typeof id === 'string'
    && REMOTE_ID_RE.test(id)
    // Belt and braces on top of the charset: these two would escape the
    // remotes directory as filename stems.
    && id !== '.' && id !== '..';
}

function recordPath(id) {
  return path.join(remotesDir(), `${id}.json`);
}

// A failed read is a NAMED refusal, never a guess. The caller maps `reason` to
// a wire code; nothing here knows about the protocol.
//
// reasons: 'invalid-id' | 'absent' | 'unreadable' | 'malformed' | 'schema'
export async function readRemote(id) {
  if (!isValidRemoteId(id)) {
    return { ok: false, reason: 'invalid-id', message: `'${id}' is not a valid remote id (${REMOTE_ID_RE.source})` };
  }
  let text;
  try {
    text = await fs.readFile(recordPath(id), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'absent', message: `no remote '${id}' is configured` };
    return { ok: false, reason: 'unreadable', message: `remote '${id}' could not be read: ${e?.message ?? e}` };
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) {
    return { ok: false, reason: 'malformed', message: `remote '${id}' is not valid JSON: ${e?.message ?? e}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'malformed', message: `remote '${id}' is not a JSON object` };
  }
  // REFUSED BY NAME, never guessed at. A launcher can be spawned before the
  // backend has ever run its migration, so it can genuinely meet a record it
  // does not understand — and a read-time upgrade here would be the
  // dual-shape parsing the migration exists to prevent.
  if (raw.schema !== SCHEMA) {
    return {
      ok: false,
      reason: 'schema',
      message: `remote '${id}' is stored at schema ${JSON.stringify(raw.schema)}, but this version reads schema ${SCHEMA} only`
        + ' — start the code-system backend, which migrates the store on startup',
    };
  }
  return { ok: true, record: raw };
}

export async function listRemotes() {
  let names;
  try { names = await fs.readdir(remotesDir()); }
  catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    const r = await readRemote(id);
    // A record that will not read is still surfaced, so the card UI can say so
    // rather than showing a shorter list than the user configured.
    out.push(r.ok ? { ok: true, record: r.record } : { ok: false, remoteId: id, reason: r.reason, message: r.message });
  }
  return out;
}

let tmpSeq = 0;

// Atomic: a unique temp beside the target, fsync, rename over. The temp name is
// unique PER CALL (pid + counter) for the reason docs/systems-protocol.md gives
// about atomic writes generally — a shared one lets one writer's rename delete
// another's source file.
export async function writeRemote(record) {
  if (!isValidRemoteId(record?.remoteId)) {
    throw new Error(`refusing to write a record with invalid remoteId ${JSON.stringify(record?.remoteId)}`);
  }
  await fs.mkdir(remotesDir(), { recursive: true });
  const target = recordPath(record.remoteId);
  const tmp = `${target}.${process.pid}.${tmpSeq++}.tmp`;
  let fh;
  try {
    fh = await fs.open(tmp, 'w', 0o600);
    await fh.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.rename(tmp, target);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  return record;
}

export async function deleteRemote(id) {
  if (!isValidRemoteId(id)) return false;
  try {
    await fs.unlink(recordPath(id));
    return true;
  } catch (e) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
}

// The record a create/edit produces. `config` is opaque here — the kind's
// validateConfig owns it — and `baseline` is written only by the probe.
//
// `enabled` DEFAULTS FALSE, which is also what a newly created remote gets: an
// ssh remote genuinely has no master until `connect` runs, and a default-on
// gate would claim a state nobody established.
export function makeRecord({ remoteId, kind, label, config, enabled = false, baseline = null, createdAt }) {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA,
    remoteId,
    kind,
    label: label || remoteId,
    config: config ?? {},
    enabled: enabled === true,
    baseline: baseline ?? { state: 'unknown', fingerprint: null, missing: [], checkedAt: null },
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}
