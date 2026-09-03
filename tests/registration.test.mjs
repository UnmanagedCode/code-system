// PINS auto-registration against a SCRIPTED FAKE CC, asserted on the recorded
// request log rather than on timing.
//
// The two claims that matter most: an already-correct row sends NO request at
// all (a PATCH would make cc re-probe on every backend restart), and every
// failure is a RECORDED STATE preserving cc's own message verbatim — never a
// throw, never an exit, never a retry loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCHER, fakeConductor } from './helpers.mjs';
import { desiredRows, register } from '../src/registration.mjs';

const ROWS = desiredRows();
const DOCKER = ROWS.find(r => r.id === 'docker');
const SSH = ROWS.find(r => r.id === 'ssh');

const systemsBody = (systems) => ({ status: 200, body: { systems } });

test('the launch argv is a function of (install path, kind) only — no config value in it', () => {
  assert.deepEqual(ROWS.map(r => r.id), ['docker', 'ssh']);
  for (const row of ROWS) {
    assert.deepEqual(row.launch, [process.execPath, LAUNCHER, '--kind', row.id]);
    // A bare "node" would depend on the ORCHESTRATOR's PATH, which we do not
    // control — cc spawns without a shell.
    assert.equal(row.launch[0].startsWith('/'), true, 'an absolute interpreter');
    assert.equal(row.launch[1].startsWith('/'), true, 'and an absolute launcher path');
    assert.ok(row.label.length > 0);
  }
  // Stable across calls: cc caches its handle per (row.id, JSON.stringify(argv)),
  // so a launch argv that varied would re-register on every restart.
  assert.deepEqual(desiredRows(), ROWS);
});

test('a fresh install creates both rows', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    if (req.method === 'POST') return { status: 201, body: { added: req.body } };
    return null;
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'ok');
  assert.deepEqual(state.rows.map(r => [r.id, r.state]), [['docker', 'ok'], ['ssh', 'ok']]);
  assert.deepEqual(cc.requests.map(r => r.method), ['GET', 'POST', 'POST']);
  assert.deepEqual(cc.requests[1].body, { id: 'docker', label: DOCKER.label, launch: DOCKER.launch });
  assert.deepEqual(cc.requests[2].body, { id: 'ssh', label: SSH.label, launch: SSH.launch });
});

test('rows that already match send NOTHING beyond the GET', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([{ ...DOCKER }, { ...SSH }]);
    return { status: 500, body: { error: 'should not have been called' } };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'ok');
  assert.deepEqual(cc.requests.map(r => r.method), ['GET'],
    'a PATCH here would make cc re-probe on every backend restart');
});

test('one present, one missing: only the missing one is created', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([{ ...DOCKER }]);
    if (req.method === 'POST') return { status: 201, body: {} };
    return null;
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'ok');
  assert.deepEqual(cc.requests.map(r => r.method), ['GET', 'POST']);
  assert.equal(cc.requests[1].body.id, 'ssh');
});

test('argv drift is repaired with a PATCH carrying only the launch', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') {
      return systemsBody([
        { ...DOCKER, launch: ['/some/old/node', '/moved/away/main.mjs', '--kind', 'docker'] },
        { ...SSH },
      ]);
    }
    if (req.method === 'PATCH') return { status: 200, body: {} };
    return null;
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'ok');
  assert.deepEqual(cc.requests.map(r => r.method), ['GET', 'PATCH']);
  assert.equal(cc.requests[1].url, '/api/settings/systems/docker');
  assert.deepEqual(cc.requests[1].body, { launch: DOCKER.launch });
});

// THE DEVCONTAINER CASE, and the reason this must be a state rather than a
// crash: cc's assertSessionRootsPlaceable refuses when any ancestor of the
// session-root path holds a .git entry, and its message already names the
// directory and the fix.
test('a 400 is `blocked` with cc\'s own message preserved VERBATIM', async (t) => {
  const ccMessage = "system 'docker' cannot host session roots: '/workspaces/cc-projects' is inside a git"
    + ' repository (/workspaces/cc-projects/.git). Move the projects root outside it.';
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 400, body: ccMessage };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'blocked');
  for (const row of state.rows) {
    assert.equal(row.state, 'blocked');
    assert.equal(row.httpStatus, 400);
    assert.equal(row.message, ccMessage, 'not paraphrased — the actionable part is cc\'s own text');
  }
  // AND THE BACKEND IS STILL USABLE: register() returned a value rather than
  // throwing, so the caller keeps serving.
  assert.equal(typeof state.checkedAt, 'string');
});

test('a 502 is `unreachable` and says it is our bug, not the user\'s', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 502, body: "system 'docker' could not be reached with that command: provider exited 2" };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'unreachable');
  assert.match(state.rows[0].message, /provider exited 2/, "cc's message, which embeds our stderr tail");
  assert.match(state.rows[0].message, /bug signal in this plugin/);
});

test('a 404 on the collection is `unsupported` — this cc predates Systems', async (t) => {
  const cc = await fakeConductor(() => ({ status: 404, body: { error: 'not found' } }));
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'unsupported');
  assert.match(state.detail, /Systems support/);
  assert.deepEqual(cc.requests.map(r => r.method), ['GET'], 'no retry, and nothing written');
});

test('a 409 is `ok` — another instance won the race', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 409, body: "system 'docker' already exists" };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'ok');
  assert.deepEqual(state.rows.map(r => r.state), ['ok', 'ok']);
});

test('an unrecognised status is `error`, carrying the status and body', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 503, body: 'the conductor is restarting' };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'error');
  assert.equal(state.rows[0].httpStatus, 503);
  assert.match(state.rows[0].message, /restarting/);
});

test('no CONDUCTOR_URL is `skipped`, not a failure — the plugin stays standalone-runnable', async () => {
  for (const url of [undefined, '', '   ']) {
    const state = await register({ conductorUrl: url });
    assert.equal(state.state, 'skipped');
    assert.match(state.detail, /CONDUCTOR_URL/);
    assert.deepEqual(state.rows, []);
  }
});

test('a refused connection is `error`, and nothing throws or retries', async () => {
  // Port 1 on loopback: nothing listens, so connect() is refused immediately.
  const state = await register({ conductorUrl: 'http://127.0.0.1:1' });
  assert.equal(state.state, 'error');
  assert.match(state.detail, /failed/);
});

test('a GET that answers non-JSON is `error` rather than an exception', async (t) => {
  const cc = await fakeConductor(() => ({ status: 200, body: 'not json at all' }));
  t.after(() => cc.close());
  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'error');
});
