// THE CARD'S DECISIONS, with no DOM in them.
//
// A card carries TWO INDEPENDENT FACTS, and they disagree routinely:
//
//   the GATE  — `remote.enabled`. What the operator SET. The only thing that
//               decides whether an operation runs. The toggle tracks THIS, and
//               nothing else: a control whose position is not what the operator
//               set is a broken control.
//   the PROBE — `remote.reachability`. What is TRUE right now, re-asked on
//               every GET, never cached and never gated. It drives a separate
//               dot and status line.
//
// One word for two facts is exactly the confusion this file exists to prevent
// (.wiki/gotchas/gate-versus-probe.md).
//
// EVERYTHING HERE IS PURE, so app.js can stay a thin DOM wiring and every
// invariant above is testable with `node --test` and no browser
// (tests/cardstate.test.mjs). This is code-hub's public/shareState.js pattern.

// Mirrors src/store.mjs's REMOTE_ID_RE. Only used to reject a route parameter
// that could never name a remote, so a deep link cannot open an edit form on
// nothing.
const REMOTE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ── the gate ─────────────────────────────────────────────────────────

/** @returns {{enabled:boolean, word:'Enabled'|'Disabled'}} */
export function gateStatus(remote) {
  const enabled = remote?.enabled === true;
  return { enabled, word: enabled ? 'Enabled' : 'Disabled' };
}

// THE ONE SENTENCE EVERY KIND SHOWS, and the one that must be right: a disabled
// remote is not failing, it is never reached.
export const GATE_SHARED_COPY =
  'Disabled means no command runs against this remote. code-system refuses them itself,'
  + ' so the target is not contacted at all.';

// Per kind, and the SINGLE HOME for every per-kind sentence on a card.
// tests/cardstate.test.mjs asserts there is exactly one entry per kind the
// backend actually serves, so a new kind cannot ship a wordless card and a
// removed one cannot leave dead text behind.
export const GATE_COPY = {
  docker:
    'Enabling touches nothing on the host: code-system attaches to a container that is already'
    + ' running, and never starts or stops one.',
  ssh:
    'Enabling also opens one authenticated SSH connection for commands to share. Disabling closes'
    + ' it and stops commands — the gate is what stops them, not the connection.',
};

// ── the probe ────────────────────────────────────────────────────────

// Short words for the status line, per kind. The DETAIL beside them is always
// the transport's own text, never a paraphrase: for ssh it names the
// ControlPath, for docker the image and start time, and those are what an
// operator acts on.
const PROBE_WORDS = {
  docker: { ok: 'running', down: 'container not running' },
  ssh: { ok: 'shared connection up', down: 'shared connection down' },
};
const PROBE_WORDS_DEFAULT = { ok: 'reachable', down: 'not reachable' };

/** @returns {{level:'ok'|'down'|'unknown', word:string, detail:string}} */
export function probeStatus(remote) {
  // A record the store could not read was never probed. Saying "down" would
  // name a cause nobody measured.
  if (remote?.broken) return { level: 'unknown', word: 'not readable', detail: '' };
  const reach = remote?.reachability;
  if (!reach) return { level: 'unknown', word: 'unknown', detail: '' };
  const words = PROBE_WORDS[remote.kind] ?? PROBE_WORDS_DEFAULT;
  const level = reach.connected === true ? 'ok' : 'down';
  return { level, word: words[level], detail: String(reach.detail ?? '') };
}

// ── where the two disagree ───────────────────────────────────────────

// Per kind, for the ONE row that needs an explanation: the gate is on and the
// probe says no. Each says what is actually lost — and for docker, what
// code-system will not do about it.
const DISAGREEMENT = {
  docker:
    'The container is not running. code-system is attach-only and never starts one:'
    + ' start it yourself and it will show here on the next refresh.',
  ssh:
    'The shared SSH connection is down. Commands still run — each one just pays its own'
    + ' authentication. Connect again to restore multiplexing.',
};

/**
 * The disagreement rows, and only those. An alert on every card is an alert on
 * none, so a card whose gate and probe agree raises nothing.
 * @returns {null|{level:'warn'|'err', text:string}}
 */
export function cardAlert(remote) {
  // A store refusal reaches the user UNMODIFIED: it already names what it found
  // and the repair, and a broken record is the case where the user has least
  // other information.
  if (remote?.broken) return { level: 'err', text: String(remote.broken.message ?? '') };

  const { enabled } = gateStatus(remote);
  const probe = probeStatus(remote);

  // GATE ON, PROBE DOWN. A WARNING, never an error, on both kinds — for docker
  // the remote genuinely cannot serve until someone starts the container, but
  // that someone is not us; for ssh the remote WORKS, and only its multiplexing
  // is gone. Calling either an error sends the operator to debug a fault that
  // is not there.
  if (enabled && probe.level === 'down') {
    return { level: 'warn', text: DISAGREEMENT[remote.kind] ?? `The target is not reachable: ${probe.detail}` };
  }

  // GATE OFF, PROBE UP is not a disagreement worth an alert: the probe line
  // already says the target is up, the gate word already says Disabled, and the
  // shared copy already says what Disabled means.
  return null;
}

/**
 * The tooling-baseline verdict, expanded rather than summarised. The target's
 * own error text is the only actionable part — busybox's
 * `find: unrecognized: -printf` is what tells an operator which image to change
 * — so every missing capability gets its own line carrying all three fields.
 * @returns {null|{level:'err', title:string, lines:string[]}}
 */
export function baselineNotice(remote) {
  const b = remote?.baseline;
  // `unknown` says nothing: absence of evidence is not evidence, and the
  // launcher SERVES an unprobed remote for exactly that reason.
  if (!b || b.state !== 'unsupported') return null;
  const missing = Array.isArray(b.missing) ? b.missing : [];
  return {
    level: 'err',
    title: 'This target is missing tooling cc\'s derived operations need, so it is refused whole:',
    lines: missing.map(m => `${m.capability} — ${m.probe}: ${m.detail}`),
  };
}

// ── routing ──────────────────────────────────────────────────────────
//
// QUERY STRING ONLY, never a path segment. cc's proxy guarantees a trailing
// slash by 301, but relative URLs resolve wrongly under a no-trailing-slash
// deep link; keeping the path constant makes that hazard unreachable.

/** @returns {{view:'list'}|{view:'add'}|{view:'edit',remoteId:string}} */
export function routeFromSearch(search) {
  const params = new URLSearchParams(String(search ?? ''));
  if (params.has('add')) return { view: 'add' };
  const id = params.get('edit');
  if (id && REMOTE_ID_RE.test(id)) return { view: 'edit', remoteId: id };
  return { view: 'list' };
}

export function searchForRoute(route) {
  if (route?.view === 'add') return '?add';
  if (route?.view === 'edit') return `?edit=${encodeURIComponent(route.remoteId)}`;
  return '';
}
