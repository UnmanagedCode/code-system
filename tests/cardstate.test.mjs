// PINS THE CARD'S DECISIONS, with no DOM and no server.
//
// Everything a card must get right is a DECISION, not a rendering — which word
// the toggle shows, whether a disagreement between the gate and the probe is a
// warning or an error, what the copy is allowed to claim. Those live in
// frontend/src/lib/cardState.mjs, which is pure, and the React components only
// wire them to the DOM.
// That split is what makes the card testable without a browser rig.
//
// THE INVARIANT UNDERNEATH ALL OF THEM: a card carries TWO states that disagree
// routinely — the GATE (what the operator set) and the PROBE (what is true).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindDescriptors } from '../src/launcher/kinds/index.mjs';
import {
  GATE_COPY, STRIPE_COUNT, baselineNotice, gateCopy, own, cardAlert, configPayload, createDraft, editDraft, fieldLabel, gateStatus,
  mirrorDraft, mirrorPayload, mirrorSummary, probeStatus, advancedOpenOnEdit, advancedSummary, registrationView,
  remotePath, routeFromSearch, searchForRoute, stripeClass, submitRequest, switchKind,
} from '../frontend/src/lib/cardState.mjs';

const remote = (over = {}) => ({
  remoteId: 'app-ctr',
  kind: 'docker',
  label: 'App container',
  enabled: false,
  config: { container: 'app' },
  baseline: { state: 'unknown', fingerprint: null, missing: [], checkedAt: null },
  reachability: { connected: false, detail: 'container \'app\' exists but is not running', fingerprint: null },
  ...over,
});

// PINS: THE TOGGLE TRACKS OPERATOR INTENT, NEVER THE PROBE. A control whose
// position is not what the operator set is a broken control — and this is the
// one place the two-state model could silently collapse back into one.
test('the gate word is a function of `enabled` alone', () => {
  for (const connected of [true, false]) {
    for (const enabled of [true, false]) {
      const g = gateStatus(remote({ enabled, reachability: { connected, detail: 'x', fingerprint: null } }));
      assert.equal(g.enabled, enabled);
      assert.equal(g.word, enabled ? 'Enabled' : 'Disabled',
        `enabled=${enabled} connected=${connected}: the probe must not move the toggle`);
    }
  }
});

// PINS: the probe is the OTHER axis, and it moves with reachability alone.
test('the probe line is a function of reachability alone, and carries the transport\'s own words', () => {
  for (const enabled of [true, false]) {
    const up = probeStatus(remote({ enabled, reachability: { connected: true, detail: 'container \'app\' running (img) since X', fingerprint: 'f' } }));
    assert.equal(up.level, 'ok');
    assert.match(up.detail, /running \(img\)/, 'the detail is the transport\'s, not a paraphrase');

    const down = probeStatus(remote({ enabled }));
    assert.equal(down.level, 'down');
    assert.match(down.detail, /not running/);
  }
  // A record the store could not read has no probe at all — claiming "down"
  // would name a cause nobody measured.
  const broken = probeStatus({ remoteId: 'x', broken: { reason: 'malformed', message: 'bad' } });
  assert.equal(broken.level, 'unknown');
});

// PINS THE MEASURED SSH FACT, AND FORBIDS OVER-CLAIMING IT. With the gate ON
// and the master dropped out of band, commands STILL RUN — unmultiplexed, each
// paying its own authentication. Losing the master is losing multiplexing, not
// losing capability, and a card that says otherwise sends the operator to debug
// a host that is fine.
test('an ssh master dropped under an enabled gate is a WARNING, not a failure', () => {
  const r = remote({
    kind: 'ssh', enabled: true, config: { host: 'box' },
    reachability: { connected: false, detail: 'no master for \'box\'', fingerprint: null },
  });
  const alert = cardAlert(r);
  assert.notEqual(alert, null);
  assert.equal(alert.level, 'warn', 'not an error: the remote still works');
  assert.doesNotMatch(alert.text, /cannot run|no commands|unusable|unreachable/i,
    'the remote is none of those — only its multiplexing is gone');
  assert.match(alert.text, /still run|multiplex/i, 'and it says what is actually lost');
});

// PINS: A STOPPED CONTAINER IS NEVER OFFERED A START. Attach-only is a locked
// decision; a card that hinted otherwise would promise something the provider
// refuses at the argv layer (assertAttachOnly).
test('a stopped container under an enabled gate says code-system will not start it', () => {
  const alert = cardAlert(remote({ enabled: true }));
  assert.notEqual(alert, null);
  assert.equal(alert.level, 'warn');
  assert.match(alert.text, /never starts|will not start|does not start/i);
  assert.doesNotMatch(alert.text, /\bstart it here\b|press|click to start/i,
    'nothing on the card may imply code-system can start it');
});

// PINS: a gate-off refusal is attributed to THE GATE, not to the transport.
// ssh is the kind where the distinction actually bites, because it HAS a
// connection that could be blamed instead — so this is the one copy that
// must say so.
test('ssh\'s copy names the gate, not the connection, as what stops commands', () => {
  assert.match(GATE_COPY.ssh, /the gate is what stops them, not the connection/i);
});

// PINS: NO GATE_COPY ENTRY NAMES A DEAD KIND. A served kind may have no entry
// (a kind with nothing worth saying, like docker now), but every entry that
// exists must name a kind the backend still serves — the kind set comes from
// the descriptors the backend actually serves, so a removed kind cannot leave
// its old copy stranded.
test('every gate-copy entry names a kind the backend actually serves', () => {
  const served = kindDescriptors().map(d => d.kind);
  for (const [kind, copy] of Object.entries(GATE_COPY)) {
    assert.ok(served.includes(kind), `${kind} has gate copy but is not served by the backend`);
    assert.ok(copy.length > 0, `${kind}'s copy is not empty`);
  }
});

// PINS: an `unsupported` baseline is NOT SUMMARISED AWAY. The whole value of
// the probe is the target's own words — busybox's `find: unrecognized: -printf`
// is what tells an operator which image to change. A card showing only
// "unsupported" throws away the only actionable part.
test('an unsupported baseline shows every capability, its probe and the target\'s own words', () => {
  const missing = [
    { capability: 'readDir', probe: 'find -printf', detail: 'find: unrecognized: -printf' },
    { capability: 'realpath', probe: 'realpath -e --', detail: 'realpath: unrecognized option' },
    { capability: 'stat', probe: 'stat -L -c %.3Y', detail: 'mtime has no sub-second precision: 81a4 2 1788194735' },
    { capability: 'shell', probe: '[ -x /bin/bash ]', detail: '/bin/bash is not executable on this target' },
  ];
  const notice = baselineNotice(remote({ baseline: { state: 'unsupported', fingerprint: 'f', missing, checkedAt: 'x' } }));
  assert.notEqual(notice, null);
  assert.equal(notice.level, 'err');
  const text = notice.lines.join('\n');
  for (const m of missing) {
    assert.ok(text.includes(m.capability), `${m.capability} is named`);
    assert.ok(text.includes(m.probe), `${m.capability}'s probe is named`);
    assert.ok(text.includes(m.detail), `${m.capability}'s own error text survives`);
  }
  assert.equal(notice.lines.length, missing.length, 'one line each — none folded together');

  // `ok` and `unknown` say nothing: absence of evidence is not evidence.
  assert.equal(baselineNotice(remote({ baseline: { state: 'ok', missing: [] } })), null);
  assert.equal(baselineNotice(remote()), null);
});

// PINS: a store refusal reaches the user UNMODIFIED. It already names the
// schema found and the repair; paraphrasing it would throw that away, and a
// broken record is exactly the case where the user has least other information.
test('a broken record shows the store\'s own message verbatim, as an error', () => {
  const message = "remote 'future' is stored at schema 9, but this version reads schema 1 only"
    + ' — start the code-system backend, which moves a record it cannot read aside'
    + ' into the quarantine directory';
  const alert = cardAlert({ remoteId: 'future', broken: { reason: 'schema', message } });
  assert.equal(alert.level, 'err');
  assert.equal(alert.text, message, 'verbatim');
});

// PINS: a card with both states agreeing raises nothing. An alert on every card
// is an alert on none.
test('a card whose gate and probe agree raises no alert', () => {
  assert.equal(cardAlert(remote({ enabled: true, reachability: { connected: true, detail: 'up', fingerprint: 'f' } })), null);
  assert.equal(cardAlert(remote({ enabled: false })), null,
    'a disabled, stopped container is exactly what the operator asked for');
});

// PINS THE ROUTE ROUND-TRIP. Routing is query-string only — never a path
// segment — because cc's proxy guarantees a trailing slash by 301, but relative
// URLs resolve wrongly under a no-trailing-slash deep link. A constant path
// makes that hazard unreachable.
test('the form route round-trips through the query string', () => {
  for (const route of [{ view: 'list' }, { view: 'add' }, { view: 'edit', remoteId: 'app-ctr' }]) {
    assert.deepEqual(routeFromSearch(searchForRoute(route)), route, JSON.stringify(route));
  }
  // Never a path segment.
  for (const route of [{ view: 'add' }, { view: 'edit', remoteId: 'a' }]) {
    assert.doesNotMatch(searchForRoute(route), /^\//);
  }
  // An id that could never name a remote falls back to the list rather than
  // opening an edit form on nothing.
  assert.deepEqual(routeFromSearch('?edit=../escape'), { view: 'list' });
  assert.deepEqual(routeFromSearch('?edit='), { view: 'list' });
  assert.deepEqual(routeFromSearch(''), { view: 'list' });
  assert.deepEqual(routeFromSearch('?something=else'), { view: 'list' });
  // A remoteId needing escaping survives the trip (the charset allows `.`).
  assert.deepEqual(routeFromSearch(searchForRoute({ view: 'edit', remoteId: 'a.b-c_d' })),
    { view: 'edit', remoteId: 'a.b-c_d' });
});

// ── the mirror advertisement's two decisions ─────────────────────────

// PINS: THE CHECKBOX IS THE WHOLE PREDICATE. The form keeps the root and the
// exclude text so that unticking and re-ticking does not lose what was typed —
// which is exactly why an unticked box must still send `null` rather than
// whatever those fields happen to hold.
test('mirrorPayload is null when unticked, and undefined when there is no form object (no choice)', () => {
  for (const over of [{}, { root: '/srv', exclude: '/proc\n/dev' }, { root: '', exclude: '' }]) {
    assert.equal(mirrorPayload({ on: false, root: '/', exclude: '', ...over }), null);
  }
  // No form object means no mirror group was rendered, so the operator made no
  // choice: `undefined` drops the key from the JSON body, and the backend's kind
  // default (POST) or the stored value (PATCH) applies. Not a crash, and not `null`.
  assert.equal(mirrorPayload(undefined), undefined);
  assert.equal(mirrorPayload(null), undefined);
});

// PINS THE TEXTAREA → WIRE RULE. NEWLINES ONLY: a path may legally contain a
// comma or a space, so splitting on either would cut one in half. And a trailing
// newline — which every operator leaves — must not become an empty exclude
// entry, which the backend would refuse with a 400 about `exclude[3]`.
test('mirrorPayload splits on newlines only, trims, and drops blank lines', () => {
  const p = mirrorPayload({ on: true, root: '  /srv/app  ', exclude: '/proc\n  /dev  \n\n/sys\n' });
  assert.deepEqual(p, { root: '/srv/app', exclude: ['/proc', '/dev', '/sys'] });

  assert.deepEqual(mirrorPayload({ on: true, root: '/', exclude: '' }).exclude, [],
    'an empty textarea is no entries, not one empty entry');
  assert.deepEqual(mirrorPayload({ on: true, root: '/', exclude: '/a b,/c' }).exclude, ['/a b,/c'],
    'a space or a comma is part of the path, never a separator');
});

// PINS: the badge appears only for a remote that opted in — a badge on every
// card is a badge on none — and it names the ROOT, which is the one thing an
// operator scans a card for.
test('mirrorSummary is null for an opted-out remote and names the root otherwise', () => {
  assert.equal(mirrorSummary(remote()), null, 'no mirror field at all');
  assert.equal(mirrorSummary(remote({ mirror: null })), null);
  assert.equal(mirrorSummary(remote({ mirror: { root: '/srv/app', exclude: ['/proc'] } })), 'mirror /srv/app');
  assert.equal(mirrorSummary(remote({ mirror: { root: '/', exclude: [] } })), 'mirror /');
});

// PINS the form's config payload: blank fields are omitted (never ''), a secret
// is never trimmed, and a stored secret the operator cleared goes as null —
// the backend's keep/clear protocol.
test('configPayload omits blanks, never trims a secret, and sends null for a cleared one', () => {
  const secrets = ['password'];
  assert.deepEqual(configPayload({ host: 'box', user: '  ', password: '' }, {}, secrets), { host: 'box' });
  assert.deepEqual(configPayload({ host: 'box', password: ' sp ace ' }, {}, secrets), { host: 'box', password: ' sp ace ' });
  assert.deepEqual(configPayload({ host: 'box' }, { password: true }, secrets), { host: 'box', password: null });
  assert.deepEqual(configPayload({ host: 'box', password: 'new' }, { password: true }, secrets),
    { host: 'box', password: 'new' }, 'a typed replacement wins over a clear tick');
  assert.deepEqual(configPayload({ host: 'box' }, { password: false }, secrets), { host: 'box' });
});

// PINS the Advanced summary vocabulary: no mirror half, unticked, ticked, and a
// ticked box with a cleared root each read differently, so the collapsed group
// states what Create will register.
test('advancedSummary states the mirror, and says so when there is no root', () => {
  assert.equal(advancedSummary(null), 'Advanced');
  assert.equal(advancedSummary({ on: false, root: '/', exclude: '' }), 'Advanced · no mirror');
  assert.equal(advancedSummary({ on: true, root: ' /srv ', exclude: '' }), 'Advanced · mirror /srv');
  assert.equal(advancedSummary({ on: true, root: '', exclude: '' }), 'Advanced · mirror (no root)');
});

// PINS the edit-open rule: only a stored advanced value or a mirror that is not
// exactly the served default opens the group; a default or absent mirror does not.
test('advancedOpenOnEdit opens for a stored advanced value or a non-default mirror only', () => {
  const fields = kindDescriptors().find(d => d.kind === 'ssh').configFields;
  const D = { root: '/', exclude: ['/proc', '/dev', '/sys'] };
  const open = (r, defaults = D) => advancedOpenOnEdit({ config: { host: 'h' }, mirror: null, ...r }, fields, defaults);

  assert.equal(open({}), false, 'nothing stored');
  assert.equal(open({ mirror: { ...D, exclude: [...D.exclude] } }), false, 'the default mirror');
  assert.equal(open({ config: { host: 'h', port: '22' } }), true, 'port');
  assert.equal(open({ config: { host: 'h', identityFile: '/k' } }), true, 'key file');
  assert.equal(open({ config: { host: 'h', port: '' } }), false, 'a blank value is not stored');
  assert.equal(open({ storedSecrets: ['password'] }), true, 'stored password');
  assert.equal(open({ config: { host: 'h', user: 'me' } }), false, 'user is not advanced for ssh');
  assert.equal(open({ mirror: { root: '/srv', exclude: D.exclude } }), true, 'custom root');
  assert.equal(open({ mirror: { root: '/', exclude: ['/proc'] } }), true, 'custom exclude');
  assert.equal(open({ mirror: { root: '/', exclude: ['/dev', '/proc', '/sys'] } }), true, 'reordered exclude');
  assert.equal(open({ mirror: { root: '/', exclude: 'x' } }), true, 'malformed exclude');
  assert.equal(open({ mirror: { root: '/srv', exclude: [] } }, null), false, 'no served defaults: no mirror half to open for');
  const docker = kindDescriptors().find(d => d.kind === 'docker').configFields;
  assert.equal(advancedOpenOnEdit({ config: { container: 'c', user: 'node' }, mirror: null }, docker, D), true, 'docker Run as');
});

// ── the drafts, the stripe, the requests and registration ────────────

const KINDS = kindDescriptors();
const DOCKER = KINDS.find(d => d.kind === 'docker');
const SSH = KINDS.find(d => d.kind === 'ssh');
const DEFAULTS = { root: '/', exclude: ['/proc', '/dev', '/sys'] };

// PINS the Add draft: the FIRST SERVED kind (never a hardcoded docker), its
// own mirror default ticked from the served list, and Advanced collapsed; with
// no served defaults there is no mirror half to draft.
test('createDraft drafts the first served kind with its mirror default, collapsed', () => {
  assert.deepEqual(createDraft([SSH, DOCKER], DEFAULTS), {
    remoteId: '', kind: 'ssh', label: '', config: {},
    mirror: { on: true, root: '/', exclude: '/proc\n/dev\n/sys' }, advancedOpen: false,
  });
  assert.equal(createDraft([{ ...DOCKER, mirrorByDefault: false }], DEFAULTS).mirror.on, false,
    'a kind that does not mirror by default starts unticked');
  assert.equal(createDraft([DOCKER], null).mirror, null, 'no served defaults: no mirror half');
  assert.equal(createDraft([], DEFAULTS).kind, 'docker', 'an empty catalog still yields a draft');
});

// PINS the Edit draft: a stored secret is NEVER prefilled and never re-sent
// unless typed (its name leaves `config`, `storedSecrets` keeps the fact), and
// Advanced opens by the same predicate the card form uses.
test('editDraft drops secret values from config, keeps storedSecrets, and opens Advanced by predicate', () => {
  const remote = {
    remoteId: 'pw', kind: 'ssh', label: 'Pw', config: { host: 'h', password: 'leaked', port: 22 },
    storedSecrets: ['password'], mirror: null,
  };
  const d = editDraft(remote, SSH, DEFAULTS);
  assert.deepEqual(d.config, { host: 'h', port: 22 }, 'the secret is gone, the rest is the record');
  assert.deepEqual(d.storedSecrets, ['password']);
  assert.deepEqual(d.clear, {});
  assert.equal(d.advancedOpen, true, 'a stored port opens it');
  assert.deepEqual(d.mirror, { on: false, root: '/', exclude: '/proc\n/dev\n/sys' }, 'a stored null stays unticked');
  assert.equal(editDraft({ ...remote, config: { host: 'h' }, storedSecrets: [] }, SSH, DEFAULTS).advancedOpen, false);
  assert.equal(d.label, 'Pw');
  assert.equal(editDraft({ remoteId: 'x', kind: 'ssh', config: { host: 'h' } }, SSH, DEFAULTS).label, '');
  assert.equal(remote.config.password, 'leaked', 'the record itself is not mutated');
});

// PINS the hand-edited-record guard: a malformed stored mirror degrades the
// form instead of throwing, which would blank every card.
test('mirrorDraft degrades a hand-edited mirror instead of throwing', () => {
  assert.deepEqual(mirrorDraft({ mirror: { root: '/srv', exclude: 'not-an-array' } }, DOCKER, DEFAULTS),
    { on: true, root: '/srv', exclude: '' });
  assert.deepEqual(mirrorDraft({ mirror: { exclude: ['/a'] } }, DOCKER, DEFAULTS), { on: true, root: '', exclude: '/a' });
});

// PINS the Kind switch: the old kind's config goes, and the mirror is the NEW
// kind's own default, not the old kind's.
test('switchKind clears config and re-derives the mirror for the new kind', () => {
  const draft = { ...createDraft([DOCKER], DEFAULTS), remoteId: 'x', config: { container: 'c' } };
  draft.mirror.on = false;
  const next = switchKind(draft, { ...SSH, mirrorByDefault: true }, DEFAULTS);
  assert.equal(next.kind, 'ssh');
  assert.deepEqual(next.config, {});
  assert.equal(next.mirror.on, true, 'the new kind\'s default, not the unticked box of the old one');
  assert.equal(next.remoteId, 'x', 'what the operator typed elsewhere survives');
  assert.equal(switchKind(draft, { ...SSH, mirrorByDefault: false }, DEFAULTS).mirror.on, false);
});

// PINS the optional suffix: an optional field is labelled as such, never hidden.
test('fieldLabel marks optional fields only', () => {
  assert.equal(fieldLabel({ label: 'Host', required: true }), 'Host');
  assert.equal(fieldLabel({ label: 'User', required: false }), 'User (optional)');
  assert.equal(fieldLabel({ label: 'Port' }), 'Port (optional)');
});

// PINS THE IDENTITY STRIPE: deterministic per id, and drawn ONLY from the fixed
// set of class names — whatever the id holds, it never reaches the output.
test('stripeClass is deterministic and drawn only from the fixed set', () => {
  assert.equal(STRIPE_COUNT, 8);
  const ids = ['on-up', 'app-ctr', 'a', 'z.z-z_z', 'x" style="color:red', 'bg-primary stripe-9', '<img src=x>', '', ' ',
    ...Array.from({ length: 200 }, (_, i) => `remote-${i}`)];
  const seen = new Set();
  for (const id of ids) {
    const c = stripeClass(id);
    assert.match(c, /^stripe-[0-7]$/, JSON.stringify(id));
    assert.equal(stripeClass(id), c, 'same id, same class');
    seen.add(c);
  }
  assert.equal(seen.size, STRIPE_COUNT, 'a sample of ids reaches every class');
  for (const odd of [undefined, null, 42, {}]) assert.match(stripeClass(odd), /^stripe-[0-7]$/);
});

// PINS the relative-path rule on every per-remote route: encoded, never `/`-led.
test('remotePath is relative and encodes the id', () => {
  assert.equal(remotePath('a.b'), 'api/remotes/a.b');
  assert.equal(remotePath('a b/c', 'connect'), 'api/remotes/a%20b%2Fc/connect');
  assert.equal(remotePath('x', 'disconnect'), 'api/remotes/x/disconnect');
  assert.doesNotMatch(remotePath('/x'), /^\//);
});

// PINS THE WIRE SHAPES the forms send: create trims the id and label and omits
// an empty label; edit sends the label as typed; blank config is omitted, a
// cleared secret is null; an undefined mirror omits its key on both.
test('submitRequest builds the exact POST and PATCH bodies', () => {
  const draft = {
    remoteId: '  box ', kind: 'ssh', label: '  ', config: { host: 'h', user: ' ', password: ' pw ' }, clear: {},
    mirror: { on: true, root: ' / ', exclude: '/proc\n\n/dev\n' },
  };
  assert.deepEqual(submitRequest('create', draft, SSH), {
    method: 'POST', path: 'api/remotes',
    body: { remoteId: 'box', kind: 'ssh', config: { host: 'h', password: ' pw ' }, mirror: { root: '/', exclude: ['/proc', '/dev'] } },
  });
  assert.equal(submitRequest('create', { ...draft, label: ' Box ' }, SSH).body.label, 'Box');
  const create = submitRequest('create', { ...draft, mirror: null }, SSH);
  assert.equal('mirror' in create.body, false, 'no mirror half: the key is omitted');
  assert.equal(submitRequest('create', { ...draft, mirror: { on: false, root: '/', exclude: '' } }, SSH).body.mirror, null);

  const edit = submitRequest('edit', { ...draft, remoteId: 'box', label: ' Box ', config: { host: 'h' }, clear: { password: true } }, SSH);
  assert.deepEqual(edit, {
    method: 'PATCH', path: 'api/remotes/box',
    body: { label: ' Box ', config: { host: 'h', password: null }, mirror: { root: '/', exclude: ['/proc', '/dev'] } },
  });
  assert.equal('mirror' in submitRequest('edit', { ...draft, remoteId: 'box', mirror: null }, SSH).body, false);
});

// PINS the registration vocabulary: the pill's tone per state, the muted note
// for a normal skip, no banner while everything is fine, and cc's own words
// (detail and each non-ok row) otherwise.
test('registrationView maps each state to its pill tone and banner', () => {
  assert.equal(registrationView(null), null);
  const ok = registrationView({ state: 'ok', rows: [{ id: 'docker', state: 'ok', message: 'ok' }] });
  assert.deepEqual(ok, { pill: { text: 'registration: ok', tone: 'ok' }, banner: null });
  assert.deepEqual(registrationView({ state: 'skipped', detail: 'CONDUCTOR_URL is not set' }), {
    pill: { text: 'registration: skipped', tone: 'neutral' }, banner: { kind: 'muted', text: 'CONDUCTOR_URL is not set' },
  });
  assert.deepEqual(registrationView({ state: 'unsupported' }).banner, { kind: 'muted', text: 'unsupported' });
  assert.equal(registrationView({ state: 'unsupported' }).pill.tone, 'bad');
  assert.deepEqual(registrationView({ state: 'pending', rows: [] }), { pill: { text: 'registration: pending', tone: 'neutral' }, banner: null });
  assert.deepEqual(registrationView({
    state: 'blocked', detail: 'cc said no',
    rows: [{ id: 'docker', state: 'blocked', message: "'/x' is a git repository" }, { id: 'ssh', state: 'ok', message: 'ok' }],
  }), {
    pill: { text: 'registration: blocked', tone: 'bad' },
    banner: { kind: 'error', detail: 'cc said no', rows: ["docker: '/x' is a git repository"] },
  });
  assert.deepEqual(registrationView({ state: 'unreachable', rows: [{ id: 'ssh', state: 'unreachable', message: 'ECONNREFUSED' }] }).banner,
    { kind: 'error', detail: null, rows: ['ssh: ECONNREFUSED'] });
});

// PINS THAT EVERY TABLE LOOKUP KEYED BY A RECORD FIELD IS AN OWN-PROPERTY
// LOOKUP. A kind named like an `Object.prototype` member would otherwise
// resolve to a function: a word table that is not one, an alert "text" that
// is a function, a gate note React cannot render.
test('a prototype-named kind gets the defaults, never an inherited member', () => {
  for (const kind of ['constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'toString']) {
    const r = remote({ kind, enabled: true, reachability: { connected: false, detail: `unknown kind '${kind}'`, fingerprint: null } });
    assert.deepEqual(probeStatus(r), { level: 'down', word: 'not reachable', detail: `unknown kind '${kind}'` }, kind);
    assert.deepEqual(probeStatus({ ...r, reachability: { connected: true, detail: '' } }).word, 'reachable', kind);
    assert.deepEqual(cardAlert(r), { level: 'warn', text: `The target is not reachable: unknown kind '${kind}'` }, kind);
    assert.equal(gateCopy(kind), null, kind);
    assert.equal(own({ a: 1 }, kind), undefined, kind);
  }
  assert.equal(gateCopy('ssh'), GATE_COPY.ssh, 'an own entry is still found');
  assert.equal(gateCopy('docker'), null);
  assert.equal(own({ a: 1 }, 'a'), 1);
});
