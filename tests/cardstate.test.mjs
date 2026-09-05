// PINS THE CARD'S DECISIONS, with no DOM and no server.
//
// Everything a card must get right is a DECISION, not a rendering — which word
// the toggle shows, whether a disagreement between the gate and the probe is a
// warning or an error, what the copy is allowed to claim. Those live in
// frontend/cardState.mjs, which is pure, and app.js only wires them to the DOM.
// That split is what makes the card testable without a browser rig.
//
// THE INVARIANT UNDERNEATH ALL OF THEM: a card carries TWO states that disagree
// routinely — the GATE (what the operator set) and the PROBE (what is true).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindDescriptors } from '../src/launcher/kinds/index.mjs';
import {
  GATE_COPY, GATE_SHARED_COPY, baselineNotice, cardAlert, gateStatus, mirrorPayload,
  mirrorSummary, probeStatus, routeFromSearch, searchForRoute,
} from '../frontend/cardState.mjs';

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
// Getting this wrong is the confusion the whole two-state model exists to
// prevent — an operator hunting a network fault they caused with a toggle.
test('the copy names the gate as what stops commands, on every kind', () => {
  assert.match(GATE_SHARED_COPY, /no command runs/i);
  assert.match(GATE_SHARED_COPY, /not contacted|does not contact|never contacted/i,
    'a disabled remote is not merely failing — it is never reached');
  // ssh is the kind where the distinction actually bites, because it HAS a
  // connection that could be blamed instead.
  assert.match(GATE_COPY.ssh, /the gate is what stops them, not the connection/i);
});

// PINS: EVERY SERVED KIND HAS COPY. The kind set comes from the descriptors the
// backend actually serves, so adding a kind cannot ship a wordless card.
test('every registered kind has gate copy', () => {
  for (const { kind } of kindDescriptors()) {
    assert.equal(typeof GATE_COPY[kind], 'string', `${kind} has copy`);
    assert.ok(GATE_COPY[kind].length > 0, `${kind}'s copy is not empty`);
  }
  // And no copy for a kind nobody serves, which would be dead text.
  assert.deepEqual(Object.keys(GATE_COPY).sort(), kindDescriptors().map(d => d.kind).sort());
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
test('mirrorPayload is null when the box is unticked, whatever else the form holds', () => {
  for (const over of [{}, { root: '/srv', exclude: '/proc\n/dev' }, { root: '', exclude: '' }]) {
    assert.equal(mirrorPayload({ on: false, root: '/', exclude: '', ...over }), null);
  }
  // A missing form object is opted out too, not a crash.
  assert.equal(mirrorPayload(undefined), null);
  assert.equal(mirrorPayload(null), null);
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
