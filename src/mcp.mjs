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
    const field = identityFieldFor(card.kind);
    return [
      status,
      card.remoteId,
      card.kind,
      `${field}=${card.config?.[field] ?? ''}`,
      `"${card.label}"`,
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
  const fn = handlers[tool];
  if (!fn) return { status: 200, body: { error: `unknown tool: ${tool}` } };
  try {
    return { status: 200, body: await fn(args ?? {}) };
  } catch (e) {
    return { status: 200, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}
