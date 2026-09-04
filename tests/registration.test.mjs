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
import { REQUEST_TIMEOUT_MS, desiredRows, register } from '../src/registration.mjs';

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

// PINS THE 409 RECONCILE. Another instance winning the create race is `ok` only
// if it registered OUR launch argv; if it registered a different one (an older
// install path), leaving it would keep cc spawning the wrong launcher forever.
test('a 409 whose winner has a DIFFERENT launch is repaired, not accepted', async (t) => {
  const stale = ['/old/node', '/old/main.mjs', '--kind', 'docker'];
  let created = false;
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') {
      // First GET: empty, so we try to POST. Later GETs: the race winner's row.
      const rows = created ? [{ ...DOCKER, launch: stale }, { ...SSH }] : [];
      return systemsBody(rows);
    }
    if (req.method === 'POST') { created = true; return { status: 409, body: 'already exists' }; }
    if (req.method === 'PATCH') return { status: 200, body: {} };
    return null;
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'ok');
  const patch = cc.requests.find(r => r.method === 'PATCH');
  assert.ok(patch, 'the losing instance re-read and repaired the row');
  assert.equal(patch.url, '/api/settings/systems/docker');
  assert.deepEqual(patch.body, { launch: DOCKER.launch });
});

test('a 409 whose winner has the SAME launch sends no PATCH', async (t) => {
  let created = false;
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody(created ? [{ ...DOCKER }, { ...SSH }] : []);
    if (req.method === 'POST') { created = true; return { status: 409, body: 'already exists' }; }
    return { status: 500, body: 'should not have been called' };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'ok');
  assert.equal(cc.requests.some(r => r.method === 'PATCH'), false,
    'nothing to repair means nothing to send');
});

// PINS the plan's split: `unsupported` means "this cc has no Systems support",
// which is only knowable from the COLLECTION GET. A 404 on a per-row PATCH
// means the row vanished under us — a different fact, and not one to report as
// a claim about cc's version.
test('a per-row 404 is `error`, not `unsupported`', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') {
      return systemsBody([{ ...DOCKER, launch: ['/stale/node', '/stale/main.mjs', '--kind', 'docker'] }, { ...SSH }]);
    }
    return { status: 404, body: 'system not found' };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'error');
  const row = state.rows.find(r => r.id === 'docker');
  assert.equal(row.state, 'error');
  assert.equal(row.httpStatus, 404);
  assert.match(row.message, /not found/);
});

// PINS that a conductor which accepts the connection and then stalls cannot
// wedge POST /api/registration/retry. Node's fetch has no default timeout, so
// without AbortSignal.timeout this hangs forever.
test('a stalled conductor is an `error` after the request timeout, not a hang', async (t) => {
  const http = await import('node:http');
  const held = [];
  const server = http.createServer((_req, res) => { held.push(res); /* never answered */ });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const res of held) res.destroy();
    await new Promise(r => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  // A short signal injected through fetchImpl, so the test is fast and does not
  // depend on the production 10s constant.
  const fetchImpl = (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(300) });
  const started = Date.now();
  const state = await register({ conductorUrl: url, fetchImpl });
  assert.equal(state.state, 'error');
  assert.ok(Date.now() - started < 5_000, 'it gave up rather than hanging');
  assert.match(state.detail, /failed/);
});

test('the production request timeout is set, and is finite', () => {
  assert.equal(Number.isFinite(REQUEST_TIMEOUT_MS), true);
  assert.ok(REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 60_000);
});

// PINS the body cap. An unbounded read would buffer whatever the conductor
// sends; the cap keeps a broken or hostile peer from deciding our memory use.
test('an oversized error body is truncated rather than buffered whole', async (t) => {
  const huge = 'x'.repeat(256 * 1024); // 4x the cap — enough to prove it, fast to send
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 400, body: huge };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'blocked');
  assert.ok(state.rows[0].message.length <= 64 * 1024,
    `kept ${state.rows[0].message.length} bytes of a ${huge.length}-byte body`);
  assert.ok(state.rows[0].message.length > 0, 'but still shows the user what came back');
});

// PINS THAT PRODUCTION ATTACHES THE TIMEOUT, not just that a timeout works.
// The stall test above injects its own fetchImpl carrying its own signal, so it
// stays green even if every withTimeout() call were deleted from the source.
// This one records what the production code actually passes.
test('every request registration makes carries an abort signal', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') {
      return systemsBody([{ ...DOCKER, launch: ['/stale/node', '/stale/main.mjs', '--kind', 'docker'] }]);
    }
    return { status: 201, body: {} };
  });
  t.after(() => cc.close());

  const seen = [];
  const recording = (input, init = {}) => {
    seen.push({ url: String(input), method: init.method ?? 'GET', signal: init.signal ?? null });
    return fetch(input, init);
  };

  await register({ conductorUrl: cc.url, fetchImpl: recording });
  // A GET, a PATCH (drifted argv) and a POST (missing row) — all three.
  assert.ok(seen.length >= 3, `saw ${seen.length} requests`);
  for (const r of seen) {
    assert.ok(r.signal, `${r.method} ${r.url} was sent with no abort signal`);
    assert.equal(typeof r.signal.aborted, 'boolean', 'and it is a real AbortSignal');
  }
});

test('the delete-warning lookup in the API also carries an abort signal', async (t) => {
  const { projectsNamingForTest } = await import('../src/api.mjs');
  const seen = [];
  const recording = async (input, init = {}) => {
    seen.push(init.signal ?? null);
    return { ok: true, body: null, text: async () => JSON.stringify({ systems: [] }) };
  };
  await projectsNamingForTest('anything', { conductorUrl: 'http://127.0.0.1:9', fetchImpl: recording });
  assert.equal(seen.length, 1);
  assert.ok(seen[0], 'a DELETE runs inside a user request and must not be able to wedge it');
});

// ── cc's error ENVELOPE ──────────────────────────────────────────────
//
// The two tests above that assert "cc's own message, verbatim" hand the fake
// conductor a BARE STRING body. The real cc never sends one: its shared error
// handler answers EVERY /api/settings/systems refusal as `{"error":"<message>"}`
// and nothing else — it strips the `code` its internal errors carry
// (cc's src/routes.ts, the router-tail `r.use((err, …))` at the pin
// 8b7b10bf). So the body has to be UNWRAPPED, or a blocked card shows a JSON
// envelope where docs/protocol.md promises cc's own words.

// The real `.git`-ancestor placement refusal, copied from cc's
// assertSessionRootsPlaceable at the pin. This is the single most likely 400 a
// user will ever see from this plugin.
const PLACEMENT_REFUSAL = "cannot host sessions for system 'docker':"
  + " '/workspaces/cc-projects' is a git repository, and it contains where cc keeps this"
  + " system's local session directories (/workspaces/cc-projects/.code-conductor/systems/docker)."
  + ' Move the code-conductor store out of the repository.';

// PINS: the 400 the user is most likely to hit reaches the card as a SENTENCE,
// not as JSON. Without the unwrap the card shows
// `{"error":"cannot host sessions…"}` — the actionable text is still in there,
// wrapped in punctuation that makes it read like a crash.
test('a 400 in cc\'s `{error}` envelope is UNWRAPPED, not shown as JSON', async (t) => {
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 400, body: { error: PLACEMENT_REFUSAL } };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'blocked');
  assert.equal(state.rows[0].message, PLACEMENT_REFUSAL, "cc's sentence, and only it");
  assert.doesNotMatch(state.rows[0].message, /^\s*\{/, 'no JSON envelope reaches the card');
  assert.doesNotMatch(state.rows[0].message, /"error"/);
});

// PINS: the 502's appended bug-signal sentence survives the unwrap. That
// sentence is the only thing telling the operator a handshake failure is OUR
// bug rather than their configuration.
test('a 502 is unwrapped too, and keeps the bug-signal sentence', async (t) => {
  const ccText = "system 'docker' could not be reached with that command: provider exited 2";
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 502, body: { error: ccText } };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.state, 'unreachable');
  assert.match(state.rows[0].message, /^system 'docker' could not be reached/, 'unwrapped');
  assert.doesNotMatch(state.rows[0].message, /"error"/);
  assert.match(state.rows[0].message, /bug signal in this plugin/, 'and still says whose bug it is');
});

// PINS: the unwrap FALLS BACK to raw text. A proxy, a crash page or an older cc
// can answer something that is not our JSON at all, and that text is still the
// most useful thing we have — swallowing it because it did not parse would
// leave the user with a bare status code.
test('a refusal that is not cc\'s JSON at all still reaches the user verbatim', async (t) => {
  const html = '<html><body><h1>502 Bad Gateway</h1><p>nginx/1.24.0</p></body></html>';
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 400, body: html };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.equal(state.rows[0].message, html, 'not swallowed because it did not parse');
});

// PINS: a JSON body that is not cc's envelope is not silently emptied. A body
// like `{"detail":"…"}` has no `error` key; unwrapping to `undefined` there
// would show the user nothing at all.
test('a JSON refusal with no `error` key is shown whole, not emptied', async (t) => {
  const body = { detail: 'something else entirely' };
  const cc = await fakeConductor((req) => {
    if (req.method === 'GET') return systemsBody([]);
    return { status: 400, body };
  });
  t.after(() => cc.close());

  const state = await register({ conductorUrl: cc.url });
  assert.match(state.rows[0].message, /something else entirely/);
});
