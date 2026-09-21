// One remote's CARD VIEW — composed once, for every surface that shows a
// remote.
//
// A card carries TWO INDEPENDENT FACTS and this is where both are answered:
//
//   the GATE  — `record.enabled`, what the operator SET. The only thing that
//               decides whether an operation runs. Moved by connect/disconnect.
//   the PROBE — `reachability`, what is TRUE right now. Never cached, never
//               gated — which is how a switched-off card still shows reality.
//
// They disagree routinely, and one word for two facts is exactly the confusion
// a surface built on this must not create (.wiki/gotchas/gate-versus-probe.md).

import { refreshBaseline } from './baseline.mjs';
import { createTransport } from './launcher/kinds/index.mjs';
import { listRemotes, writeRemote } from './store.mjs';

/**
 * @param {{ok:boolean, record?:object, remoteId?:string, reason?:string, message?:string}} entry
 *   A `listRemotes`/`readRemote` entry. A `!ok` one becomes
 *   `{remoteId, broken:{reason,message}}` — surfaced, never hidden.
 * @param {{baseline?:boolean, reachability?:'always'|'gated'}} opts
 *   `baseline: false` skips the tooling probe and, with it, THE ONLY WRITE on
 *   this path — a moved verdict is what `cardFor` persists.
 *   `reachability: 'gated'` probes only a remote whose gate is on and leaves
 *   the key ABSENT otherwise, rather than fabricating a value the caller drops.
 *   `'always'` probes every remote, which is how a switched-off card still
 *   shows reality.
 */
export async function cardFor(entry, { baseline = true, reachability = 'always' } = {}) {
  if (!entry.ok) {
    return {
      remoteId: entry.remoteId,
      broken: { reason: entry.reason, message: entry.message },
    };
  }
  const record = entry.record;
  // THE GATE WINS, AND IT WINS BEFORE ANY I/O: no transport is built, so no
  // `docker inspect` and no `ssh -O check` runs for a remote the caller has
  // said it will not report a probe for.
  if (reachability === 'gated' && record.enabled !== true) return { ...record };

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
  const { record: out, probed } = baseline
    ? await refreshBaseline(transport, record, reach)
    : { record, probed: false };
  if (probed) await writeRemote(out);
  return { ...out, reachability: reach };
}

// Every stored remote as a card, in the store's own order.
export async function remoteCards(opts = {}) {
  const cards = [];
  for (const entry of await listRemotes()) cards.push(await cardFor(entry, opts));
  return cards;
}
