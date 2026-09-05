// PINS THAT frontend/app.js ACTUALLY RUNS, and renders the two states onto a
// card, by importing it against a ~60-line DOM stub.
//
// WHY THIS EXISTS, when the plan for this card said no browser rig was
// warranted. That is right about INVARIANTS — every decision a card makes lives
// in the pure cardState.mjs and is tested there. But it leaves app.js with zero
// EXECUTION coverage, and a ReferenceError or a mis-shaped call in `card()` is
// not a rendering concern: it is a blank page, and nothing else in this repo
// would catch it. (One such bug — `formFor({ mode })` against a positional
// parameter — was live in this file's first draft.)
//
// This is not a browser and does not try to be: no layout, no CSS, no events
// beyond the click handlers the cards install. It answers exactly one question
// — does the render path run, and does what it produces carry both states.
//
// node --test runs each file in its own process, so the globals installed here
// touch nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── the stub ─────────────────────────────────────────────────────────

class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.attrs = {};
    this.handlers = {};
    this.style = { setProperty: () => {} };
    this._text = '';
  }

  set textContent(v) { this._text = String(v); this.children.length = 0; }
  get textContent() { return this._text; }

  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c; this._text = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  click() { for (const fn of this.handlers.click ?? []) fn({ target: this }); }

  // Everything rendered under this node, as one string.
  get text() {
    return [this._text, ...this.children.map(c => c.text ?? '')].filter(Boolean).join(' ');
  }

  all(pred, out = []) {
    for (const c of this.children) {
      if (c instanceof El) { if (pred(c)) out.push(c); c.all(pred, out); }
    }
    return out;
  }
}

const SHELL_IDS = ['reg-pill', 'registration', 'updated', 'refresh', 'empty', 'remotes', 'add'];

// `clipboard` is passed explicitly, never defaulted here: a default parameter
// would swallow the very case under test (an ABSENT clipboard is `undefined`).
function installDom(clipboard) {
  const byId = new Map(SHELL_IDS.map(id => [id, new El('div')]));
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

  define('document', {
    createElement: tag => new El(tag),
    createTextNode: text => ({ text: String(text) }),
    getElementById: id => byId.get(id) ?? null,
    visibilityState: 'hidden',
  });
  define('location', { pathname: '/', search: '' });
  define('history', { replaceState: () => {} });
  define('addEventListener', () => {});
  // Scriptable, including ABSENT — which is the real deployment shape in a
  // non-secure iframe context under cc's proxy.
  define('navigator', clipboard === undefined ? {} : { clipboard });
  define('confirm', () => true);
  // The 10 s poll would otherwise hold the process open. The manual and
  // post-action refreshes are what these tests drive anyway.
  define('setInterval', () => 0);
  return byId;
}

// ── the fixture: one remote per row of the gate x probe table ────────

const KINDS = [
  { kind: 'docker', label: 'Docker containers', configFields: [{ name: 'container', label: 'Container', required: true, placeholder: 'my-app', hint: 'the container' }] },
  { kind: 'ssh', label: 'SSH hosts', configFields: [{ name: 'host', label: 'Host', required: true, placeholder: 'my-box', hint: 'a Host alias' }, { name: 'user', label: 'User', required: false, placeholder: '', hint: 'optional' }] },
];

// Served by the backend from src/mirror.mjs; the Advanced group prefills from
// the GET /api/remotes body, never from a copy in the frontend.
const MIRROR_DEFAULTS = { root: '/', exclude: ['/proc', '/dev', '/sys'] };
const STORED_MIRROR = { root: '/srv/app', exclude: ['/proc', '/srv/app/tmp'] };

const okBaseline = { state: 'ok', fingerprint: 'f', missing: [], checkedAt: 'x' };
const unknownBaseline = { state: 'unknown', fingerprint: null, missing: [], checkedAt: null };

const REMOTES = [
  { // gate on, probe up
    remoteId: 'on-up', kind: 'docker', label: 'Running app', enabled: true,
    config: { container: 'app' }, mirror: null, baseline: okBaseline,
    reachability: { connected: true, detail: "container 'app' running (img) since T", fingerprint: 'f' },
  },
  { // gate on, probe DOWN — the docker warn row
    remoteId: 'on-down', kind: 'docker', label: 'Stopped app', enabled: true,
    config: { container: 'stopped' }, mirror: null, baseline: okBaseline,
    reachability: { connected: false, detail: "container 'stopped' exists but is not running", fingerprint: null },
  },
  { // gate off, probe up — no alert, and the card still shows reality
    remoteId: 'off-up', kind: 'docker', label: 'Disabled app', enabled: false,
    config: { container: 'app2' }, mirror: null, baseline: unknownBaseline,
    reachability: { connected: true, detail: "container 'app2' running (img) since T", fingerprint: 'f2' },
  },
  { // gate on, master DOWN — the ssh warn row
    remoteId: 'ssh-down', kind: 'ssh', label: 'Box', enabled: true,
    config: { host: 'box', user: 'me' }, mirror: STORED_MIRROR,
    baseline: {
      state: 'unsupported',
      fingerprint: 'g',
      missing: [{ capability: 'readDir', probe: 'find -printf', detail: 'find: unrecognized: -printf' }],
      checkedAt: 'x',
    },
    reachability: { connected: false, detail: "no master for 'me@box'", fingerprint: null },
  },
  { // a record the store could not read
    remoteId: 'future',
    broken: { reason: 'schema', message: "remote 'future' is stored at schema 9, but this version reads schema 1 only — start the code-system backend" },
  },
];

const REGISTRATION = { state: 'ok', rows: [{ id: 'docker', state: 'ok', message: 'ok' }], checkedAt: 'x' };

// `reply` lets a test script one non-GET route's answer — which is how the
// action handlers, not just the render path, get put under test.
// `mirrorDefaults` is overridable — including to `null` — because "the backend
// has not served them yet" is a real state the form has to render in.
function installFetch({
  remotes = REMOTES, registration = REGISTRATION, reply = null, mirrorDefaults = MIRROR_DEFAULTS,
} = {}) {
  const calls = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (path, init = {}) => {
      calls.push({
        path,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body) : null,
      });
      const scripted = reply?.(path, init.method ?? 'GET');
      if (scripted) return { ok: scripted.ok !== false, status: scripted.status ?? 200, json: async () => scripted.body ?? {} };
      const body = path === 'api/remotes'
        ? { remotes, kinds: KINDS, ...(mirrorDefaults ? { mirrorDefaults } : {}) }
        : path === 'api/registration' ? registration
          : {};
      return { ok: true, status: 200, json: async () => body };
    },
  });
  return calls;
}

// A fresh module instance per test: app.js runs its first refresh at import
// time, so the cache buster is what makes each test independent.
let seq = 0;
async function mount(opts = {}) {
  const byId = installDom('clipboard' in opts ? opts.clipboard : { writeText: async () => {} });
  const calls = installFetch(opts);
  await import(`../frontend/app.js?t=${seq++}`);
  return { byId, calls, cards: () => byId.get('remotes').children };
}

const cardFor = (cards, id) => cards.find(c => c.text.includes(id));

// PINS: the render path RUNS, and produces one card per remote — including the
// unreadable one, because a shorter list than the user configured would be the
// wrong answer.
test('every remote renders a card, and nothing throws on the way', async () => {
  const { cards, calls } = await mount();
  assert.deepEqual(calls.map(c => c.path).sort(), ['api/registration', 'api/remotes']);
  assert.equal(cards().length, REMOTES.length);
  for (const r of REMOTES) {
    assert.notEqual(cardFor(cards(), r.remoteId), undefined, `${r.remoteId} has a card`);
  }
});

// PINS THE TWO STATES ON SCREEN, which is the whole point of the card. Both
// words are present, they are DIFFERENT elements, and the pairs that disagree
// really do show a gate word and a probe word that contradict each other.
test('each card shows the gate word and the probe word as separate facts', async () => {
  const { cards } = await mount();
  const gateWord = c => c.all(e => e.className.startsWith('gate-word'))[0]?.text;
  const probeWord = c => c.all(e => e.className === 'status-word')[0]?.text;

  const expected = {
    'on-up': ['Enabled', 'running'],
    'on-down': ['Enabled', 'container not running'],
    'off-up': ['Disabled', 'running'],
    'ssh-down': ['Enabled', 'shared connection down'],
  };
  for (const [id, [gate, probe]] of Object.entries(expected)) {
    const c = cardFor(cards(), id);
    assert.equal(gateWord(c), gate, `${id}: gate word`);
    assert.equal(probeWord(c), probe, `${id}: probe word`);
  }
  // The two rows where they contradict each other are exactly the point.
  assert.equal(gateWord(cardFor(cards(), 'on-down')), 'Enabled');
  assert.equal(gateWord(cardFor(cards(), 'off-up')), 'Disabled');
});

// PINS: the disagreement rows carry their warning, and the agreement rows do
// not — an alert on every card is an alert on none.
test('only the disagreeing cards carry a warning, and it says the right thing', async () => {
  const { cards } = await mount();
  const warn = c => c.all(e => e.className === 'warn')[0]?.text ?? '';

  assert.match(warn(cardFor(cards(), 'on-down')), /never starts one/,
    'a stopped container is never offered a start');
  assert.match(warn(cardFor(cards(), 'ssh-down')), /Commands still run/,
    'a dropped master is lost multiplexing, not lost capability');
  assert.equal(warn(cardFor(cards(), 'on-up')), '', 'agreement raises nothing');
  assert.equal(warn(cardFor(cards(), 'off-up')), '',
    'a disabled, running container is exactly what the operator asked for');
});

// PINS: the hand-off contract is ON the card. cc has no listRemotes frame, so
// this string is the only thing connecting a project to this remote — and the
// card says where to paste it.
test('every working card shows its remoteId and where it goes', async () => {
  const { cards } = await mount();
  for (const id of ['on-up', 'on-down', 'off-up', 'ssh-down']) {
    const c = cardFor(cards(), id);
    assert.equal(c.all(e => e.className === 'cred-val')[0]?.text, id, `${id} is shown verbatim`);
    assert.match(c.text, /Remote field/, `${id} says where it goes`);
  }
});

// PINS: the target's own words survive to the screen — both the transport's
// reachability detail and every line of an unsupported baseline verdict.
test('the target\'s own words reach the card, not a paraphrase', async () => {
  const { cards } = await mount();
  assert.match(cardFor(cards(), 'on-down').text, /exists but is not running/);
  const ssh = cardFor(cards(), 'ssh-down');
  assert.match(ssh.text, /no master for 'me@box'/);
  assert.match(ssh.text, /find: unrecognized: -printf/, 'the busybox error, verbatim');
  assert.match(ssh.text, /find -printf/, 'and the probe that caught it');
});

// PINS: a broken record gets Delete AND NOTHING ELSE. Offering Connect on a
// record the readers cannot understand would be a button that cannot work.
test('a broken card shows the store\'s message and only a Delete button', async () => {
  const { cards } = await mount();
  const c = cardFor(cards(), 'future');
  assert.match(c.text, /stored at schema 9/);
  const buttons = c.all(e => e.className === 'controls')[0]
    .all(e => e.tagName === 'button').map(b => b.text);
  assert.deepEqual(buttons, ['Delete']);
  assert.equal(c.all(e => e.className === 'cred-val').length, 0,
    'and no Copy row: there is no usable remoteId to hand to a project');
});

// PINS: the button offered is the one that changes the state — Connect on a
// disabled card, Disconnect on an enabled one. The reverse would be a control
// that appears to do nothing.
test('the action button matches the gate, not the probe', async () => {
  const { cards } = await mount();
  // Scoped to the controls row: the `.cred` row has a Copy button of its own.
  const buttons = id => cardFor(cards(), id)
    .all(e => e.className === 'controls')[0]
    .all(e => e.tagName === 'button').map(b => b.text);
  assert.deepEqual(buttons('on-down'), ['Disconnect', 'Edit', 'Delete'],
    'enabled but unreachable still offers Disconnect: the gate is what the button moves');
  assert.deepEqual(buttons('off-up'), ['Connect', 'Edit', 'Delete'],
    'disabled but running still offers Connect');
});

// PINS THE FORM PATH, which the static tests cannot reach: the add tile renders
// a field per descriptor field, and switching kind re-renders the right ones.
test('the add form renders one input per descriptor field, per kind', async () => {
  const { byId, cards } = await mount();
  byId.get('add').click();

  const tile = cards().at(-1);
  assert.match(tile.text, /New remote/);
  const ids = tile.all(e => e.tagName === 'input').map(i => i.attrs.id);
  assert.deepEqual(ids, ['f-id', 'f-label', 'f-container', 'f-mirror-on', 'f-mirror-root'],
    'docker is the first kind, and the Advanced group renders last');
  assert.match(tile.text, /the container/, "and the descriptor's hint is shown");

  // Switching kind swaps the config fields for the other kind's, including its
  // optional one — which is marked optional rather than hidden.
  const select = tile.all(e => e.tagName === 'select')[0];
  for (const fn of select.handlers.change ?? []) fn({ target: { value: 'ssh' } });
  const after = cards().at(-1);
  assert.deepEqual(after.all(e => e.tagName === 'input').map(i => i.attrs.id),
    ['f-id', 'f-label', 'f-host', 'f-user', 'f-mirror-on', 'f-mirror-root']);
  assert.match(after.text, /User \(optional\)/);
});

// PINS: Edit opens INSIDE that card and nowhere else, pre-filled from the
// record, and warns that a config change switches the remote off — which is the
// one consequence an operator would otherwise discover afterwards.
test('Edit opens an inline form on its own card, pre-filled, and warns about the gate', async () => {
  const { cards } = await mount();
  cardFor(cards(), 'ssh-down').all(e => e.tagName === 'button' && e.text === 'Edit')[0].click();

  const edited = cardFor(cards(), 'ssh-down');
  const inputs = edited.all(e => e.tagName === 'input');
  assert.deepEqual(inputs.map(i => i.attrs.id), ['f-label', 'f-host', 'f-user', 'f-mirror-on', 'f-mirror-root'],
    'the remoteId is NOT editable — it is never renamed once created');
  assert.equal(inputs.find(i => i.attrs.id === 'f-host').attrs.value, 'box', 'pre-filled');
  assert.equal(inputs.find(i => i.attrs.id === 'f-user').attrs.value, 'me');
  assert.match(edited.text, /switches this remote off/);

  // And no other card grew a form.
  for (const id of ['on-up', 'off-up']) {
    assert.equal(cardFor(cards(), id).all(e => e.tagName === 'input').length, 0, `${id} is untouched`);
  }
});

// PINS: an empty store says so rather than rendering nothing at all, and a
// failed registration shows cc's OWN message with a retry.
test('an empty store and a blocked registration both say so', async () => {
  const { byId } = await mount({
    remotes: [],
    registration: {
      state: 'blocked',
      rows: [{ id: 'docker', state: 'blocked', message: "'/x' is a git repository. Move the store." }],
      checkedAt: 'x',
    },
  });
  assert.match(byId.get('empty').text, /No remotes yet/);
  const banner = byId.get('registration');
  assert.match(banner.text, /is a git repository. Move the store./, "cc's own words, verbatim");
  assert.ok(banner.all(e => e.tagName === 'button' && e.text === 'Retry').length === 1);
  assert.match(byId.get('reg-pill').text, /blocked/);
});

// ── the ACTION handlers, not just the render path ────────────────────
//
// Everything above clicks `add` and `Edit`, which only re-render. The bugs that
// actually reached users were in the handlers that talk to the backend, and no
// test could have caught them because none dispatched those clicks.

const controlsOf = (card) => card.all(e => e.className === 'controls')[0];
const button = (card, text) =>
  controlsOf(card).all(e => e.tagName === 'button' && e.text === text)[0];

// PINS: Connect actually issues the connect POST for THAT remote, and the card
// re-reads from the server rather than flipping optimistically.
test('Connect POSTs to its own remote and re-reads the list', async () => {
  const { cards, calls } = await mount();
  calls.length = 0;
  button(cardFor(cards(), 'off-up'), 'Connect').click();
  await new Promise(r => setImmediate(r));

  const posted = calls.filter(c => c.method === 'POST');
  assert.deepEqual(posted.map(c => c.path), ['api/remotes/off-up/connect'],
    'exactly one POST, at the clicked card\'s own remote');
  assert.ok(calls.some(c => c.path === 'api/remotes' && c.method === 'GET'),
    'and the new state is re-read, never assumed');
});

// PINS: a DISCONNECT WARNING REACHES THE OPERATOR. The route answers
// 200 {remote, warning} by design when the transport could not close its
// channel — disabling must not be blockable — but `action()` re-renders from a
// fresh GET that carries no warning, so discarding the response showed plain
// success while the ssh master was still open. `remove()` already had the right
// shape; this makes the gate routes match it.
test('a disconnect warning is surfaced, not swallowed', async () => {
  const { byId, cards } = await mount({
    reply: (path, method) => (method === 'POST' && path.endsWith('/disconnect')
      ? { body: { remote: {}, warning: 'ssh could not close the master for me@box' } }
      : null),
  });
  button(cardFor(cards(), 'on-up'), 'Disconnect').click();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.match(byId.get('registration').text, /could not close the master/,
    'the operator is told the channel is still open');
});

// PINS the same for CONNECT's failure body. The route answers 502
// {error, remote}; `api()` throws with `error`, and `action()` must show it.
test('a refused connect shows the transport\'s own words', async () => {
  const { byId, cards } = await mount({
    reply: (path, method) => (method === 'POST' && path.endsWith('/connect')
      ? { ok: false, status: 502, body: { error: 'Permission denied (publickey).' } }
      : null),
  });
  button(cardFor(cards(), 'off-up'), 'Connect').click();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.match(byId.get('registration').text, /Permission denied \(publickey\)/);
});

// PINS: THE COPY BUTTON DOES NOT CLAIM SUCCESS IT DID NOT EARN.
//
// `navigator.clipboard` is absent in a NON-SECURE context, which is exactly
// this deployment inside cc's iframe over plain http. Firing it unawaited and
// flipping to "Copied" regardless means the operator pastes nothing into cc's
// Remote field believing the hand-off worked — and the remoteId is the ONLY
// channel between a card and a project.
test('Copy reports failure when the clipboard is unavailable', async () => {
  const { cards } = await mount({ clipboard: undefined });
  const card = cardFor(cards(), 'on-up');
  const copy = card.all(e => e.className === 'cred-copy')[0];
  copy.click();
  await new Promise(r => setImmediate(r));

  assert.notEqual(copy.text, 'Copied', 'it must not claim a copy that never happened');
  assert.match(copy.text, /copy|select/i, 'and says what the operator should do instead');
  // The id itself stays on screen and selectable, so the fallback is real.
  assert.equal(card.all(e => e.className === 'cred-val')[0].text, 'on-up');
});

// PINS the same for a clipboard that EXISTS and REJECTS — a denied permission
// prompt, which is the other way this fails in a browser.
test('Copy reports failure when the clipboard rejects', async () => {
  const { cards } = await mount({
    clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } },
  });
  const copy = cardFor(cards(), 'on-up').all(e => e.className === 'cred-copy')[0];
  copy.click();
  await new Promise(r => setImmediate(r));
  assert.notEqual(copy.text, 'Copied');
});

// PINS the success arm, so the two above cannot pass by never saying "Copied".
test('Copy confirms only after the write actually resolves', async () => {
  let wrote = null;
  const { cards } = await mount({
    clipboard: { writeText: async (v) => { wrote = v; } },
  });
  const copy = cardFor(cards(), 'on-up').all(e => e.className === 'cred-copy')[0];
  copy.click();
  await new Promise(r => setImmediate(r));
  assert.equal(wrote, 'on-up', 'the remoteId, verbatim');
  assert.equal(copy.text, 'Copied');
});

// ── the Advanced group: the mirror advertisement ─────────────────────
//
// The FIRST <details> in this UI. Everything the group decides lives in the pure
// cardState.mjs; what these rows pin is the WIRING — that it renders collapsed
// or open per the record, that the checkbox really enables the fields, and that
// the value actually leaves in the request body.

const inputById = (root, id) => root.all(e => e.tagName === 'input' && e.attrs.id === id)[0];
const detailsOf = root => root.all(e => e.tagName === 'details')[0];
const textareaOf = root => root.all(e => e.tagName === 'textarea')[0];

// PINS: a new remote does not advertise anything, the group is out of the way,
// and the fields carry the DEFAULTS SERVED BY THE BACKEND — so ticking the box
// offers a usable advertisement rather than an empty form.
test('the add form renders the Advanced group collapsed, unticked, prefilled from the served defaults', async () => {
  const { byId, cards } = await mount();
  byId.get('add').click();
  const tile = cards().at(-1);

  const details = detailsOf(tile);
  assert.notEqual(details, undefined, 'the group is rendered');
  assert.equal('open' in details.attrs, false, 'and collapsed: nothing is advertised yet');
  assert.equal('checked' in inputById(tile, 'f-mirror-on').attrs, false);
  assert.equal(inputById(tile, 'f-mirror-root').attrs.value, MIRROR_DEFAULTS.root);
  assert.equal(textareaOf(tile).text, MIRROR_DEFAULTS.exclude.join('\n'),
    'the three pseudo-filesystems, one per line');
  assert.equal('disabled' in inputById(tile, 'f-mirror-root').attrs, true,
    'and the fields are disabled while the box is unticked');
});

// PINS: an operator editing an already-mirrored remote SEES what is stored,
// without hunting for it — the one case where the group must be open.
test('the edit form for a mirrored remote opens the group, ticked and pre-filled', async () => {
  const { cards } = await mount();
  cardFor(cards(), 'ssh-down').all(e => e.tagName === 'button' && e.text === 'Edit')[0].click();
  const edited = cardFor(cards(), 'ssh-down');

  assert.equal('open' in detailsOf(edited).attrs, true);
  assert.equal('checked' in inputById(edited, 'f-mirror-on').attrs, true);
  assert.equal(inputById(edited, 'f-mirror-root').attrs.value, STORED_MIRROR.root);
  assert.equal(textareaOf(edited).text, STORED_MIRROR.exclude.join('\n'));
  assert.equal('disabled' in inputById(edited, 'f-mirror-root').attrs, false, 'and editable');
});

// PINS THE OTHER HALF: a remote that opted out gets the same collapsed,
// unticked group on edit — the form must not imply an advertisement that is not
// stored.
test('the edit form for an unmirrored remote leaves the group collapsed and unticked', async () => {
  const { cards } = await mount();
  cardFor(cards(), 'off-up').all(e => e.tagName === 'button' && e.text === 'Edit')[0].click();
  const edited = cardFor(cards(), 'off-up');

  assert.equal('open' in detailsOf(edited).attrs, false);
  assert.equal('checked' in inputById(edited, 'f-mirror-on').attrs, false);
  assert.equal(inputById(edited, 'f-mirror-root').attrs.value, MIRROR_DEFAULTS.root,
    'and ticking it would offer the defaults, not an empty root');
});

// PINS THE CHECKBOX WIRING: it writes the draft and re-renders, so the disabled
// fields become editable. A handler that re-rendered before writing would leave
// them disabled for a frame and lose the click.
test('ticking the box re-renders with the mirror fields enabled', async () => {
  const { byId, cards } = await mount();
  byId.get('add').click();
  const box = inputById(cards().at(-1), 'f-mirror-on');
  for (const fn of box.handlers.change ?? []) fn({ target: { checked: true } });

  const after = cards().at(-1);
  assert.equal('checked' in inputById(after, 'f-mirror-on').attrs, true);
  assert.equal('disabled' in inputById(after, 'f-mirror-root').attrs, false);
  assert.equal('disabled' in textareaOf(after).attrs, false);
  assert.equal('open' in detailsOf(after).attrs, true, 'and the group stays open across the re-render');
});

// PINS THAT THE VALUE ACTUALLY LEAVES. No test in this file asserted a submitted
// POST body at all before this one — the form could have rendered perfectly and
// sent nothing.
test('Create posts the mirror: null when unticked, the typed advertisement when ticked', async () => {
  const posted = async (tick) => {
    const { byId, cards, calls } = await mount({ remotes: [] });
    byId.get('add').click();
    const tile = cards().at(-1);
    for (const fn of inputById(tile, 'f-id').handlers.input ?? []) fn({ target: { value: 'app' } });
    if (tick) {
      const box = inputById(tile, 'f-mirror-on');
      for (const fn of box.handlers.change ?? []) fn({ target: { checked: true } });
      const open = cards().at(-1);
      for (const fn of inputById(open, 'f-mirror-root').handlers.input ?? []) fn({ target: { value: '/srv/app' } });
      for (const fn of textareaOf(open).handlers.input ?? []) fn({ target: { value: '/proc\n/dev\n' } });
    }
    const form = cards().at(-1);
    form.all(e => e.tagName === 'button' && e.text === 'Create')[0].click();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    return calls.find(c => c.method === 'POST' && c.path === 'api/remotes')?.body;
  };

  const off = await posted(false);
  assert.notEqual(off, undefined, 'the POST really happened');
  assert.equal(off.mirror, null, 'an unticked box sends the explicit "advertise nothing"');

  const on = await posted(true);
  assert.deepEqual(on.mirror, { root: '/srv/app', exclude: ['/proc', '/dev'] },
    'the typed root, and the lines as entries — the trailing newline is not one');
});

// PINS ITEM 3's GUARD: only the backend writes `mirror`, but the store is a
// directory of JSON files, and a hand-edited `exclude` that is a STRING would
// make `.join` a TypeError inside `render()` — blanking the entire card list,
// not just this form. The form degrades to an empty exclude box instead.
test('a hand-edited mirror does not crash the edit form', async () => {
  const broken = REMOTES.map(r => (r.remoteId === 'off-up'
    ? { ...r, mirror: { root: '/srv', exclude: 'not-an-array' } }
    : r));
  const { cards } = await mount({ remotes: broken });
  assert.equal(cards().length, broken.length, 'every card still rendered');

  cardFor(cards(), 'off-up').all(e => e.tagName === 'button' && e.text === 'Edit')[0].click();
  const edited = cardFor(cards(), 'off-up');
  assert.equal(inputById(edited, 'f-mirror-root').attrs.value, '/srv', 'the usable half survives');
  assert.equal(textareaOf(edited).text, '', 'and the unusable half is empty, not a thrown render');
});

// PINS ITEM 9: the defaults have ONE source, the backend. Before that answer
// lands there is nothing truthful to prefill — offering root `/` with an empty
// exclude list would contradict the form's own copy — so the group is absent
// rather than wrong, and a form submitted in that state advertises nothing.
test('with no served defaults the Advanced group is absent, and Create still posts mirror:null', async () => {
  const { byId, cards, calls } = await mount({ remotes: [], mirrorDefaults: null });
  byId.get('add').click();
  const tile = cards().at(-1);

  assert.equal(detailsOf(tile), undefined, 'no group at all');
  assert.equal(inputById(tile, 'f-mirror-on'), undefined);
  assert.deepEqual(tile.all(e => e.tagName === 'input').map(i => i.attrs.id), ['f-id', 'f-label', 'f-container'],
    'and the connection fields are untouched');

  for (const fn of inputById(tile, 'f-id').handlers.input ?? []) fn({ target: { value: 'app' } });
  tile.all(e => e.tagName === 'button' && e.text === 'Create')[0].click();
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  const body = calls.find(c => c.method === 'POST' && c.path === 'api/remotes')?.body;
  assert.notEqual(body, undefined, 'the POST really happened');
  assert.equal(body.mirror, null, 'and it advertises nothing, explicitly');
});
