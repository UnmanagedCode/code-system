// The MCP surface: one read-only tool, `list_remotes`, over the same card
// composition the REST surface uses (src/cards.mjs), in TWO VIEWS chosen by the
// request's `format`:
//
//   text — one line per remote, a five-field SUMMARY (`renderRemotes`);
//   json — every remote's public record as `{structured}`, validated by cc
//          against the manifest's `outputSchema` (`remoteJson`).
//
// A HANDLER RETURNS THE 200 BODY VERBATIM rather than something this module
// wraps in `{result}`, because the conductor's bridge treats the channels
// differently: `{text}` becomes raw, UNESCAPED text blocks, while `{result}` is
// JSON-stringified into one block — which would escape every newline of a
// rendering into a `\n`-littered wall (.wiki/gotchas/plugin-mcp-surface.md).
// `{structured}` is the typed channel and carries no text at all.
//
// EVERY VIEW READS CONFIG ONLY THROUGH `exposedConfig`, so the credential fields
// the kind marks (`secret`, `credential`) reach neither view.

import { cardFor } from './cards.mjs';
import { exposedConfig, identityFieldFor, withheldFieldsFor } from './launcher/kinds/index.mjs';
import { listRemotes } from './store.mjs';

const EMPTY = 'no remotes are registered';

// The status words, owned here; the manifest's `outputSchema` enum is pinned to
// these by a test. READABLE_STATUSES is ordered connected, not connected, disabled.
export const READABLE_STATUSES = ['connected', 'not connected', 'disabled'];
export const NOT_READABLE = 'not readable';

// What the target field says for a record whose kind has no card. Bracketed so
// it cannot be read as a `<field>=<value>` pair — there is no field to name, and
// fabricating one would be worse than saying so.
const NO_TARGET = '[unregistered kind]';

// ONE WORD FOR A REMOTE'S TWO STATES, and the GATE WINS. A gate-off remote
// refuses every command whatever its target is doing, so reporting a probe of
// that target would describe something the caller cannot use — and the word
// borrows no form of "connect", which is reserved for the probe
// (.wiki/gotchas/gate-versus-probe.md).
function statusOf(card) {
  if (card.broken) return NOT_READABLE;
  if (card.enabled !== true) return READABLE_STATUSES[2];
  return card.reachability?.connected === true ? READABLE_STATUSES[0] : READABLE_STATUSES[1];
}

// ONE LINE PER REMOTE, AND THE RULE THAT KEEPS IT TRUE.
//
// EVERY field below is interpolated from data an operator supplies, and none
// of it is checked for this: `label` is accepted verbatim by `POST`/`PATCH`;
// `operand()` trims a config value and refuses a leading `-` and nothing else;
// and a record read off disk has its `kind` re-validated nowhere, while the
// broken branch's `remoteId` is a FILENAME STEM the charset check already
// refused. Any of them carrying a line break would emit a SECOND row — with an
// attacker-chosen status, remoteId, kind and target — that a reader splitting
// on a newline cannot tell from a genuine one.
//
// SO THE RULE IS APPLIED TO THE FIELDS AS A CLASS, and the class is escaped as
// a class: the backslash first, so the result is unambiguous, then everything
// Unicode treats as a control or a line boundary — C0 (CR and LF among them),
// DEL, C1 (which includes U+0085 NEL, a mandatory break under UAX #14), and the
// U+2028 / U+2029 separators.
//
// NOT VALIDATION AT THE STORE'S FRONT DOOR: that would change a REST contract,
// and would still leave every already-stored record dangerous.
const SHORT = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const UNSAFE = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function lineSafe(value) {
  return String(value ?? '').replace(UNSAFE, (ch) =>
    SHORT[ch] ?? `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
}

// The label is the one field that carries quotes, so a reader can find where
// free-form text ends — which means the double quote inside it is escaped too.
function quotedLabel(label) {
  return `"${lineSafe(label).replace(/"/g, '\\"')}"`;
}

// The kind's identifying target, or NO_TARGET for a kind that has none.
//
// `identityFieldFor` THROWS for such a kind, deliberately, and this is the one
// caller that must degrade instead: a record whose kind was never registered is
// reachable — the store's front door refuses one, but a hand-written or
// hand-migrated record file does not pass through it — and letting the throw
// reach `handle` would turn ONE of them into an error body carrying zero
// remotes. The refusal is not swallowed; it is what the line reports.
function targetOf(card) {
  let field;
  try { field = identityFieldFor(card.kind); }
  catch { return NO_TARGET; }
  return `${field}=${lineSafe(exposedConfig(card.kind, card.config).config[field])}`;
}

/**
 * The listing: one line per remote, in store order, joined by `\n` with no
 * trailing newline. FIVE FIELDS AND NO MORE IN THIS VIEW (the json view carries
 * the rest) — status, remoteId, kind, the
 * kind's identifying target, and the label — separated by two spaces.
 *
 * `kind` is the raw token (`docker`/`ssh`), not `KIND_META.label`: it is what
 * `POST /api/remotes` accepts and what a reader needs. (The card UI's badge
 * shows the human label instead.)
 *
 * @param {object[]} cards what `remoteCards` returns
 */
export function renderRemotes(cards) {
  if (cards.length === 0) return EMPTY;
  return cards.map((card) => {
    const status = statusOf(card);
    // A record that did not parse yields its remoteId and nothing else: no
    // other field of it is known.
    if (card.broken) return `${status}  ${lineSafe(card.remoteId)}`;
    return [
      status,
      lineSafe(card.remoteId),
      lineSafe(card.kind),
      targetOf(card),
      quotedLabel(card.label),
    ].join('  ');
  }).join('\n');
}


// A coded refusal: becomes `{error, code, details?}` in a 200 body.
class Refusal extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const FORMATS = ['text', 'json'];

// Every stored entry with its card, read-only both ways: `baseline: false`
// skips the one write `cardFor` makes, and `reachability: 'gated'` never
// contacts a gate-off remote's target. The raw entry is kept for the probe
// detail's scrub.
async function listing() {
  let entries;
  try { entries = await listRemotes(); }
  catch (e) {
    throw new Refusal('STORE_UNREADABLE', e instanceof Error ? e.message : String(e),
      typeof e?.code === 'string' ? { errno: e.code } : undefined);
  }
  const pairs = [];
  for (const entry of entries) {
    pairs.push({ entry, card: await cardFor(entry, { baseline: false, reachability: 'gated' }) });
  }
  return pairs;
}

const REDACTED = '[withheld]';

// ssh echoes the `-i` key path in `-O check` stderr (`Identity file <path> not
// accessible`) and the probe copies that line into `detail`, so every stored
// value of a withheld field is replaced — longest first, no regex.
function scrubber(record) {
  const config = record.config && typeof record.config === 'object' ? record.config : {};
  const values = withheldFieldsFor(record.kind)
    .map(name => (Object.hasOwn(config, name) ? config[name] : undefined))
    .filter(v => typeof v === 'string' && v.length > 0)
    .sort((a, b) => b.length - a.length);
  return text => values.reduce((out, v) => out.split(v).join(REDACTED), text);
}

// One remote's json: every key present, an absent stored value `null`.
function remoteJson({ entry, card }) {
  if (card.broken) {
    return {
      status: NOT_READABLE,
      remoteId: String(card.remoteId),
      reason: String(card.broken.reason),
      message: String(card.broken.message),
    };
  }
  const rec = entry.record;
  const { config, withheld } = exposedConfig(rec.kind, rec.config);
  let target = null;
  try {
    const field = identityFieldFor(rec.kind);
    target = { field, value: config[field] ?? null };
  } catch { /* a kind with no identifying field has no target */ }
  const reach = card.reachability;
  return {
    status: statusOf(card),
    remoteId: card.remoteId,
    kind: rec.kind ?? null,
    label: rec.label ?? null,
    target,
    enabled: rec.enabled === true,
    reachability: reach ? {
      connected: reach.connected === true,
      detail: scrubber(rec)(String(reach.detail ?? '')),
      fingerprint: typeof reach.fingerprint === 'string' ? reach.fingerprint : null,
    } : null,
    config,
    withheld,
    mirror: rec.mirror ?? null,
    baseline: rec.baseline ?? null,
    createdAt: rec.createdAt ?? null,
    updatedAt: rec.updatedAt ?? null,
  };
}

// Per tool: how to load, and one builder per format — only the requested one runs.
const handlers = {
  list_remotes: {
    load: listing,
    json: pairs => ({ remotes: pairs.map(remoteJson) }),
    text: pairs => renderRemotes(pairs.map(p => p.card)),
  },
};

/**
 * Envelope-level problems (a missing or non-string `tool`) are the ONLY non-200.
 * Everything else is a 200 body: a refusal is `{error, code, details?}`, a
 * normal MCP outcome for the calling model, not a transport failure. Codes:
 * BAD_ENVELOPE (400), FORMAT_UNKNOWN, TOOL_UNKNOWN, STORE_UNREADABLE,
 * INTERNAL_ERROR.
 *
 * `format` absent means text, so a caller that predates the field keeps
 * working. `arguments` is ignored — `list_remotes` declares no properties, and
 * the conductor's `validateArgs` refuses unknown ones before forwarding.
 * `caller` is accepted and unused: nothing in the bridge scopes a plugin's tools.
 */
export async function handle(body) {
  const { tool, format } = body || {};
  if (typeof tool !== 'string' || tool.length === 0) {
    return { status: 400, body: { error: 'tool is required and must be a non-empty string', code: 'BAD_ENVELOPE' } };
  }
  const refuse = (code, error, details) => ({ status: 200, body: { error, code, ...(details ? { details } : {}) } });
  if (format !== undefined && !FORMATS.includes(format)) {
    return refuse('FORMAT_UNKNOWN', 'format must be "text" or "json"', { format, accepted: FORMATS });
  }
  // AN OWN PROPERTY, NOT AN INHERITED ONE. A plain object inherits
  // `toString`/`constructor`/`hasOwnProperty` from `Object.prototype`, and a
  // bare `handlers[tool]` would CALL one of those instead of refusing it.
  // Same guard, same reason, as `isKnownKind`.
  if (!Object.hasOwn(handlers, tool)) return refuse('TOOL_UNKNOWN', `unknown tool: ${tool}`);
  const handler = handlers[tool];
  const view = format ?? 'text';
  try {
    const loaded = await handler.load();
    const built = handler[view](loaded);
    return { status: 200, body: view === 'json' ? { structured: built } : { text: built } };
  } catch (e) {
    if (e instanceof Refusal) return refuse(e.code, e.message, e.details);
    // Defensive: nothing on today's path throws past `cardFor` and `listing`.
    return refuse('INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
  }
}
