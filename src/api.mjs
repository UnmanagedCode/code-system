// The backend REST surface. Card 2026-0005 builds the card UI on top of it and
// adds no new state — every fact a card needs is answered here.

import express from 'express';
import { refreshBaseline, unknownBaseline } from './baseline.mjs';
import { createTransport, isKnownKind } from './launcher/kinds/index.mjs';
import { REGISTERED_KINDS } from './launcher/kinds/index.mjs';
import { REQUEST_TIMEOUT_MS, readCapped, registrationState, runRegistration } from './registration.mjs';
import { deleteRemote, isValidRemoteId, listRemotes, makeRecord, readRemote, writeRemote } from './store.mjs';

// One remote's card view: the stored record, a LIVE reachability answer, and a
// baseline verdict re-probed only when the fingerprint moved.
async function cardFor(entry, { probe = true } = {}) {
  if (!entry.ok) {
    return {
      remoteId: entry.remoteId,
      broken: { reason: entry.reason, message: entry.message },
    };
  }
  const record = entry.record;
  const transport = createTransport(record.kind);
  if (!transport) {
    return { ...record, reachability: { connected: false, detail: `unknown kind '${record.kind}'`, fingerprint: null } };
  }
  let reach;
  try { reach = await transport.reachability(record.config ?? {}); }
  catch (e) { reach = { connected: false, detail: e instanceof Error ? e.message : String(e), fingerprint: null }; }

  // The probe is one round trip INTO the target, so it is gated on the target
  // being reachable and on the fingerprint having moved. A target that gets
  // fixed clears itself on the next refresh with no restart.
  const { record: out, probed } = probe
    ? await refreshBaseline(transport, record, reach)
    : { record, probed: false };
  if (probed) await writeRemote(out);
  return { ...out, reachability: reach };
}

async function projectsNaming(remoteId, { conductorUrl = process.env.CONDUCTOR_URL, fetchImpl = globalThis.fetch } = {}) {
  if (!conductorUrl) return [];
  try {
    // Bounded on both axes: Node's fetch has no default timeout, and this runs
    // inside a user's DELETE request. A conductor that stalls must not wedge it.
    const res = await fetchImpl(`${String(conductorUrl).replace(/\/+$/, '')}/api/settings/systems`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return [];
    const json = JSON.parse(await readCapped(res) || '{}');
    const rows = Array.isArray(json?.systems) ? json.systems : [];
    const out = [];
    for (const row of rows) {
      for (const p of row.projects ?? []) {
        if (p?.remoteId === remoteId) out.push({ project: p.name, system: row.id });
      }
    }
    return out;
  } catch { return []; }
}

export function createApi(deps = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '256kb' }));

  // Any HTTP response counts as alive.
  r.get('/health', (_req, res) => res.json({ ok: true, kinds: REGISTERED_KINDS }));

  r.get('/registration', (_req, res) => res.json(registrationState()));

  // THE ONLY RETRY, and it is user-driven. No timer, no backoff loop, no
  // restart-on-failure.
  r.post('/registration/retry', async (_req, res, next) => {
    try { res.json(await runRegistration(deps.registration ?? {})); }
    catch (e) { next(e); }
  });

  r.get('/remotes', async (_req, res, next) => {
    try {
      const entries = await listRemotes();
      const remotes = [];
      for (const e of entries) remotes.push(await cardFor(e));
      res.json({ remotes, kinds: REGISTERED_KINDS });
    } catch (e) { next(e); }
  });

  r.post('/remotes', async (req, res, next) => {
    try {
      const { remoteId, kind, label, config } = req.body ?? {};
      if (!isValidRemoteId(remoteId)) {
        return res.status(400).json({ error: `remoteId must match ^[a-z0-9][a-z0-9._-]{0,63}$ (got ${JSON.stringify(remoteId)})` });
      }
      if (!isKnownKind(kind) || !REGISTERED_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of ${REGISTERED_KINDS.join(', ')}` });
      }
      const existing = await readRemote(remoteId);
      if (existing.ok) return res.status(409).json({ error: `remote '${remoteId}' already exists` });

      // The kind owns its own config shape; the store never inspects it.
      const v = createTransport(kind).validateConfig(config);
      if (!v.ok) return res.status(400).json({ error: v.error });

      const record = makeRecord({ remoteId, kind, label, config: v.config, baseline: unknownBaseline() });
      await writeRemote(record);
      res.status(201).json({ remote: record });
    } catch (e) { next(e); }
  });

  // Everything except `remoteId`, which is NEVER renamed once created: it is
  // the whole hand-off contract to a cc project's Remote field
  // (.wiki/gotchas/no-remote-discovery.md).
  r.patch('/remotes/:id', async (req, res, next) => {
    try {
      const cur = await readRemote(req.params.id);
      if (!cur.ok) return res.status(cur.reason === 'absent' ? 404 : 409).json({ error: cur.message });
      const { label, config } = req.body ?? {};
      const record = cur.record;
      let nextConfig = record.config;
      let baseline = record.baseline;
      if (config !== undefined) {
        const v = createTransport(record.kind).validateConfig(config);
        if (!v.ok) return res.status(400).json({ error: v.error });
        nextConfig = v.config;
        // A changed config may point at a different target entirely, so the old
        // verdict is not about this remote any more.
        baseline = unknownBaseline();
      }
      const updated = makeRecord({
        remoteId: record.remoteId,
        kind: record.kind,
        label: label === undefined ? record.label : label,
        config: nextConfig,
        baseline,
        createdAt: record.createdAt,
      });
      await writeRemote(updated);
      res.json({ remote: updated });
    } catch (e) { next(e); }
  });

  r.delete('/remotes/:id', async (req, res, next) => {
    try {
      const id = req.params.id;
      // A remoteId is a hand-off contract to every project that names it, and
      // cc cannot enumerate remotes on its own — so deleting one silently
      // strands those projects.
      const referencing = await projectsNaming(id, deps.registration ?? {});
      const gone = await deleteRemote(id);
      if (!gone) return res.status(404).json({ error: `no remote '${id}'` });
      res.json({
        deleted: id,
        ...(referencing.length > 0
          ? { warning: `${referencing.length} cc project(s) still name remote '${id}': ${referencing.map(p => p.project).join(', ')}`, referencing }
          : {}),
      });
    } catch (e) { next(e); }
  });

  return r;
}
