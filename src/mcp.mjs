// The MCP surface: one read-only tool, `list_remotes`, over the same card
// composition the REST surface uses (src/cards.mjs).
//
// A HANDLER RETURNS THE 200 BODY VERBATIM rather than something this module
// wraps in `{result}`, because the conductor's bridge treats the two channels
// differently: `{text}` becomes raw, UNESCAPED text blocks, while `{result}` is
// JSON-stringified into one block — which would escape every newline of a
// rendering into a `\n`-littered wall (.wiki/gotchas/plugin-mcp-surface.md).

import { remoteCards } from './cards.mjs';
import { identityFieldFor } from './launcher/kinds/index.mjs';

const EMPTY = 'no remotes are registered';

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
  if (card.broken) return 'not readable';
  if (card.enabled !== true) return 'disabled';
  return card.reachability?.connected === true ? 'connected' : 'not connected';
}

// THE LABEL IS OPERATOR-SUPPLIED AND UNVALIDATED — `POST`/`PATCH` accept any
// string — so it is the one field that could break the one-line-per-remote
// contract this renderer owns. A label carrying a newline would emit a SECOND
// line indistinguishable from a genuine row, in output an agent parses.
//
// JSON string quoting is the whole answer: it supplies the surrounding quotes
// and escapes every C0 control character, the double quote and the backslash,
// in one rule a reader can state. The two line separators JSON leaves raw are
// escaped after it. Validating at the store's front door instead would change a
// REST contract AND leave every already-stored label dangerous.
function quotedLabel(label) {
  return JSON.stringify(String(label ?? ''))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
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
  return `${field}=${card.config?.[field] ?? ''}`;
}

/**
 * The listing: one line per remote, in store order, joined by `\n` with no
 * trailing newline. FIVE FIELDS AND NO MORE — status, remoteId, kind, the
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
    if (card.broken) return `${status}  ${card.remoteId}`;
    return [
      status,
      card.remoteId,
      card.kind,
      targetOf(card),
      quotedLabel(card.label),
    ].join('  ');
  }).join('\n');
}

const handlers = {
  // READ-ONLY, BOTH WAYS: `baseline: false` skips the one write `cardFor` makes,
  // and `reachability: 'gated'` means a gate-off remote's target is never
  // contacted at all.
  list_remotes: async () => ({
    text: renderRemotes(await remoteCards({ baseline: false, reachability: 'gated' })),
  }),
};

/**
 * Envelope-level problems (a missing or non-string `tool`) are the ONLY non-200.
 * Everything else is a 200 body: an unknown tool name and a handler's own
 * failure are normal MCP outcomes for the calling model, not transport
 * failures.
 *
 * `arguments` is ignored — `list_remotes` declares no properties, and the
 * conductor's `validateArgs` refuses unknown ones before forwarding. `caller`
 * is accepted and unused: nothing in the bridge scopes a plugin's tools.
 */
export async function handle(body) {
  const { tool, arguments: args } = body || {};
  if (typeof tool !== 'string' || tool.length === 0) {
    return { status: 400, body: { error: 'tool is required and must be a non-empty string' } };
  }
  // AN OWN PROPERTY, NOT AN INHERITED ONE. A plain object inherits
  // `toString`/`constructor`/`hasOwnProperty` from `Object.prototype`, and a
  // bare `handlers[tool]` would CALL one of those instead of refusing it —
  // answering `"[object Undefined]"`, `{}` or a TypeError's message, none of
  // them this contract's refusal. Same guard, same reason, as `isKnownKind`.
  if (!Object.hasOwn(handlers, tool)) return { status: 200, body: { error: `unknown tool: ${tool}` } };
  const fn = handlers[tool];
  try {
    return { status: 200, body: await fn(args ?? {}) };
  } catch (e) {
    return { status: 200, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}
