// PINS the backend REST surface card 2026-0005 renders: remote CRUD with the
// kind owning its own config validation, that `remoteId` is never renamed, and
// that deleting a remote WARNS about the cc projects still naming it — which is
// the concrete discharge of .wiki/gotchas/no-remote-discovery.md, since cc
// cannot enumerate remotes on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApi } from '../src/api.mjs';
import { SCHEMA } from '../src/store.mjs';
import { fakeConductor, tempStore } from './helpers.mjs';

async function withApi(t, deps = {}) {
  const store = await tempStore();
  const before = process.env.CODE_SYSTEM_STORE;
  const beforeDocker = process.env.CODE_SYSTEM_DOCKER;
  process.env.CODE_SYSTEM_STORE = store.dir;
  // A card render asks each remote's kind for LIVE reachability, and `docker`'s
  // now really runs `docker inspect`. Pointed at an invocation that cannot
  // exist, so this suite answers the same on a machine with docker and on one
  // without — and never touches a real container that happens to share a name.
  process.env.CODE_SYSTEM_DOCKER = '["/definitely-not-docker-xyz"]';
  const app = express();
  app.use('/api', createApi(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    if (before === undefined) delete process.env.CODE_SYSTEM_STORE;
    else process.env.CODE_SYSTEM_STORE = before;
    if (beforeDocker === undefined) delete process.env.CODE_SYSTEM_DOCKER;
    else process.env.CODE_SYSTEM_DOCKER = beforeDocker;
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
  return { call, store };
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
