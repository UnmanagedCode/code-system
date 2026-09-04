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

function installDom() {
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
  define('navigator', { clipboard: { writeText: () => {} } });
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

const okBaseline = { state: 'ok', fingerprint: 'f', missing: [], checkedAt: 'x' };
const unknownBaseline = { state: 'unknown', fingerprint: null, missing: [], checkedAt: null };

const REMOTES = [
  { // gate on, probe up
    remoteId: 'on-up', kind: 'docker', label: 'Running app', enabled: true,
    config: { container: 'app' }, baseline: okBaseline,
    reachability: { connected: true, detail: "container 'app' running (img) since T", fingerprint: 'f' },
  },
  { // gate on, probe DOWN — the docker warn row
    remoteId: 'on-down', kind: 'docker', label: 'Stopped app', enabled: true,
    config: { container: 'stopped' }, baseline: okBaseline,
    reachability: { connected: false, detail: "container 'stopped' exists but is not running", fingerprint: null },
  },
  { // gate off, probe up — no alert, and the card still shows reality
    remoteId: 'off-up', kind: 'docker', label: 'Disabled app', enabled: false,
    config: { container: 'app2' }, baseline: unknownBaseline,
    reachability: { connected: true, detail: "container 'app2' running (img) since T", fingerprint: 'f2' },
  },
  { // gate on, master DOWN — the ssh warn row
    remoteId: 'ssh-down', kind: 'ssh', label: 'Box', enabled: true,
    config: { host: 'box', user: 'me' },
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

function installFetch({ remotes = REMOTES, registration = REGISTRATION } = {}) {
  const calls = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET' });
      const body = path === 'api/remotes' ? { remotes, kinds: KINDS }
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
async function mount(opts) {
  const byId = installDom();
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
  assert.deepEqual(ids, ['f-id', 'f-label', 'f-container'], 'docker is the first kind');
  assert.match(tile.text, /the container/, "and the descriptor's hint is shown");

  // Switching kind swaps the config fields for the other kind's, including its
  // optional one — which is marked optional rather than hidden.
  const select = tile.all(e => e.tagName === 'select')[0];
  for (const fn of select.handlers.change ?? []) fn({ target: { value: 'ssh' } });
  const after = cards().at(-1);
  assert.deepEqual(after.all(e => e.tagName === 'input').map(i => i.attrs.id),
    ['f-id', 'f-label', 'f-host', 'f-user']);
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
  assert.deepEqual(inputs.map(i => i.attrs.id), ['f-label', 'f-host', 'f-user'],
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
