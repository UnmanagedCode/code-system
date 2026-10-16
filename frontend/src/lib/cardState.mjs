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
// EVERYTHING HERE IS PURE, so the React components (frontend/src/components/,
// App.tsx) stay thin wiring and every invariant above is testable with
// `node --test` and no browser (tests/cardstate.test.mjs). Plain JS with JSDoc
// rather than TypeScript for that reason: the components import it through
// `allowJs`, and node runs it as it is.

// Mirrors src/store.mjs's REMOTE_ID_RE. Only used to reject a route parameter
// that could never name a remote, so it is read as the list.
const REMOTE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// EVERY TABLE LOOKUP KEYED BY A STORED-RECORD FIELD IS AN OWN-PROPERTY LOOKUP.
// A record's `kind` is whatever its file says, and a plain object inherits
// `constructor`, `__proto__`, `toString` and the rest: `PROBE_WORDS.constructor`
// is a function, not a word table.
/**
 * @template T
 * @param {Record<string, T>} table
 * @param {unknown} key
 * @returns {T|undefined}
 */
export const own = (table, key) => (Object.hasOwn(table, /** @type {PropertyKey} */ (key)) ? table[/** @type {string} */ (key)] : undefined);

// ── the gate ─────────────────────────────────────────────────────────

/** @returns {{enabled:boolean, word:'Enabled'|'Disabled'}} */
export function gateStatus(remote) {
  const enabled = remote?.enabled === true;
  return { enabled, word: enabled ? 'Enabled' : 'Disabled' };
}

// Per kind, and the SINGLE HOME for every per-kind sentence on a card. An
// entry is optional — a kind with nothing worth saying has none — but
// tests/cardstate.test.mjs asserts every entry present names a kind the
// backend actually serves, so a removed kind cannot leave dead text behind.
export const GATE_COPY = {
  ssh:
    'Enabling also opens one authenticated SSH connection for commands to share. Disabling closes'
    + ' it and stops commands — the gate is what stops them, not the connection.',
};

/** The kind's gate sentence, or null for a kind with none (an own entry only). */
export function gateCopy(kind) {
  return own(GATE_COPY, kind) ?? null;
}

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
  const words = own(PROBE_WORDS, remote.kind) ?? PROBE_WORDS_DEFAULT;
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
    return { level: 'warn', text: own(DISAGREEMENT, remote.kind) ?? `The target is not reachable: ${probe.detail}` };
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

// ── the mirror advertisement ─────────────────────────────────────────
//
// The form holds `{on, root, exclude}` where `exclude` is the RAW TEXTAREA TEXT;
// the wire holds `null` or `{root, exclude:[…]}`. Two shapes, deliberately: the
// operator is editing lines of text, and turning that into the wire shape is a
// decision (what counts as an entry, what a trailing newline means) rather than
// a rendering. So it lives here, pure and tested.

/**
 * @param {{on:boolean, root:string, exclude:string}|null|undefined} formMirror
 * @returns {undefined|null|{root:string, exclude:string[]}}
 */
export function mirrorPayload(formMirror) {
  // NO FORM OBJECT IS `undefined`: no mirror group was rendered, so the operator
  // made no choice. `JSON.stringify` drops the key, so a POST takes the backend's
  // kind default and a PATCH keeps what is stored.
  if (!formMirror) return undefined;
  // UNTICKED IS `null`, whatever else the form holds. A half-typed root behind a
  // closed checkbox is not an advertisement.
  if (!formMirror.on) return null;
  // NEWLINE-SEPARATED ONLY. A path may legally contain a comma or a space, so
  // splitting on either would silently cut one in half.
  const exclude = String(formMirror.exclude ?? '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
  return { root: String(formMirror.root ?? '').trim(), exclude };
}

/**
 * The `config` a form submits. An empty field is OMITTED, never sent as `''`.
 * A secret is NEVER TRIMMED (its edge spaces are part of it), and a stored
 * secret the operator ticked "clear" on goes as `null` — the backend's rule is
 * omitted keeps, `null` clears.
 * @param {Record<string,unknown>} draftConfig
 * @param {Record<string,boolean>|undefined} clears
 * @param {string[]} secretNames
 */
export function configPayload(draftConfig, clears, secretNames) {
  const out = {};
  for (const [name, v] of Object.entries(draftConfig ?? {})) {
    const text = String(v ?? '');
    const blank = secretNames.includes(name) ? text === '' : text.trim() === '';
    if (!blank) out[name] = v;
  }
  for (const name of secretNames) {
    if (clears?.[name] && out[name] === undefined) out[name] = null;
  }
  return out;
}

/**
 * The card badge for an opted-in remote. The ROOT only: the exclude count is not
 * what an operator scans a card for, and the form is one click away.
 * @returns {null|string}
 */
export function mirrorSummary(remote) {
  const m = remote?.mirror;
  if (!m || typeof m !== 'object' || typeof m.root !== 'string') return null;
  return `mirror ${m.root}`;
}

/**
 * The Advanced group's summary line: its title plus the mirror state, so the
 * state can be read without opening the group. Shares `mirrorPayload` and
 * `mirrorSummary` with the card badge, so both speak one vocabulary.
 * @param {{on:boolean, root:string, exclude:string}|null|undefined} formMirror
 */
export function advancedSummary(formMirror) {
  const payload = mirrorPayload(formMirror);
  if (payload === undefined) return 'Advanced';
  if (payload === null) return 'Advanced · no mirror';
  return `Advanced · ${payload.root === '' ? 'mirror (no root)' : mirrorSummary({ mirror: payload })}`;
}

/**
 * Whether the edit form opens its Advanced group: an advanced config field holds
 * a stored value, or the stored mirror is a custom one. A default or absent
 * mirror stays collapsed — the summary line already states it.
 * @param {{config?:Record<string,unknown>, storedSecrets?:string[], mirror?:unknown}} remote
 * @param {{name:string, advanced?:boolean}[]} configFields
 * @param {{root:string, exclude:string[]}|null|undefined} mirrorDefaults
 */
export function advancedOpenOnEdit(remote, configFields, mirrorDefaults) {
  const stored = (name) => {
    const v = remote?.config?.[name];
    return (v !== undefined && v !== null && v !== '') || (remote?.storedSecrets ?? []).includes(name);
  };
  if ((configFields ?? []).some(f => f.advanced === true && stored(f.name))) return true;
  const m = remote?.mirror;
  if (!mirrorDefaults || !m || typeof m !== 'object') return false;
  const same = m.root === mirrorDefaults.root
    && Array.isArray(m.exclude) && Array.isArray(mirrorDefaults.exclude)
    && m.exclude.length === mirrorDefaults.exclude.length
    && m.exclude.every((x, i) => x === mirrorDefaults.exclude[i]);
  return !same;
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

// ── busy keys ────────────────────────────────────────────────────────
//
// The busy set is keyed by remoteId. The create form and the registration
// retry have no remoteId, so each gets a key with a leading space, which the
// remoteId charset (it starts at [a-z0-9]) can never produce.
export const NEW_KEY = ' new';
export const REG_KEY = ' registration';

// ── the form drafts ──────────────────────────────────────────────────

/**
 * The FORM's mirror state, which is not the wire shape: `exclude` is the raw
 * textarea text, and `mirrorPayload` is what turns it back. An opted-out remote
 * still gets the served defaults, so ticking the box offers them rather than an
 * empty form.
 *
 * The box starts ticked for a NEW remote (`remote == null`) of a kind whose
 * descriptor sets `mirrorByDefault`. An existing remote shows what is stored: a
 * stored `null` is unticked whatever the kind, because the default applies at
 * registration only.
 * @param {{mirror?:unknown}|null} remote
 * @param {{mirrorByDefault?:boolean}|null|undefined} descriptor
 * @param {{root:string, exclude:string[]}|null|undefined} mirrorDefaults
 * @returns {null|{on:boolean, root:string, exclude:string}}
 */
export function mirrorDraft(remote, descriptor, mirrorDefaults) {
  // No defaults yet ⇒ no group to draft for. `mirrorPayload(null)` is
  // `undefined`, so a form submitted in this state omits `mirror`: a POST takes
  // the backend's kind default and a PATCH keeps what is stored. DELIBERATELY
  // WITHOUT A LOCAL FALLBACK: a second copy of the default exclude list here is
  // exactly the drift the backend's single source exists to prevent.
  const d = mirrorDefaults;
  if (!d) return null;
  const m = remote?.mirror;
  if (m && typeof m === 'object') {
    // GUARDED LIKE `mirrorSummary`: only the backend writes this field, but a
    // hand-edited record can hold anything, and `"x".join` is a TypeError that
    // would blank the whole card list rather than one form.
    const stored = /** @type {{root?:unknown, exclude?:unknown}} */ (m);
    return {
      on: true,
      root: String(stored.root ?? ''),
      exclude: Array.isArray(stored.exclude) ? stored.exclude.join('\n') : '',
    };
  }
  return {
    on: remote == null && descriptor?.mirrorByDefault === true,
    root: String(d.root ?? '/'),
    exclude: (d.exclude ?? []).join('\n'),
  };
}

/**
 * The Add draft: the FIRST SERVED kind, never a hardcoded one, with that kind's
 * mirror default. Advanced is collapsed on create, whatever the mirror.
 * @param {{kind:string, mirrorByDefault?:boolean}[]} kinds
 * @param {{root:string, exclude:string[]}|null|undefined} mirrorDefaults
 */
export function createDraft(kinds, mirrorDefaults) {
  const descriptor = kinds?.[0] ?? null;
  return {
    remoteId: '',
    kind: descriptor?.kind ?? 'docker',
    label: '',
    config: {},
    mirror: mirrorDraft(null, descriptor, mirrorDefaults),
    advancedOpen: false,
  };
}

/**
 * The Edit draft, from the stored record. A SECRET is never prefilled: its name
 * is dropped from `config`, so the form shows it blank and `configPayload` never
 * re-sends a value the operator did not type. `storedSecrets` is what tells the
 * form one is kept.
 * @param {{remoteId:string, kind:string, label?:string, config?:Record<string,unknown>, storedSecrets?:string[], mirror?:unknown}} remote
 * @param {{configFields?:{name:string, secret?:boolean, advanced?:boolean}[], mirrorByDefault?:boolean}|null|undefined} descriptor
 * @param {{root:string, exclude:string[]}|null|undefined} mirrorDefaults
 */
export function editDraft(remote, descriptor, mirrorDefaults) {
  const fields = descriptor?.configFields ?? [];
  /** @type {Record<string,unknown>} */
  const config = { ...remote.config };
  for (const f of fields) if (f.secret === true) delete config[f.name];
  return {
    remoteId: remote.remoteId,
    kind: remote.kind,
    label: remote.label ?? '',
    config,
    storedSecrets: [...(remote.storedSecrets ?? [])],
    clear: {},
    mirror: mirrorDraft(remote, descriptor, mirrorDefaults),
    advancedOpen: advancedOpenOnEdit(remote, fields, mirrorDefaults),
  };
}

/**
 * The create form's Kind switch: the config is the old kind's, so it goes, and
 * the mirror is re-derived from the NEW kind's own default.
 * @template {{kind:string}} D
 * @param {D} draft
 * @param {{kind:string, mirrorByDefault?:boolean}} descriptor
 * @param {{root:string, exclude:string[]}|null|undefined} mirrorDefaults
 * @returns {D}
 */
export function switchKind(draft, descriptor, mirrorDefaults) {
  return { ...draft, kind: descriptor.kind, config: {}, mirror: mirrorDraft(null, descriptor, mirrorDefaults) };
}

/**
 * A config field's label: optional fields say so rather than being hidden.
 * @param {{label:string, required?:boolean}} field
 */
export function fieldLabel(field) {
  return `${field.label}${field.required ? '' : ' (optional)'}`;
}

// ── the identity stripe ──────────────────────────────────────────────
//
// A card keeps the same stripe across refreshes, so it is recognisable at a
// glance. The id picks ONE OF A FIXED SET of class names and never appears in
// the output: a remoteId is operator-typed, and nothing typed may become a
// class, a `style` or any other attribute (plugin-ui.md Part 2).

export const STRIPE_COUNT = 8;

function hueFor(id) {
  const s = String(id ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** @returns {string} one of `stripe-0` … `stripe-${STRIPE_COUNT - 1}` */
export function stripeClass(id) {
  return `stripe-${hueFor(id) % STRIPE_COUNT}`;
}

// ── the requests ─────────────────────────────────────────────────────

/**
 * A remote's own API path. RELATIVE, never `/`-led: the page is served under a
 * prefix it does not know, and a leading slash would reach cc's API instead.
 * @param {string} id
 * @param {'connect'|'disconnect'} [action]
 */
export function remotePath(id, action) {
  return `api/remotes/${encodeURIComponent(id)}${action ? `/${action}` : ''}`;
}

/**
 * The request a form's Create or Save sends. An empty optional field is
 * OMITTED rather than sent as '' (`configPayload`); an undefined mirror omits
 * its key, so a POST takes the backend's kind default and a PATCH keeps what is
 * stored.
 *
 * The edit body is SENT WHENEVER THE FORM SAVES, `config` and `mirror` both:
 * the form has no dirty-tracking. Safe because the backend's `sameConfig`
 * compares values and keeps `mirror` outside it, so re-sending an unchanged
 * record cannot reset the gate. The label goes untrimmed on edit, as typed.
 * @param {'create'|'edit'} mode
 * @param {{remoteId:string, kind:string, label:string, config:Record<string,unknown>, clear?:Record<string,boolean>, mirror:{on:boolean, root:string, exclude:string}|null}} draft
 * @param {{configFields?:{name:string, secret?:boolean}[]}|null|undefined} descriptor
 * @returns {{method:'POST'|'PATCH', path:string, body:Record<string,unknown>}}
 */
export function submitRequest(mode, draft, descriptor) {
  const secretNames = (descriptor?.configFields ?? []).filter(f => f.secret === true).map(f => f.name);
  const config = configPayload(draft.config, draft.clear, secretNames);
  const mirror = mirrorPayload(draft.mirror);
  if (mode === 'create') {
    const label = draft.label.trim();
    return {
      method: 'POST',
      path: 'api/remotes',
      body: {
        remoteId: draft.remoteId.trim(),
        kind: draft.kind,
        ...(label ? { label } : {}),
        config,
        ...(mirror !== undefined ? { mirror } : {}),
      },
    };
  }
  return {
    method: 'PATCH',
    path: remotePath(draft.remoteId),
    body: { label: draft.label, config, ...(mirror !== undefined ? { mirror } : {}) },
  };
}

// ── registration ─────────────────────────────────────────────────────

/**
 * The header pill and the banner for `GET /api/registration`. `skipped` is a
 * NORMAL state — standalone-runnable is a compliance requirement — so it is a
 * muted note, not an error. Otherwise a banner appears only when something is
 * wrong, and it carries cc's OWN words verbatim: they already name the
 * directory and the fix, and paraphrasing them would throw that away.
 * @param {{state:string, detail?:string|null, rows?:{id:string, state:string, message:string}[]}|null|undefined} reg
 * @returns {null|{pill:{text:string, tone:'ok'|'neutral'|'bad'}, banner:null|{kind:'muted', text:string}|{kind:'error', detail:string|null, rows:string[]}}}
 */
export function registrationView(reg) {
  if (!reg) return null;
  const benign = reg.state === 'ok' || reg.state === 'skipped' || reg.state === 'pending';
  const pill = {
    text: `registration: ${reg.state}`,
    tone: /** @type {'ok'|'neutral'|'bad'} */ (reg.state === 'ok' ? 'ok' : benign ? 'neutral' : 'bad'),
  };
  if (reg.state === 'skipped' || reg.state === 'unsupported') {
    return { pill, banner: { kind: 'muted', text: String(reg.detail ?? reg.state) } };
  }
  const rows = (reg.rows ?? []).filter(row => row.state !== 'ok').map(row => `${row.id}: ${row.message}`);
  if (rows.length === 0 && !reg.detail) return { pill, banner: null };
  return { pill, banner: { kind: 'error', detail: reg.detail ? String(reg.detail) : null, rows } };
}
