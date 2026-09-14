// PINS the backend REST surface card 2026-0005 renders: remote CRUD with the
// kind owning its own config validation, that `remoteId` is never renamed, and
// that deleting a remote WARNS about the cc projects still naming it — which is
// the concrete discharge of .wiki/gotchas/no-remote-discovery.md, since cc
// cannot enumerate remotes on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApi } from '../src/api.mjs';
import { DEFAULT_MIRROR } from '../src/mirror.mjs';
import { SCHEMA } from '../src/store.mjs';
import { fakeConductor, stubDockerCli, stubSshCli, tempStore } from './helpers.mjs';

// What a GNU coreutils target answers the baseline probe, so a stub-driven
// probe lands on a definite verdict rather than an incidental one.
const GNU_OUT = ['OK\treadDir', 'OK\trealpath', 'OK\tstat', 'OK\tbase64', 'OK\tshell', ''].join('\n');

async function withApi(t, deps = {}, env = {}) {
  const store = await tempStore();
  const set = {
    CODE_SYSTEM_STORE: store.dir,
    // A card render asks each remote's kind for LIVE reachability, and `docker`'s
    // now really runs `docker inspect`. Pointed at an invocation that cannot
    // exist, so this suite answers the same on a machine with docker and on one
    // without — and never touches a real container that happens to share a name.
    CODE_SYSTEM_DOCKER: '["/definitely-not-docker-xyz"]',
    // Same for ssh: no test may reach a real host. A test that wants a stub
    // overrides these two through `env`.
    CODE_SYSTEM_SSH: '["/definitely-not-ssh-xyz"]',
    // ssh's ControlPath lives under TMPDIR, and `connect` creates that
    // directory. Per-test so two runs cannot share a socket path.
    TMPDIR: store.dir,
    ...env,
  };
  const prior = {};
  for (const [k, v] of Object.entries(set)) { prior[k] = process.env[k]; process.env[k] = v; }
  const app = express();
  app.use('/api', createApi(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await new Promise(r => server.close(r));
    await store.cleanup();
  });
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  // A raw fetch, for the paths where the point is that the body IS json.
  const raw = (url, init) => fetch(`${base}${url}`, init);
  return { call, raw, store, base };
}

// Read a stored record straight off disk — the API's answer and what it
// actually persisted are different claims, and the gate tests need both.
async function stored(store, id) {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  return JSON.parse(await fs.readFile(path.join(store.dir, 'remotes', `${id}.json`), 'utf8'));
}

test('health answers, which is all the conductor asks of it', async (t) => {
  const { call } = await withApi(t);
  const res = await call('GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.kinds, ['docker', 'ssh']);
});

test('a remote is created, listed, edited and deleted', async (t) => {
  const { call } = await withApi(t);
  assert.deepEqual((await call('GET', '/remotes')).body.remotes, []);

  const made = await call('POST', '/remotes', {
    remoteId: 'app-ctr', kind: 'docker', label: 'App container', config: { container: 'app' },
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.remote.schema, SCHEMA);
  assert.equal(made.body.remote.baseline.state, 'unknown', 'nothing is claimed before a probe');

  const listed = await call('GET', '/remotes');
  assert.equal(listed.body.remotes.length, 1);
  assert.equal(listed.body.remotes[0].remoteId, 'app-ctr');
  assert.equal(listed.body.remotes[0].reachability.connected, false,
    'no docker daemon is reachable through this suite\'s CODE_SYSTEM_DOCKER, and the card says so');
  assert.equal(listed.body.remotes[0].reachability.fingerprint, null,
    'an unreachable target caches no baseline verdict');
  assert.match(listed.body.remotes[0].reachability.detail, /CODE_SYSTEM_DOCKER/,
    'and names the seam an operator would fix it with');

  const edited = await call('PATCH', '/remotes/app-ctr', { label: 'Renamed', config: { container: 'other' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.remote.label, 'Renamed');
  assert.equal(edited.body.remote.config.container, 'other');
  assert.equal(edited.body.remote.remoteId, 'app-ctr', 'the id is never renamed');
  assert.equal(edited.body.remote.createdAt, made.body.remote.createdAt, 'createdAt survives an edit');
  assert.equal(edited.body.remote.baseline.state, 'unknown',
    'a changed config may point at a different target, so the old verdict is dropped');

  assert.equal((await call('DELETE', '/remotes/app-ctr')).status, 200);
  assert.equal((await call('DELETE', '/remotes/app-ctr')).status, 404);
});

test('a bad remoteId, an unknown kind and a bad config are each refused 400', async (t) => {
  const { call } = await withApi(t);
  const bad = await call('POST', '/remotes', { remoteId: '../escape', kind: 'docker', config: { container: 'x' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /remoteId/);

  assert.equal((await call('POST', '/remotes', { remoteId: 'a', kind: 'host', config: {} })).status, 400,
    'host is not a registerable kind');
  assert.equal((await call('POST', '/remotes', { remoteId: 'a', kind: 'nonsense', config: {} })).status, 400);

  // The KIND owns its config shape — the store never inspects it.
  const noContainer = await call('POST', '/remotes', { remoteId: 'a', kind: 'docker', config: {} });
  assert.equal(noContainer.status, 400);
  assert.match(noContainer.body.error, /container/);
});

test('creating the same remoteId twice is 409, and editing an absent one is 404', async (t) => {
  const { call } = await withApi(t);
  await call('POST', '/remotes', { remoteId: 'a', kind: 'ssh', config: { host: 'box' } });
  assert.equal((await call('POST', '/remotes', { remoteId: 'a', kind: 'ssh', config: { host: 'box2' } })).status, 409);
  assert.equal((await call('PATCH', '/remotes/ghost', { label: 'x' })).status, 404);
});

test('deleting a remote a cc project still names WARNS, naming the projects', async (t) => {
  const cc = await fakeConductor(() => ({
    status: 200,
    body: {
      systems: [
        { id: 'docker', projects: [{ name: 'web', remoteId: 'app-ctr' }, { name: 'other', remoteId: 'else' }] },
        { id: 'ssh', projects: [{ name: 'api', remoteId: 'app-ctr' }] },
      ],
    },
  }));
  t.after(() => cc.close());
  const { call } = await withApi(t, { registration: { conductorUrl: cc.url } });
  await call('POST', '/remotes', { remoteId: 'app-ctr', kind: 'docker', config: { container: 'app' } });

  const res = await call('DELETE', '/remotes/app-ctr');
  assert.equal(res.status, 200);
  assert.match(res.body.warning, /app-ctr/);
  assert.deepEqual(res.body.referencing.map(p => p.project).sort(), ['api', 'web']);
  assert.equal(res.body.referencing.some(p => p.project === 'other'), false,
    'a project naming a DIFFERENT remote is not a reference to this one');
});

test('a record the readers cannot understand is SURFACED, not hidden from the list', async (t) => {
  const { call, store } = await withApi(t);
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  await fs.mkdir(path.join(store.dir, 'remotes'), { recursive: true });
  await fs.writeFile(path.join(store.dir, 'remotes', 'future.json'), JSON.stringify({ schema: SCHEMA + 1, remoteId: 'future' }));

  const listed = await call('GET', '/remotes');
  assert.equal(listed.body.remotes.length, 1);
  assert.equal(listed.body.remotes[0].remoteId, 'future');
  assert.equal(listed.body.remotes[0].broken.reason, 'schema',
    'a shorter list than the user configured would be the wrong answer');
});

test('registration state is served, and the retry route is the only retry', async (t) => {
  const cc = await fakeConductor((req) => (req.method === 'GET'
    ? { status: 200, body: { systems: [] } }
    : { status: 400, body: 'placement refused' }));
  t.after(() => cc.close());
  const { call } = await withApi(t, { registration: { conductorUrl: cc.url } });

  assert.equal((await call('GET', '/registration')).body.state, 'pending',
    're-derived at every start, never persisted');
  const retried = await call('POST', '/registration/retry');
  assert.equal(retried.body.state, 'blocked');
  assert.equal(retried.body.rows[0].message, 'placement refused', "cc's own words");
  assert.equal((await call('GET', '/registration')).body.state, 'blocked', 'and the state is remembered');
});

test('the API refuses an option-shaped config rather than storing it', async (t) => {
  const { call } = await withApi(t);
  const bad = await call('POST', '/remotes', {
    remoteId: 'evil', kind: 'docker', config: { container: '-v /:/host' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /must not start with/);
  assert.deepEqual((await call('GET', '/remotes')).body.remotes, [], 'nothing was written');

  // And an edit cannot smuggle one in later.
  await call('POST', '/remotes', { remoteId: 'ok', kind: 'ssh', config: { host: 'box' } });
  const patched = await call('PATCH', '/remotes/ok', { config: { host: '-oProxyCommand=evil' } });
  assert.equal(patched.status, 400);
  const still = (await call('GET', '/remotes')).body.remotes[0];
  assert.equal(still.config.host, 'box', 'the stored value is unchanged');
});

// ── THE OPERATOR GATE, backend side ──────────────────────────────────
//
// Two states live on a card and they disagree routinely: the GATE
// (`record.enabled`, what the operator set, the only thing that decides whether
// an operation runs) and the PROBE (`reachability`, re-asked on every GET and
// never gated). These tests are about the gate; the probe's own rules stay
// where they were. See .wiki/gotchas/gate-versus-probe.md.

// PINS: a new remote starts SWITCHED OFF. An ssh remote genuinely has no master
// until `connect` runs, so a default-on gate would claim a state nobody
// established — and the refusal a disabled remote gives names the fix.
test('a newly created remote is switched OFF', async (t) => {
  const { call, store } = await withApi(t);
  const made = await call('POST', '/remotes', {
    remoteId: 'app-ctr', kind: 'docker', config: { container: 'app' },
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.remote.enabled, false);
  assert.equal((await stored(store, 'app-ctr')).enabled, false, 'and that is what was persisted');
});

// PINS: `connect` moves the gate AND drives the kind's own seam, and the card
// it answers with is a REAL RE-PROBE rather than a claim. A successful ssh
// connect changes the control socket's inode, which moves the fingerprint,
// which re-probes the baseline — all inside the action's own response.
test('connect opens the ssh master, sets the gate, and answers a freshly probed card', async (t) => {
  // A COLD START (`master: true`, nothing live yet): against a master that
  // already answers, `connect` is idempotent and starts nothing at all.
  const stub = await stubSshCli(t, { master: true, execStdout: GNU_OUT });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_SSH: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'box', kind: 'ssh', config: { host: 'box', user: 'me' } });

  const res = await call('POST', '/remotes/box/connect');
  assert.equal(res.status, 200);
  assert.equal(res.body.remote.enabled, true);
  assert.equal((await stored(store, 'box')).enabled, true, 'the gate is persisted, not just reported');
  assert.equal(res.body.remote.reachability.connected, true,
    'the response carries a probe, not an assumption');

  const argv = await stub.argv();
  assert.ok(argv.includes('-N'), 'a dedicated master was started');
  assert.ok(argv.lastIndexOf('check') > argv.indexOf('-N'),
    'and PROVEN with `-O check` afterwards, rather than trusting exit 0');
  assert.ok(argv.indexOf('check') < argv.indexOf('-N'),
    'and PRE-CHECKED before it, which is what makes a second Connect free');
});

// PINS ATTACH-ONLY AT ITS SHARPEST POINT: the one situation in which a provider
// that was NOT attach-only would start the container. Connecting a docker
// remote whose container is stopped SUCCEEDS — the gate is an operator setting,
// not a claim about the target — and the only docker invocation the whole route
// makes is the card's own read-only `inspect`.
test('connecting a docker remote whose container is STOPPED never starts it', async (t) => {
  const stub = await stubDockerCli(t, { stdout: 'false img 2026-09-01T00:00:00Z\n' });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'app-ctr', kind: 'docker', config: { container: 'app' } });

  const res = await call('POST', '/remotes/app-ctr/connect');
  assert.equal(res.status, 200, 'the gate is the operator\'s setting, not a claim about the target');
  assert.equal((await stored(store, 'app-ctr')).enabled, true);
  // The card still tells the truth about the container.
  assert.equal(res.body.remote.reachability.connected, false);
  assert.match(res.body.remote.reachability.detail, /not running/);

  const argv = await stub.argv();
  assert.deepEqual(argv.filter(a => ['start', 'stop', 'run', 'rm', 'create', 'restart'].includes(a)), [],
    'code-system never starts a container, and assertAttachOnly makes that unwritable');
  assert.deepEqual(argv.filter(a => a === 'inspect').length, 1, 'exactly one read-only inspect, for the card');
  assert.equal(argv.includes('exec'), false, 'and an unreachable target is not probed');
});

// PINS: "enabled" must never mean "enabled but we could not". The kind's
// `connect` runs FIRST and the gate is written only if it succeeded — the
// reverse order would leave a remote reporting itself usable while every
// operation against it failed at the transport.
test('a connect the transport refuses leaves the gate OFF, carrying ssh\'s own words', async (t) => {
  const stub = await stubSshCli(t, {
    master: true, connectExit: 255, connectStderr: 'Permission denied (publickey).\n',
  });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_SSH: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'box', kind: 'ssh', config: { host: 'box' } });

  const res = await call('POST', '/remotes/box/connect');
  assert.equal(res.status, 502);
  assert.match(res.body.error, /Permission denied \(publickey\)/, "the transport's own line, not a paraphrase");
  assert.equal((await stored(store, 'box')).enabled, false, 'the gate did NOT move');
  // The card still comes back, so the UI can show the failure against the card
  // rather than as a detached alert.
  assert.equal(res.body.remote.remoteId, 'box');
});

// PINS: DISABLING CANNOT BE BLOCKED. It is a safety action — the operator is
// withdrawing permission — so a transport that cannot close its channel is a
// WARNING on an otherwise-successful disable, never a failure that leaves the
// remote enabled. The gate is written FIRST for exactly this reason.
test('a disconnect the transport refuses still switches the remote off, with a warning', async (t) => {
  const stub = await stubSshCli(t, {
    socket: true, execStdout: GNU_OUT,
    exitExit: 255, exitStderr: 'something went wrong closing the master\n',
  });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_SSH: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'box', kind: 'ssh', config: { host: 'box' } });
  await call('POST', '/remotes/box/connect');

  const res = await call('POST', '/remotes/box/disconnect');
  assert.equal(res.status, 200, 'withdrawing permission must not be blockable');
  assert.equal((await stored(store, 'box')).enabled, false);
  assert.equal(res.body.remote.enabled, false);
  assert.match(res.body.warning, /something went wrong closing the master/,
    'and the operator is told the channel is still open');
});

// PINS: a DISABLED remote is never probed. The baseline probe is a round trip
// INTO the target, and it bypasses the launcher's gate entirely because it runs
// in the backend — so the gate has to be part of its condition, or a switched-
// off remote would still be executed against on every card render.
test('a disabled remote is never probed, however reachable it is', async (t) => {
  const stub = await stubDockerCli(t, { stdout: 'true img 2026-09-01T00:00:00Z\n', execStdout: GNU_OUT });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'app-ctr', kind: 'docker', config: { container: 'app' } });

  const listed = await call('GET', '/remotes');
  const card = listed.body.remotes[0];
  assert.equal(card.enabled, false);
  // The PROBE is NOT gated — this is how a disabled card still shows reality.
  assert.equal(card.reachability.connected, true, 'reachability still tells the truth');
  assert.notEqual(card.reachability.fingerprint, null, 'and the fingerprint moved');
  // But the round trip into the target did not happen.
  assert.equal(card.baseline.state, 'unknown');
  assert.equal((await stored(store, 'app-ctr')).baseline.state, 'unknown');
  assert.equal((await stub.argv()).includes('exec'), false,
    'no command was run against a remote the operator has switched off');

  // The control: enable it, and the very same setup DOES probe.
  await call('POST', '/remotes/app-ctr/connect');
  assert.equal((await stored(store, 'app-ctr')).baseline.state, 'ok');
  assert.equal((await stub.argv()).includes('exec'), true);
});

// PINS: a CONFIG edit resets the gate, a LABEL edit preserves it — by exactly
// the argument the route already makes for resetting `baseline`. For ssh it is
// not merely cautious: `controlPathFor` keys on (user, host), so editing `host`
// yields a DIFFERENT socket, the old master is irrelevant, and a carried-over
// "enabled" would be factually stale.
test('a config edit switches the remote off; a label-only edit does not', async (t) => {
  const stub = await stubSshCli(t, { socket: true, execStdout: GNU_OUT });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_SSH: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'box', kind: 'ssh', config: { host: 'box' } });
  await call('POST', '/remotes/box/connect');
  assert.equal((await stored(store, 'box')).enabled, true);

  // THE SHAPE THE UI ACTUALLY SENDS. frontend/app.js's edit form has no
  // dirty-tracking: it always PATCHes `{label, config}`, with `config` spread
  // from the stored record. A test that omits `config` exercises a request no
  // client emits — which is exactly how the label-only path shipped broken.
  const relabelled = await call('PATCH', '/remotes/box', {
    label: 'The box', config: { host: 'box' },
  });
  assert.equal(relabelled.body.remote.enabled, true, 'a rename points at the same target');
  assert.equal((await stored(store, 'box')).enabled, true);
  assert.equal(relabelled.body.remote.baseline.state, 'ok',
    'and the tooling verdict is about the same target, so it survives too');

  // The API's own shape — `config` omitted entirely — must behave the same.
  const omitted = await call('PATCH', '/remotes/box', { label: 'The box again' });
  assert.equal((await stored(store, 'box')).enabled, true);
  assert.equal(omitted.body.remote.label, 'The box again');

  const reconfigured = await call('PATCH', '/remotes/box', { config: { host: 'other-box' } });
  assert.equal(reconfigured.body.remote.enabled, false,
    'a changed config may point at a different target entirely');
  assert.equal((await stored(store, 'box')).enabled, false);
  assert.equal(reconfigured.body.remote.baseline.state, 'unknown', 'and the old verdict goes with it');
});

// PINS THE OUT-OF-BAND CASE FOR DOCKER, which had no coverage: a container
// stopped behind the plugin's back reads as not running on the next refresh, in
// the SAME server process, with nothing restarted and the gate untouched. This
// is the docker half of what tests/ssh-live.test.mjs pins for ssh.
test('a container stopped out of band shows on the next refresh, gate untouched', async (t) => {
  const stub = await stubDockerCli(t, {
    answers: { stdout: 'true img 2026-09-01T00:00:00Z\n', exitCode: 0 },
    execStdout: GNU_OUT,
  });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'app-ctr', kind: 'docker', config: { container: 'app' } });
  await call('POST', '/remotes/app-ctr/connect');
  assert.equal((await call('GET', '/remotes')).body.remotes[0].reachability.connected, true);

  // `docker stop`, by somebody else.
  await stub.setAnswer({ stdout: 'false img 2026-09-01T00:00:00Z\n', exitCode: 0 });

  const after = (await call('GET', '/remotes')).body.remotes[0];
  assert.equal(after.reachability.connected, false, 'the probe re-asked — nothing was cached');
  assert.match(after.reachability.detail, /not running/);
  assert.equal(after.enabled, true, 'and the operator gate did not move on its own');
  assert.equal((await stored(store, 'app-ctr')).enabled, true);
});

// PINS THE SAME FOR SSH, and the distinction that matters most in the UI: a
// master dropped out of band leaves the remote ENABLED. Commands still run,
// unmultiplexed — losing the master is losing multiplexing, not losing
// capability, and the card must not say otherwise.
test('an ssh master dropped out of band shows on the next refresh, gate untouched', async (t) => {
  const stub = await stubSshCli(t, {
    socket: true, execStdout: GNU_OUT,
    answers: { stderr: 'Master running (pid=4242)\n', exitCode: 0 },
  });
  const { call } = await withApi(t, {}, { CODE_SYSTEM_SSH: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'box', kind: 'ssh', config: { host: 'box' } });
  await call('POST', '/remotes/box/connect');
  assert.equal((await call('GET', '/remotes')).body.remotes[0].reachability.connected, true);

  // `ssh -O exit`, by somebody else. The measured wording for a dead socket.
  await stub.setAnswer({
    stderr: 'Control socket connect(/tmp/x): No such file or directory\n',
    exitCode: 255,
  });

  const after = (await call('GET', '/remotes')).body.remotes[0];
  assert.equal(after.reachability.connected, false);
  assert.equal(after.enabled, true,
    'a dropped master is NOT a withdrawn permission — commands still run, unmultiplexed');
});

// PINS: an edit takes effect on the NEXT operation, with no restart — the same
// no-cache property the launcher relies on, asserted from the backend side.
test('an edited config is what the next probe actually addresses', async (t) => {
  const stub = await stubDockerCli(t, { stdout: 'true img 2026-09-01T00:00:00Z\n', execStdout: GNU_OUT });
  const { call } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'app-ctr', kind: 'docker', config: { container: 'first' } });
  await call('GET', '/remotes');
  assert.ok((await stub.argv()).includes('first'));

  await call('PATCH', '/remotes/app-ctr', { config: { container: 'second' } });
  await call('GET', '/remotes');
  assert.ok((await stub.argv()).includes('second'), 'the SAME server addressed the new container');
});

// PINS the two routes' edge answers, which mirror PATCH's: an absent record is
// 404, and a record the readers cannot understand is 409 carrying the store's
// own message rather than a generic failure.
test('connect and disconnect answer 404 for an absent remote and 409 for an unreadable one', async (t) => {
  const { call, store } = await withApi(t);
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');

  for (const route of ['connect', 'disconnect']) {
    assert.equal((await call('POST', `/remotes/ghost/${route}`)).status, 404);
  }
  await fs.mkdir(path.join(store.dir, 'remotes'), { recursive: true });
  await fs.writeFile(path.join(store.dir, 'remotes', 'broken.json'), '{not json');
  for (const route of ['connect', 'disconnect']) {
    const res = await call('POST', `/remotes/broken/${route}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /not valid JSON/, "the store's own message");
  }
});

// PINS: the kind descriptors are SERVED, so the card UI's form comes from the
// kinds themselves rather than a copy in the frontend.
test('GET /kinds serves one descriptor per registered kind, with its form', async (t) => {
  const { call } = await withApi(t);
  const res = await call('GET', '/kinds');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.kinds.map(k => k.kind), ['docker', 'ssh']);
  for (const k of res.body.kinds) {
    assert.ok(k.label, 'a human label');
    assert.ok(Array.isArray(k.configFields) && k.configFields.length > 0);
    for (const f of k.configFields) assert.ok(f.name && f.label);
  }
  // THE `advanced` FLAG IS SERVED, and only on the fields that want it: it is
  // the frontend's whole routing signal for the card's Advanced group, and a
  // descriptor projection that dropped it would silently move a field back into
  // the connection block where nothing in a browser-free test looks.
  const docker = res.body.kinds.find(k => k.kind === 'docker');
  const byName = Object.fromEntries(docker.configFields.map(f => [f.name, f]));
  assert.equal(byName.user.advanced, true, 'docker `user` is rendered in Advanced');
  assert.equal('advanced' in byName.container, false, 'and `container` is a connection field');
  // GET /health keeps its PLAIN kind list: the conductor's liveness probe has
  // no use for descriptors.
  assert.deepEqual((await call('GET', '/health')).body.kinds, ['docker', 'ssh']);
});

// PINS: an unexpected failure answers JSON, not express's HTML page. The
// client's `api()` reads `{error}` off every response; an HTML body makes it
// throw a JSON parse error and show the user nothing about what went wrong.
// Driven through express's own body parser, which is a REACHABLE path — a
// proxy, a bug or an oversized config all reach it.
test('an unexpected error answers JSON, never express\'s HTML page', async (t) => {
  const { raw } = await withApi(t);

  for (const [label, body] of [
    ['a malformed body', '{not json'],
    ['an oversized body', JSON.stringify({ remoteId: 'a', kind: 'docker', config: { container: 'x'.repeat(300 * 1024) } })],
  ]) {
    const res = await raw('/remotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.ok(res.status >= 400, `${label}: refused`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/, `${label}: content-type`);
    const parsed = await res.json();
    assert.equal(typeof parsed.error, 'string', `${label}: the client can read {error}`);
    assert.ok(parsed.error.length > 0);
  }
});

// PINS THE PREDICATE FOR "a config change resets the gate": it is whether the
// VALUE changed, not whether the request carried a `config` key.
//
// The UI always sends `{label, config}` on an edit — there is no dirty-tracking
// — so a route testing `config !== undefined` reset the gate on every rename,
// while the form's own copy told the operator it would not. The product
// contradicted itself on the most ordinary action there is.
//
// Both arms here, because only the pair discriminates: an implementation that
// never resets passes the first and fails the second.
test('an identical config preserves the gate; one changed value resets it', async (t) => {
  const stub = await stubSshCli(t, { socket: true, execStdout: GNU_OUT });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_SSH: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'box', kind: 'ssh', config: { host: 'box', user: 'me' } });
  await call('POST', '/remotes/box/connect');
  assert.equal((await stored(store, 'box')).enabled, true);
  assert.equal((await stored(store, 'box')).baseline.state, 'ok');

  // ARM 1 — byte-identical config, re-sent. Nothing about the target changed.
  const same = await call('PATCH', '/remotes/box', {
    label: 'Renamed', config: { host: 'box', user: 'me' },
  });
  assert.equal(same.status, 200);
  assert.equal(same.body.remote.label, 'Renamed', 'the rename landed');
  assert.equal(same.body.remote.enabled, true, 'and the gate did NOT move');
  assert.equal((await stored(store, 'box')).enabled, true);
  assert.equal(same.body.remote.baseline.state, 'ok', 'nor did the tooling verdict');

  // Key ORDER is not a change either: `validateConfig` produces a canonical
  // shape, and a client is free to send the fields in any order.
  const reordered = await call('PATCH', '/remotes/box', { config: { user: 'me', host: 'box' } });
  assert.equal((await stored(store, 'box')).enabled, true, 'key order is not a config change');

  // ARM 2 — ONE value changed. This is a different target: for ssh
  // `controlPathFor` keys on (user, host), so the old master is not this
  // remote's, and a carried-over "enabled" would be factually stale.
  const changed = await call('PATCH', '/remotes/box', { config: { host: 'other-box', user: 'me' } });
  assert.equal(changed.body.remote.enabled, false, 'a changed target switches the remote off');
  assert.equal((await stored(store, 'box')).enabled, false);
  assert.equal(changed.body.remote.baseline.state, 'unknown', 'and drops the old verdict');
});

// PINS the other half of the same predicate: DROPPING an optional field is a
// change, and ADDING one is too. A shallow "same keys" check would miss both,
// and for ssh either one moves the ControlPath — so the gate must reset.
test('adding or dropping an optional config field is a config change', async (t) => {
  const stub = await stubSshCli(t, { socket: true, execStdout: GNU_OUT });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_SSH: JSON.stringify(stub.cli) });

  await call('POST', '/remotes', { remoteId: 'box', kind: 'ssh', config: { host: 'box', user: 'me' } });
  await call('POST', '/remotes/box/connect');
  await call('PATCH', '/remotes/box', { config: { host: 'box' } });
  assert.equal((await stored(store, 'box')).enabled, false, 'dropping `user` is a different destination');

  await call('POST', '/remotes/box/connect');
  await call('PATCH', '/remotes/box', { config: { host: 'box', user: 'root' } });
  assert.equal((await stored(store, 'box')).enabled, false, 'adding `user` is too');
});

// ── the docker identity, backend side ────────────────────────────────
//
// `config.user` is KIND-OWNED CONFIG rendered in the card's Advanced group, not
// operator policy beside it like `mirror`. That placement is what these rows are
// about: it goes through the same one validator, and — unlike a mirror change —
// it DOES reset the gate.

// PINS the reset, and why it is required rather than merely cautious:
// `reachability`'s fingerprint is image + StartedAt and cannot vary with the
// identity, so `needsProbe` would never fire on an identity change. This reset
// is the ONLY thing that re-probes the tooling baseline as the new user — and
// that verdict genuinely is uid-dependent (`[ -x /bin/bash ]`, `find`, `stat`).
test('changing the identity resets the gate and the baseline, like any other config change', async (t) => {
  const stub = await stubDockerCli(t, { stdout: 'true img 2026-09-01T00:00:00Z\n', execStdout: GNU_OUT });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', { remoteId: 'box', kind: 'docker', config: { container: 'app' } });
  await call('POST', '/remotes/box/connect');
  assert.equal((await stored(store, 'box')).enabled, true);
  assert.equal((await stored(store, 'box')).baseline.state, 'ok');

  const changed = await call('PATCH', '/remotes/box', { config: { container: 'app', user: 'node' } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.remote.config, { container: 'app', user: 'node' }, 'the identity landed');
  assert.equal(changed.body.remote.enabled, false, 'adding an identity switches the remote off');
  assert.equal(changed.body.remote.baseline.state, 'unknown', 'and drops the verdict probed as the old user');
  assert.equal((await stored(store, 'box')).enabled, false);

  // And so does CHANGING one, not only adding the first.
  await call('POST', '/remotes/box/connect');
  assert.equal((await stored(store, 'box')).enabled, true);
  await call('PATCH', '/remotes/box', { config: { container: 'app', user: '1000:1000' } });
  assert.equal((await stored(store, 'box')).enabled, false, 'a different identity is a different user');
  assert.equal((await stored(store, 'box')).baseline.state, 'unknown');
});

// PINS the other arm, which is what makes the first discriminating: the edit
// form has NO dirty-tracking and PATCHes `config` on every save, so an identity
// re-sent unchanged must not switch the remote off on an ordinary rename.
test('re-sending the same identity preserves the gate', async (t) => {
  const stub = await stubDockerCli(t, { stdout: 'true img 2026-09-01T00:00:00Z\n', execStdout: GNU_OUT });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await call('POST', '/remotes', {
    remoteId: 'box', kind: 'docker', config: { container: 'app', user: 'node' },
  });
  await call('POST', '/remotes/box/connect');
  assert.equal((await stored(store, 'box')).enabled, true);

  const same = await call('PATCH', '/remotes/box', {
    label: 'Renamed', config: { user: 'node', container: 'app' },
  });
  assert.equal(same.body.remote.label, 'Renamed', 'the rename landed');
  assert.equal(same.body.remote.enabled, true, 'and the gate did NOT move — key order is not a change');
  assert.equal(same.body.remote.baseline.state, 'ok');
});

// PINS that the store's front door is the only validator of the identity, on
// BOTH write routes, and that a refusal writes nothing — the operator sees a 400
// in the card's banner rather than a remote whose every operation fails later.
test('a malformed identity is refused 400 on POST and PATCH, and writes nothing', async (t) => {
  const { call, store } = await withApi(t);

  const rejected = await call('POST', '/remotes', {
    remoteId: 'bad', kind: 'docker', config: { container: 'app', user: 'no such' },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /user/, 'the message names the field');
  assert.equal((await call('GET', '/remotes')).body.remotes.length, 0, 'and nothing was written');

  await call('POST', '/remotes', { remoteId: 'box', kind: 'docker', config: { container: 'app', user: 'node' } });
  const before = await stored(store, 'box');
  for (const user of ['no such', '$(id)', '-rm']) {
    const res = await call('PATCH', '/remotes/box', { label: 'x', config: { container: 'app', user } });
    assert.equal(res.status, 400, JSON.stringify(user));
  }
  assert.deepEqual(await stored(store, 'box'), before, 'the stored record is untouched, label included');
});

// ── the mirror advertisement, backend side ───────────────────────────
//
// `mirror` is KIND-AGNOSTIC OPERATOR POLICY sitting beside `enabled`, not part
// of the kind-owned `config`. That placement is what these tests are about: the
// store's front door is its only validator, and — unlike a config change — a
// mirror change names the SAME target, so it must not reset the gate.

const MIRROR = { root: '/', exclude: ['/proc', '/dev', '/sys'] };

// PINS: opting in stores exactly what was sent, and opting out stores the
// explicit `null` cc reads as "I advertise nothing".
test('POST stores a mirror, and stores null when none is sent', async (t) => {
  const { call, store } = await withApi(t);
  const made = await call('POST', '/remotes', {
    remoteId: 'with', kind: 'docker', config: { container: 'a' }, mirror: MIRROR,
  });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.remote.mirror, MIRROR);
  assert.deepEqual((await stored(store, 'with')).mirror, MIRROR, 'and it is what landed on disk');

  await call('POST', '/remotes', { remoteId: 'without', kind: 'docker', config: { container: 'b' } });
  assert.equal((await stored(store, 'without')).mirror, null);
});

// PINS: an invalid advertisement is a 400 IN THE FORM, quoting the offending
// value — not cc's MIRROR_ADVERTISEMENT_INVALID (502) at session start — and
// nothing is written.
test('POST refuses an invalid mirror 400 and writes nothing', async (t) => {
  const { call } = await withApi(t);
  const bad = await call('POST', '/remotes', {
    remoteId: 'evil', kind: 'docker', config: { container: 'a' }, mirror: { root: '/a/../b' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /^mirror: /);
  assert.ok(bad.body.error.includes('"/a/../b"'), `the message quotes the value: ${bad.body.error}`);
  assert.deepEqual((await call('GET', '/remotes')).body.remotes, [], 'nothing was written');
});

test('PATCH refuses an invalid mirror 400 and leaves the stored record unchanged', async (t) => {
  const { call, store } = await withApi(t);
  await call('POST', '/remotes', {
    remoteId: 'app', kind: 'docker', config: { container: 'a' }, mirror: MIRROR,
  });
  const before = await stored(store, 'app');

  const bad = await call('PATCH', '/remotes/app', { mirror: { root: '/', exclude: ['/'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /covers the mirror root/);
  assert.deepEqual(await stored(store, 'app'), before, 'the record is byte-for-byte what it was');
});

// PINS THE WHOLE POINT OF KEEPING `mirror` OUT OF `config`: a config change may
// name a different target, so it resets the gate and the baseline; a mirror
// change names the SAME target, so it must not. The form promises exactly this.
test('a mirror-only PATCH leaves the gate and the baseline alone', async (t) => {
  const { call, store } = await withApi(t);
  await call('POST', '/remotes', { remoteId: 'app', kind: 'docker', config: { container: 'a' } });
  // Enable it and give it a real baseline verdict, so both have something to lose.
  await call('POST', '/remotes/app/connect');
  const probed = { ...(await stored(store, 'app')), baseline: { state: 'ok', fingerprint: 'f', missing: [], checkedAt: 'T' } };
  const { writeFile } = (await import('node:fs')).promises;
  const { join } = await import('node:path');
  await writeFile(join(store.dir, 'remotes', 'app.json'), JSON.stringify(probed, null, 2));

  const patched = await call('PATCH', '/remotes/app', { label: 'App', mirror: MIRROR });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.remote.mirror, MIRROR);
  assert.equal(patched.body.remote.enabled, true, 'the gate did not move');
  assert.equal(patched.body.remote.baseline.state, 'ok', 'and neither did the baseline verdict');
});

// PINS THE OTHER HALF: a CONFIG change still resets both, and carries the stored
// mirror through untouched while doing it.
test('a config change still resets the gate, and carries the stored mirror through', async (t) => {
  const { call, store } = await withApi(t);
  await call('POST', '/remotes', {
    remoteId: 'app', kind: 'docker', config: { container: 'a' }, mirror: MIRROR,
  });
  await call('POST', '/remotes/app/connect');
  assert.equal((await stored(store, 'app')).enabled, true);

  const patched = await call('PATCH', '/remotes/app', { config: { container: 'b' } });
  assert.equal(patched.body.remote.enabled, false, 'a different config may be a different target');
  assert.equal(patched.body.remote.baseline.state, 'unknown');
  assert.deepEqual(patched.body.remote.mirror, MIRROR, 'but the advertisement is not collateral');
});

// PINS THE makeRecord FIELD-LIST HAZARD: makeRecord rebuilds from a fixed list,
// so a field the PATCH handler does not carry through EXPLICITLY is silently
// dropped. The form always sends `mirror`, but a rename from any other client
// must not erase it.
test('a PATCH that omits mirror preserves the stored one', async (t) => {
  const { call, store } = await withApi(t);
  await call('POST', '/remotes', {
    remoteId: 'app', kind: 'docker', config: { container: 'a' }, mirror: MIRROR,
  });
  const patched = await call('PATCH', '/remotes/app', { label: 'Renamed' });
  assert.equal(patched.body.remote.label, 'Renamed');
  assert.deepEqual(patched.body.remote.mirror, MIRROR);
  assert.deepEqual((await stored(store, 'app')).mirror, MIRROR);
});

// PINS: the defaults the Advanced group prefills come from src/mirror.mjs over
// REST, so the frontend cannot grow a second copy of the list.
test('both catalog routes serve the mirror defaults, and cards carry the mirror', async (t) => {
  const { call } = await withApi(t);
  const expected = { root: DEFAULT_MIRROR.root, exclude: [...DEFAULT_MIRROR.exclude] };
  assert.deepEqual((await call('GET', '/kinds')).body.mirrorDefaults, expected);
  assert.deepEqual((await call('GET', '/remotes')).body.mirrorDefaults, expected);

  await call('POST', '/remotes', {
    remoteId: 'app', kind: 'docker', config: { container: 'a' }, mirror: MIRROR,
  });
  assert.deepEqual((await call('GET', '/remotes')).body.remotes[0].mirror, MIRROR,
    'the card carries it, so the edit form can pre-fill from the list response');
});
