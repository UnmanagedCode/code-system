// The card UI: vanilla ES module, no build step.
//
// THIS FILE IS DOM WIRING ONLY. Every decision a card makes — which word the
// toggle shows, whether a gate/probe disagreement is a warning or an error,
// what the copy may claim — lives in the pure ./cardState.mjs, which is unit
// tested with `node --test` and no browser (tests/cardstate.test.mjs).
//
// EVERY URL HERE IS RELATIVE. The plugin is served under an X-Forwarded-Prefix
// it does not know, so a leading slash breaks the page the moment it is mounted
// under code-conductor.

import {
  GATE_COPY, GATE_SHARED_COPY, baselineNotice, cardAlert, gateStatus, mirrorPayload,
  mirrorSummary, probeStatus, routeFromSearch, searchForRoute,
} from './cardState.mjs';

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

const state = {
  remotes: [],
  kinds: [],
  // Served by the backend from src/mirror.mjs. `null` until that answer lands,
  // and DELIBERATELY WITHOUT A LOCAL FALLBACK: a second copy of the default
  // exclude list here is exactly the drift the single source exists to prevent,
  // and a half-populated one would offer the operator a root with no excludes
  // while the form's own copy promises the target's pseudo-filesystems. The
  // Advanced group is simply not rendered until the defaults arrive.
  mirrorDefaults: null,
  registration: null,
  route: { view: 'list' },
  draft: null,      // the open form's field values, or null
  notice: null,     // a dismissible message from the last action (e.g. delete)
};
const busy = new Set(); // remoteIds with an action in flight

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  // The backend's router tail guarantees a JSON body on every status, so
  // `{error}` is always readable — see src/api.mjs.
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parsed.error || `HTTP ${res.status}`);
  return parsed;
}

// Deterministic hue per remoteId, so a card keeps the same accent bar across
// refreshes and is recognisable at a glance. code-hub's own recipe.
function hueFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

const descriptorFor = kind => state.kinds.find(k => k.kind === kind) ?? null;

// ── routing ──────────────────────────────────────────────────────────
//
// `history.replaceState`, not pushState: cc's bridge DEMOTES pushState to
// replaceState anyway, and its own navigation arrives back as a synthetic
// `popstate`. Query string only — see cardState.mjs on why never a path
// segment.
function go(route) {
  state.route = route;
  if (route.view === 'list') state.draft = null;
  history.replaceState(null, '', `${location.pathname}${searchForRoute(route)}`);
  render();
}
addEventListener('popstate', () => {
  state.route = routeFromSearch(location.search);
  state.draft = null;
  render();
});

// ── data ─────────────────────────────────────────────────────────────

// `periodic` marks the background poll. While a form is open it skips render()
// so the poll cannot tear the inputs down under the user's cursor — code-hub's
// same "suppress re-render churn while something is in flight" rule.
async function refresh({ periodic = false } = {}) {
  try {
    const [remotes, registration] = await Promise.all([
      api('GET', 'api/remotes'),
      api('GET', 'api/registration'),
    ]);
    state.remotes = remotes.remotes;
    state.kinds = remotes.kinds;
    if (remotes.mirrorDefaults) state.mirrorDefaults = remotes.mirrorDefaults;
    state.registration = registration;
    if (!periodic || !state.draft) render();
    document.getElementById('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    const emptyEl = document.getElementById('empty');
    emptyEl.textContent = `Backend unreachable: ${e.message}`;
    emptyEl.style.display = '';
  }
}

// NO OPTIMISTIC UPDATES. The card is disabled for the duration and the new
// state comes back from the server — a gate reading "Enabled" before the write
// landed would be exactly the lie this card is built to avoid.
async function action(id, run) {
  busy.add(id);
  render();
  try { await run(); }
  catch (e) { state.notice = { level: 'err', text: e.message }; }
  finally { busy.delete(id); await refresh(); }
}

// ── rendering ────────────────────────────────────────────────────────

// The GATE word and the PROBE word are two different facts, so they are two
// different elements. Collapsing them into one is the single mistake this whole
// card design exists to prevent.
function statusRow(remote) {
  const gate = gateStatus(remote);
  const probe = probeStatus(remote);
  return el('div', { class: 'card-head' },
    el('span', { class: `dot ${probe.level}`, title: probe.word }),
    el('span', { class: 'card-title' }, remote.label || remote.remoteId),
    el('div', { class: 'status-side' },
      el('span', { class: `gate-word ${gate.enabled ? 'on' : 'off'}` }, gate.word),
      el('span', { class: 'status-word' }, probe.word),
    ),
  );
}

function credRow(remoteId) {
  return el('div', {},
    el('div', { class: 'cred' },
      el('span', { class: 'cred-label' }, 'Remote'),
      el('span', { class: 'cred-val' }, remoteId),
      el('button', {
        class: 'cred-copy',
        // AWAITED, AND ONLY CONFIRMED ON RESOLVE. `navigator.clipboard` is
        // ABSENT in a non-secure context — which is exactly this plugin inside
        // cc's iframe over plain http — and present-but-rejecting when the
        // permission is denied. Firing it unawaited and flipping to "Copied"
        // regardless means the operator pastes nothing into cc's Remote field
        // believing the hand-off worked, and that string is the ONLY channel
        // between this card and a project.
        onclick: async (e) => {
          const btn = e.target;
          try {
            if (typeof navigator?.clipboard?.writeText !== 'function') {
              throw new Error('no clipboard in this context');
            }
            await navigator.clipboard.writeText(remoteId);
            btn.textContent = 'Copied';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
          } catch {
            // LEFT ON SCREEN rather than reset: the operator has to do
            // something, and the id beside it is selectable text.
            btn.textContent = 'Select & copy';
            btn.setAttribute('title', 'The browser would not give this page the clipboard'
              + ' — select the id and copy it by hand.');
          }
        },
      }, 'Copy'),
    ),
    // THE HAND-OFF CONTRACT, made visible. cc has no listRemotes frame, so this
    // string is the only thing connecting a project to this card.
    el('div', { class: 'cred-note' }, 'Paste this into a code-conductor project\'s Remote field.'),
  );
}

// ONE RENDERER FOR BOTH create and edit. The config fields come from the kind's
// own descriptor (GET /api/kinds), so the form can never offer a field the
// store would reject or hide one the kind requires.
function formFor(mode) {
  const draft = state.draft;
  const desc = descriptorFor(draft.kind);
  const submitting = busy.has(mode === 'create' ? NEW_KEY : draft.remoteId);

  const fields = [];
  if (mode === 'create') {
    fields.push(el('div', { class: 'field' },
      el('label', { for: 'f-id' }, 'Remote id'),
      el('input', {
        id: 'f-id', value: draft.remoteId, placeholder: 'app-ctr',
        oninput: e => { draft.remoteId = e.target.value; },
      }),
      el('span', { class: 'hint' },
        'Lower-case letters, digits, dot, dash, underscore. This is what goes in a project\'s'
        + ' Remote field, and it can never be renamed.'),
    ));
    fields.push(el('div', { class: 'field' },
      el('label', { for: 'f-kind' }, 'Kind'),
      el('select', {
        id: 'f-kind',
        onchange: (e) => { draft.kind = e.target.value; draft.config = {}; render(); },
      }, ...state.kinds.map(k => el('option', { value: k.kind, selected: k.kind === draft.kind }, k.label))),
    ));
  }

  fields.push(el('div', { class: 'field' },
    el('label', { for: 'f-label' }, 'Label'),
    el('input', {
      id: 'f-label', value: draft.label, placeholder: draft.remoteId || 'optional',
      oninput: e => { draft.label = e.target.value; },
    }),
  ));

  for (const f of desc?.configFields ?? []) {
    fields.push(el('div', { class: 'field' },
      el('label', { for: `f-${f.name}` }, `${f.label}${f.required ? '' : ' (optional)'}`),
      el('input', {
        id: `f-${f.name}`, value: draft.config[f.name] ?? '', placeholder: f.placeholder ?? '',
        oninput: e => { draft.config[f.name] = e.target.value; },
      }),
      f.hint ? el('span', { class: 'hint' }, f.hint) : null,
    ));
  }

  // A CHANGED CONFIG VALUE SWITCHES THE REMOTE OFF, and the form says so rather
  // than letting the operator discover it afterwards. The predicate is the
  // VALUE, not the presence of the field — this form has no dirty-tracking and
  // always PATCHes its config, and `sameConfig` in src/api.mjs is what decides.
  // So this sentence must not promise more than that comparison delivers.
  //
  // SCOPED TO THE CONNECTION FIELDS. The Advanced group below is outside
  // `sameConfig` on the backend precisely because a mirror change names the same
  // target, so the sentence must not claim it too.
  if (mode === 'edit') {
    fields.push(el('div', { class: 'note' },
      'Changing a connection value above switches this remote off: a different config may point'
      + ' at a different target entirely. Saving with every value unchanged — including editing'
      + ' only the label, or only the Advanced settings below — does not.'));
  }

  // THE MIRROR ADVERTISEMENT, collapsed by default: it is off for every remote
  // that has not opted in, and `<details>` is closed unless `open` is set. An
  // already-mirrored remote opens it, so an operator editing one sees what is
  // stored without hunting for it.
  //
  // ABSENT ENTIRELY until GET /api/remotes has served `mirrorDefaults` — see
  // `mirrorDraft`. Offering the group with no defaults would mean inventing
  // them here, which is the one thing the single source forbids.
  const m = draft.mirror;
  if (m) fields.push(el('details', { class: 'advanced', open: m.on },
    el('summary', {}, 'Advanced'),
    el('div', { class: 'field check' },
      el('input', {
        id: 'f-mirror-on', type: 'checkbox', checked: m.on,
        // WRITTEN BEFORE render(), like the kind <select>: the re-render reads
        // the draft, so an update after it would be a frame late.
        onchange: (e) => { m.on = e.target.checked === true; render(); },
      }),
      el('label', { for: 'f-mirror-on' }, 'Advertise a mirror root to code-conductor'),
    ),
    el('div', { class: 'field' },
      el('label', { for: 'f-mirror-root' }, 'Mirror root'),
      el('input', {
        id: 'f-mirror-root', value: m.root, placeholder: '/', disabled: !m.on,
        oninput: e => { m.root = e.target.value; },
      }),
      el('span', { class: 'hint' },
        'code-conductor\'s session root becomes the image of this path, so a worker can read and'
        + ' edit anywhere under it. / is the whole target.'),
    ),
    el('div', { class: 'field' },
      el('label', { for: 'f-mirror-exclude' }, 'Excluded paths'),
      // A TEXTAREA'S CONTENT IS A CHILD NODE, not a `value` attribute.
      el('textarea', {
        id: 'f-mirror-exclude', rows: 3, disabled: !m.on,
        oninput: e => { m.exclude = e.target.value; },
      }, m.exclude),
      el('span', { class: 'hint' },
        'One absolute path per line, in normal form. These are never carried across — the defaults'
        + ' are the target\'s pseudo-filesystems.'),
    ),
    el('span', { class: 'hint' },
      'code-conductor asks for this once per provider connection, so a change here reaches an'
      + ' already-running session only after the System reconnects. Changing it does not switch'
      + ' this remote off.'),
  ));

  return el('div', { class: 'form' },
    ...fields,
    el('div', { class: 'form-actions' },
      el('button', { class: 'connect', disabled: submitting, onclick: () => submit(mode) },
        mode === 'create' ? 'Create' : 'Save'),
      el('button', { disabled: submitting, onclick: () => go({ view: 'list' }) }, 'Cancel'),
    ),
  );
}

// The FORM's mirror state, which is not the wire shape: `exclude` is the raw
// textarea text, and `cardState.mirrorPayload` is what turns it back. An
// opted-out remote still gets the served defaults, so ticking the box offers
// them rather than an empty form.
function mirrorDraft(remote) {
  const d = state.mirrorDefaults;
  // No defaults yet ⇒ no group to draft for. `mirrorPayload(null)` is `null`, so
  // a form submitted in this state sends the same "advertise nothing" a
  // stored-null remote already has.
  if (!d) return null;
  const m = remote?.mirror;
  if (m && typeof m === 'object') {
    // GUARDED LIKE `mirrorSummary`: only the backend writes this field, but a
    // hand-edited record can hold anything, and `"x".join` is a TypeError that
    // would blank the whole card list rather than one form.
    return {
      on: true,
      root: String(m.root ?? ''),
      exclude: Array.isArray(m.exclude) ? m.exclude.join('\n') : '',
    };
  }
  return { on: false, root: String(d.root ?? '/'), exclude: (d.exclude ?? []).join('\n') };
}

// A busy key for the create form, which has no remoteId yet. Leading space, so
// it can never collide with one (the charset starts at [a-z0-9]).
const NEW_KEY = ' new';

async function submit(mode) {
  const draft = state.draft;
  // An empty optional field is OMITTED rather than sent as ''. The kind's
  // validator treats an absent operand as absent; sending '' would be the form
  // inventing a value the user did not type.
  const config = Object.fromEntries(
    Object.entries(draft.config).filter(([, v]) => String(v ?? '').trim() !== ''));
  await action(mode === 'create' ? NEW_KEY : draft.remoteId, async () => {
    if (mode === 'create') {
      await api('POST', 'api/remotes', {
        remoteId: draft.remoteId.trim(),
        kind: draft.kind,
        label: draft.label.trim() || undefined,
        config,
        mirror: mirrorPayload(draft.mirror),
      });
    } else {
      // ALWAYS SENT, like `config`: the form has no dirty-tracking. Safe because
      // the backend keeps `mirror` outside `sameConfig`, so re-sending it
      // unchanged cannot reset the gate.
      await api('PATCH', `api/remotes/${encodeURIComponent(draft.remoteId)}`,
        { label: draft.label, config, mirror: mirrorPayload(draft.mirror) });
    }
    go({ view: 'list' });
  });
}

// A gate route's response carries more than its status. `remove()` has always
// read its `warning` this way; these two now match it, so every route that can
// answer one has exactly one handling shape.
async function gateAction(path) {
  const res = await api('POST', path);
  if (res.warning) state.notice = { level: 'warn', text: res.warning };
}

// STATE AND ACTION ARE SEPARATE, deliberately: the gate WORD above reports what
// the operator set, and this button is how they change it. A switch widget
// would merge the two and make an in-flight failure look like a state.
function controls(remote) {
  const gate = gateStatus(remote);
  const isBusy = busy.has(remote.remoteId);
  const id = encodeURIComponent(remote.remoteId);
  return el('div', { class: 'controls' },
    gate.enabled
      ? el('button', {
        class: 'danger', disabled: isBusy,
        // THE RESPONSE IS READ, not discarded. Disconnect answers 200 with a
        // `warning` when the transport could not close its channel — disabling
        // is a safety action and must not be blockable — and `action()`
        // re-renders from a fresh GET that carries no warning. Dropping it
        // showed plain success while the ssh master was still open.
        onclick: () => action(remote.remoteId, () => gateAction(`api/remotes/${id}/disconnect`)),
      }, 'Disconnect')
      : el('button', {
        class: 'connect', disabled: isBusy,
        onclick: () => action(remote.remoteId, () => gateAction(`api/remotes/${id}/connect`)),
      }, 'Connect'),
    el('button', {
      disabled: isBusy,
      onclick: () => {
        state.draft = {
          remoteId: remote.remoteId,
          kind: remote.kind,
          label: remote.label ?? '',
          config: { ...remote.config },
          mirror: mirrorDraft(remote),
        };
        go({ view: 'edit', remoteId: remote.remoteId });
      },
    }, 'Edit'),
    el('button', { class: 'danger', disabled: isBusy, onclick: () => remove(remote) }, 'Delete'),
  );
}

// The delete warning is the concrete discharge of "cc cannot enumerate
// remotes": nothing else would tell the user which projects they just
// stranded, so it is put on screen rather than logged.
async function remove(remote) {
  if (!confirm(`Delete remote '${remote.remoteId}'? This cannot be undone.`)) return;
  await action(remote.remoteId, async () => {
    const res = await api('DELETE', `api/remotes/${encodeURIComponent(remote.remoteId)}`);
    if (res.warning) state.notice = { level: 'warn', text: res.warning };
  });
}

// A record the readers cannot understand is still SHOWN — a shorter list than
// the user configured would be the wrong answer. Delete only: offering Connect
// would be a button that cannot work.
function brokenCard(remote) {
  const c = el('div', { class: 'card broken' });
  c.appendChild(el('div', { class: 'card-head' },
    el('span', { class: 'dot unknown' }),
    el('span', { class: 'card-title' }, remote.remoteId),
    el('div', { class: 'status-side' }, el('span', { class: 'status-word' }, 'not readable')),
  ));
  c.appendChild(el('div', { class: 'err' }, cardAlert(remote).text));
  c.appendChild(el('div', { class: 'controls' },
    el('button', {
      class: 'danger', disabled: busy.has(remote.remoteId), onclick: () => remove(remote),
    }, 'Delete')));
  return c;
}

function card(remote) {
  if (remote.broken) return brokenCard(remote);

  const c = el('div', { class: 'card' });
  c.style.setProperty('--accent-bar', `hsl(${hueFor(remote.remoteId)} 80% 62%)`);
  c.appendChild(statusRow(remote));

  const desc = descriptorFor(remote.kind);
  const baselineState = remote.baseline?.state ?? 'unknown';
  const mirror = mirrorSummary(remote);
  c.appendChild(el('div', { class: 'meta' },
    el('span', { class: `badge kind-${remote.kind}` }, desc?.label ?? remote.kind),
    el('span', { class: `badge base-${baselineState}` }, `baseline ${baselineState}`),
    // Only when opted in — a badge on every card is a badge on none.
    mirror ? el('span', { class: 'badge mirror' }, mirror) : null,
  ));

  // The transport's OWN words about what it found, never a paraphrase: for ssh
  // this names the ControlPath, for docker the image and start time.
  const probe = probeStatus(remote);
  if (probe.detail) c.appendChild(el('div', { class: 'detail' }, probe.detail));

  const alert = cardAlert(remote);
  if (alert) c.appendChild(el('div', { class: alert.level === 'err' ? 'err' : 'warn' }, alert.text));

  const notice = baselineNotice(remote);
  if (notice) c.appendChild(el('div', { class: 'err' }, [notice.title, ...notice.lines].join('\n')));

  c.appendChild(credRow(remote.remoteId));

  // Both sentences, always: the shared one says what Disabled means at all, the
  // per-kind one says what enabling THIS kind actually does.
  c.appendChild(el('div', { class: 'note' },
    `${GATE_SHARED_COPY} ${GATE_COPY[remote.kind] ?? ''}`.trim()));

  c.appendChild(controls(remote));

  if (state.route.view === 'edit' && state.route.remoteId === remote.remoteId && state.draft) {
    c.appendChild(formFor('edit'));
  }
  return c;
}

function addTile() {
  const c = el('div', { class: 'card add-tile' });
  c.appendChild(el('div', { class: 'card-head' }, el('span', { class: 'card-title' }, 'New remote')));
  c.appendChild(formFor('create'));
  return c;
}

function registrationBanner() {
  const root = document.getElementById('registration');
  root.replaceChildren();

  if (state.notice) {
    root.appendChild(el('div', { class: 'banner' },
      el('h2', {}, state.notice.level === 'err' ? 'Action failed' : 'Warning'),
      el('div', { class: state.notice.level === 'err' ? 'err' : 'warn' }, state.notice.text),
      el('div', { class: 'controls' },
        el('button', { onclick: () => { state.notice = null; render(); } }, 'Dismiss')),
    ));
  }

  const reg = state.registration;
  const pill = document.getElementById('reg-pill');
  if (!reg) { pill.textContent = ''; return; }
  const benign = reg.state === 'ok' || reg.state === 'skipped' || reg.state === 'pending';
  pill.textContent = `registration: ${reg.state}`;
  pill.className = `pill ${reg.state === 'ok' ? 'ok' : benign ? '' : 'bad'}`;

  // `skipped` is a NORMAL state — standalone-runnable is a compliance
  // requirement — so it is a muted note, not an error.
  if (reg.state === 'skipped' || reg.state === 'unsupported') {
    root.appendChild(el('div', { class: 'banner muted' }, reg.detail ?? reg.state));
    return;
  }
  const bad = (reg.rows ?? []).filter(row => row.state !== 'ok');
  if (bad.length === 0 && !reg.detail) return;

  const b = el('div', { class: 'banner' }, el('h2', {}, 'System registration'));
  // cc's OWN message, verbatim: it already names the directory and the fix, and
  // paraphrasing it would throw away the only actionable part.
  if (reg.detail) b.appendChild(el('pre', {}, reg.detail));
  for (const row of bad) b.appendChild(el('pre', {}, `${row.id}: ${row.message}`));
  b.appendChild(el('div', { class: 'controls' },
    el('button', {
      disabled: busy.has(REG_KEY),
      onclick: () => action(REG_KEY, () => api('POST', 'api/registration/retry')),
    }, 'Retry')));
  root.appendChild(b);
}

const REG_KEY = ' registration';

// Full teardown, like code-hub's. With a poll this slow and lists this small, a
// diffing renderer would be complexity nobody is paying for.
function render() {
  registrationBanner();
  const root = document.getElementById('remotes');
  const emptyEl = document.getElementById('empty');
  root.replaceChildren();

  const adding = state.route.view === 'add' && state.draft;
  if (state.remotes.length === 0 && !adding) {
    emptyEl.textContent = 'No remotes yet. Add a Docker container or an SSH host to get started.';
    emptyEl.style.display = '';
    return;
  }
  emptyEl.style.display = 'none';
  for (const remote of state.remotes) root.appendChild(card(remote));
  if (adding) root.appendChild(addTile());
}

document.getElementById('refresh').addEventListener('click', () => refresh());
document.getElementById('add').addEventListener('click', () => {
  state.draft = {
    remoteId: '', kind: state.kinds[0]?.kind ?? 'docker', label: '', config: {}, mirror: mirrorDraft(null),
  };
  go({ view: 'add' });
});

state.route = routeFromSearch(location.search);
await refresh();

// TEN SECONDS, not code-hub's two, and only while the tab is visible: each
// refresh costs one `docker inspect` or `ssh -O check` PER REMOTE, each bounded
// at 5 s. The manual refresh button and the refresh after every action are
// unconditional.
setInterval(() => {
  if (document.visibilityState === 'visible') void refresh({ periodic: true });
}, 10000);
