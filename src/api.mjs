// The backend REST surface the card UI renders.
//
// A card carries TWO INDEPENDENT FACTS and this file is where both are
// answered:
//
//   the GATE  — `record.enabled`, what the operator SET. The only thing that
//               decides whether an operation runs. Moved by connect/disconnect.
//   the PROBE — `reachability`, what is TRUE right now. Re-asked on every GET,
//               never cached, never gated — which is how a switched-off card
//               still shows reality.
//
// They disagree routinely, and one word for two facts is exactly the confusion
// this surface must not create (.wiki/gotchas/gate-versus-probe.md).

import express from 'express';
import { refreshBaseline, unknownBaseline } from './baseline.mjs';
import { REGISTERED_KINDS, createTransport, isKnownKind, kindDescriptors } from './launcher/kinds/index.mjs';
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

export async function projectsNaming(remoteId, { conductorUrl = process.env.CONDUCTOR_URL, fetchImpl = globalThis.fetch } = {}) {
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

// Exported under a test-facing alias so the abort-signal wiring can be pinned
// without standing up a DELETE round trip.
export { projectsNaming as projectsNamingForTest };

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

  // The card UI's forms come from the KINDS themselves, so a field cannot drift
  // from what `validateConfig` accepts (tests/kindmeta.test.mjs).
  r.get('/kinds', (_req, res) => res.json({ kinds: kindDescriptors() }));

  r.get('/remotes', async (_req, res, next) => {
    try {
      const entries = await listRemotes();
      const remotes = [];
      for (const e of entries) remotes.push(await cardFor(e));
      res.json({ remotes, kinds: kindDescriptors() });
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

      // SWITCHED OFF ON CREATION. An ssh remote genuinely has no master until
      // `connect` runs, so a default-on gate would claim a state nobody
      // established — and the operator's next action is to connect it anyway.
      const record = makeRecord({
        remoteId, kind, label, config: v.config, enabled: false, baseline: unknownBaseline(),
      });
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
      // CARRIED THROUGH EXPLICITLY. makeRecord rebuilds the record from a field
      // list, so a field left off here is silently dropped — which for the gate
      // would mean every rename switched the remote off.
      let enabled = record.enabled;
      if (config !== undefined) {
        const v = createTransport(record.kind).validateConfig(config);
        if (!v.ok) return res.status(400).json({ error: v.error });
        nextConfig = v.config;
        // A changed config may point at a different target entirely, so the old
        // verdict is not about this remote any more — and neither is the gate.
        // For ssh this is not merely cautious: `controlPathFor` keys on
        // (user, host), so editing `host` yields a DIFFERENT socket, the old
        // master is irrelevant, and a carried-over "enabled" would be stale.
        baseline = unknownBaseline();
        enabled = false;
      }
      const updated = makeRecord({
        remoteId: record.remoteId,
        kind: record.kind,
        label: label === undefined ? record.label : label,
        config: nextConfig,
        enabled,
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

  // ── THE OPERATOR GATE ──────────────────────────────────────────────
  //
  // THE TWO ROUTES ARE DELIBERATELY ASYMMETRIC, because enabling and disabling
  // carry different risks. Enabling claims a capability, so it is proven first
  // and written second; disabling withdraws permission, so it is written first
  // and must not be blockable by a transport that cannot tidy up.

  // Shared preamble: read the record, or answer the same way PATCH does.
  const forGate = async (req, res) => {
    const cur = await readRemote(req.params.id);
    if (!cur.ok) {
      res.status(cur.reason === 'absent' ? 404 : 409).json({ error: cur.message });
      return null;
    }
    return cur.record;
  };

  r.post('/remotes/:id/connect', async (req, res, next) => {
    try {
      const record = await forGate(req, res);
      if (!record) return;
      const transport = createTransport(record.kind);

      // THE KIND'S SEAM FIRST, THE GATE SECOND. On a throw the gate stays OFF:
      // "enabled" must never mean "enabled but we could not". For `ssh` this
      // opens the ControlMaster and proves it; for `docker` it is a documented
      // no-op pass, because every `docker exec` is a fresh client.
      try { await transport.connect(record.config ?? {}); }
      catch (e) {
        return res.status(502).json({
          error: e instanceof Error ? e.message : String(e),
          // The card comes back too, so the UI can show the failure AGAINST the
          // card rather than as a detached alert.
          remote: await cardFor({ ok: true, record }),
        });
      }

      const updated = { ...record, enabled: true, updatedAt: new Date().toISOString() };
      await writeRemote(updated);
      // A REAL RE-PROBE, not a claim: a successful ssh connect changes the
      // control socket's inode, which moves the fingerprint, which re-probes the
      // baseline — all inside this response.
      res.json({ remote: await cardFor({ ok: true, record: updated }) });
    } catch (e) { next(e); }
  });

  r.post('/remotes/:id/disconnect', async (req, res, next) => {
    try {
      const record = await forGate(req, res);
      if (!record) return;

      // THE GATE FIRST. Disabling is a safety action — the operator is
      // withdrawing permission — so a transport that cannot close its channel
      // is a WARNING on an otherwise-successful disable, never a failure that
      // leaves the remote enabled.
      const updated = { ...record, enabled: false, updatedAt: new Date().toISOString() };
      await writeRemote(updated);

      let warning;
      try { await createTransport(record.kind).disconnect(record.config ?? {}); }
      catch (e) { warning = e instanceof Error ? e.message : String(e); }

      res.json({
        remote: await cardFor({ ok: true, record: updated }),
        ...(warning ? { warning } : {}),
      });
    } catch (e) { next(e); }
  });

  // THE ROUTER TAIL. Without it express answers its own HTML error page, and
  // the client's `api()` — which reads `{error}` off every response — throws a
  // JSON parse error and shows the user nothing about what went wrong. It
  // catches express's own body-parser refusals (malformed JSON, a body past the
  // 256kb limit) as well as anything `next(e)` hands it.
  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    const status = Number(err?.status ?? err?.statusCode) || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return r;
}
