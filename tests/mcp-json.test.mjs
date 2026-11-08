// PINS THE `list_remotes` JSON VIEW (`format: "json"`) and the format dispatch
// around it. Every reply goes through `checkReply`, so each test also proves
// its reply is contract-shaped and valid against the manifest's outputSchema.
//
// The text view's own tests are tests/mcp.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { migrate } from '../src/migrate.mjs';
import { SCHEMA } from '../src/store.mjs';
import { stubDockerCli, stubSshCli, withApi } from './helpers.mjs';
import { checkReply } from './_mcpContract.mjs';

const RUNNING = 'true img 2026-09-01T00:00:00Z\n';
const STOPPED = 'false img 2026-09-01T00:00:00Z\n';

function remoteRecord(remoteId, over = {}) {
  return {
    schema: SCHEMA,
    remoteId,
    kind: 'docker',
    label: remoteId,
    config: { container: 'app' },
    enabled: true,
    mirror: null,
    baseline: { state: 'unknown', fingerprint: null, missing: [], checkedAt: null },
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...over,
  };
}

const remotesDir = store => path.join(store.dir, 'remotes');

async function plantRaw(store, name, text) {
  await fs.mkdir(remotesDir(store), { recursive: true });
  await fs.writeFile(path.join(remotesDir(store), `${name}.json`), text);
}
const plant = async (store, ...records) => {
  for (const rec of records) await plantRaw(store, rec.remoteId, `${JSON.stringify(rec, null, 2)}\n`);
};

async function listRemotes(call, format) {
  const res = await call('POST', '/mcp', {
    tool: 'list_remotes', arguments: {}, ...(format === undefined ? {} : { format }),
  });
  checkReply('list_remotes', format, res.status, res.body);
  return res;
}
const remotesOf = async (call) => (await listRemotes(call, 'json')).body.structured.remotes;
const dockerEnv = stub => ({ CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });

// Invariant: a caller that predates `format` (the running old cc) keeps working,
// and text is prose, not JSON.
test('no format is the text view, byte-identical to format "text"', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, dockerEnv(stub));
  await plant(store, remoteRecord('a'), remoteRecord('b', { enabled: false }));
  const bare = await listRemotes(call);
  const text = await listRemotes(call, 'text');
  assert.deepEqual(bare.body, text.body);
  assert.deepEqual(Object.keys(bare.body), ['text']);
  assert.throws(() => JSON.parse(bare.body.text));
});

// Invariant: json is the typed channel only — `{structured}`, never `{text}`.
test('json replies are {structured} only, valid for a docker and an ssh record', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, dockerEnv(stub));
  await plant(store,
    remoteRecord('d', { config: { container: 'app', user: 'root' } }),
    remoteRecord('s', { kind: 'ssh', enabled: false, config: { host: 'box', port: 22, user: 'me' } }));
  const res = await listRemotes(call, 'json');
  assert.deepEqual(Object.keys(res.body), ['structured']);
  assert.equal(res.body.structured.remotes.length, 2);
});

// Invariant: an unknown format is refused, and the offending value travels in
// `details`, never in the message.
test('an unknown format is FORMAT_UNKNOWN with the value in details', async (t) => {
  const { call } = await withApi(t);
  for (const format of ['xml', 'JSON', null, 42]) {
    const res = await listRemotes(call, format);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      error: 'format must be "text" or "json"',
      code: 'FORMAT_UNKNOWN',
      details: { format, accepted: ['text', 'json'] },
    });
    assert.equal(res.body.error.includes(String(format)), false);
  }
});

// Invariant: the five-field cap never returns to json — every field the text
// view summarises away is carried at its json path.
test('json carries what the text view summarises away', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, dockerEnv(stub));
  const baseline = {
    state: 'unsupported', fingerprint: 'planted-fingerprint', missing: ['planted-missing-tool'],
    checkedAt: '2026-04-04T04:04:04.004Z',
  };
  const mirror = { root: '/planted-mirror-root', exclude: ['/planted-exclude'] };
  await plant(store,
    remoteRecord('loud', {
      label: 'Loud', config: { container: 'app', user: 'planted-runas-identity' }, mirror, baseline,
      createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-01-02T03:04:06.000Z',
    }),
    remoteRecord('ssh1', {
      kind: 'ssh', enabled: false, config: { host: 'box', port: 2222, user: 'planted-login' },
    }));
  const [loud, ssh] = await remotesOf(call);
  assert.equal(loud.config.user, 'planted-runas-identity');
  assert.deepEqual(loud.mirror, mirror);
  assert.deepEqual(loud.baseline, baseline);
  assert.equal(loud.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(loud.updatedAt, '2026-01-02T03:04:06.000Z');
  assert.deepEqual(loud.target, { field: 'container', value: 'app' });
  assert.equal(loud.reachability.connected, true);
  assert.equal(typeof loud.reachability.detail, 'string');
  assert.ok(loud.reachability.detail.length > 0, 'the probe detail is carried');
  assert.equal(typeof loud.reachability.fingerprint, 'string', 'the probe fingerprint is carried');
  assert.equal(ssh.config.port, 2222);
  assert.equal(ssh.config.user, 'planted-login');
  assert.deepEqual(ssh.target, { field: 'host', value: 'box' });
});

// Invariant: json lists every record, uncapped and in store order.
test('json has no row cap and keeps store order', async (t) => {
  const { call, store } = await withApi(t);
  const ids = Array.from({ length: 60 }, (_, i) => `r${String(i).padStart(2, '0')}`);
  for (const id of ids) {
    if (id === 'r07' || id === 'r33') await plantRaw(store, id, '{ not json');
    else await plant(store, remoteRecord(id, { enabled: false }));
  }
  const remotes = await remotesOf(call);
  assert.equal(remotes.length, 60);
  assert.deepEqual(remotes.map(r => r.remoteId), ids);
  assert.deepEqual(remotes.filter(r => r.status === 'not readable').map(r => r.remoteId), ['r07', 'r33']);
});

// Invariant: json restores what text drops for a broken record — the reason and message.
test('a broken record carries its reason and message', async (t) => {
  const { call, store } = await withApi(t);
  await plantRaw(store, 'a-malformed', '{ not json');
  await plantRaw(store, 'b-old', JSON.stringify({ schema: 1, remoteId: 'b-old' }));
  await plantRaw(store, 'c-copy', JSON.stringify(remoteRecord('original')));
  const remotes = await remotesOf(call);
  assert.deepEqual(remotes.map(r => [r.remoteId, r.status, r.reason]), [
    ['a-malformed', 'not readable', 'malformed'],
    ['b-old', 'not readable', 'schema'],
    ['c-copy', 'not readable', 'id-mismatch'],
  ]);
  for (const r of remotes) assert.equal(typeof r.message, 'string');
});

// Invariant: the gate suppresses the probe in json too.
test('a gate-off remote is not probed and has reachability null', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, dockerEnv(stub));
  await plant(store, remoteRecord('off', { enabled: false }));
  const [r] = await remotesOf(call);
  assert.equal(r.reachability, null);
  assert.equal(r.enabled, false);
  assert.equal(r.status, 'disabled');
  assert.deepEqual(await stub.argv(), []);
});

// Invariant: the probe is carried and the status word matches it.
for (const [word, stdout, connected] of [['connected', RUNNING, true], ['not connected', STOPPED, false]]) {
  test(`a gate-on remote whose target answers "${word}" reports that probe`, async (t) => {
    const stub = await stubDockerCli(t, { stdout });
    const { call, store } = await withApi(t, {}, dockerEnv(stub));
    await plant(store, remoteRecord('on'));
    const [r] = await remotesOf(call);
    assert.equal(r.status, word);
    assert.equal(r.reachability.connected, connected);
    assert.equal(r.enabled, true);
  });
}

// Invariant: the config allowlist withholds by default — a kind with no card
// exposes no config key and no target.
test('an unregistered kind exposes no config and no target', async (t) => {
  const { call, store } = await withApi(t);
  await plant(store,
    remoteRecord('h', { kind: 'host', config: { container: 'ghost' }, enabled: false }),
    remoteRecord('w', { kind: 'weird', config: { container: 'ghost' }, enabled: true }));
  const remotes = await remotesOf(call);
  assert.equal(remotes.length, 2);
  for (const r of remotes) {
    assert.equal(r.target, null);
    assert.deepEqual(r.config, {});
    assert.deepEqual(r.withheld, ['container']);
  }
  assert.equal(JSON.stringify(remotes).includes('ghost'), false);
});

// Invariant: every older stored shape the store can still load validates, with
// absent keys null, so cc's runtime check never fails the listing.
test('the oldest loadable record shapes validate with absent keys null', async (t) => {
  const { call, store } = await withApi(t);
  // (a) a schema-1 record, upgraded by the real migration: no `enabled`.
  const old = remoteRecord('a-old', { schema: 1 });
  delete old.enabled; delete old.mirror;
  await plantRaw(store, 'a-old', JSON.stringify(old));
  await migrate();
  // (b) a gate-era schema-2 record: no `mirror`.
  const gate = remoteRecord('b-gate');
  delete gate.mirror;
  await plant(store, gate);
  // (c) the minimal hand-written record.
  await plant(store, { schema: SCHEMA, remoteId: 'c-min' });

  const remotes = await remotesOf(call);
  assert.deepEqual(remotes.map(r => r.remoteId), ['a-old', 'b-gate', 'c-min']);
  const [a, b, c] = remotes;
  assert.equal(a.enabled, false);
  assert.equal(a.status, 'disabled');
  assert.equal(a.mirror, null);
  assert.equal(b.mirror, null);
  assert.equal(b.enabled, true, 'b-gate carries enabled: true');
  for (const key of ['kind', 'label', 'target', 'reachability', 'mirror', 'baseline', 'createdAt', 'updatedAt']) {
    assert.equal(c[key], null, key);
  }
  assert.equal(c.enabled, false);
  assert.equal(c.status, 'disabled');
  assert.deepEqual(c.config, {});
  assert.deepEqual(c.withheld, []);
});

// Invariant: one hand-edited record cannot fail the whole listing — file-sourced
// values are carried verbatim, whatever their type.
test('wrong-typed file values are carried verbatim and the call is 200', async (t) => {
  const { call, store } = await withApi(t);
  await plant(store,
    remoteRecord('fine', { enabled: false }),
    remoteRecord('odd', { kind: 42, label: ['x'], createdAt: {}, config: 'str', enabled: false }));
  const res = await listRemotes(call, 'json');
  assert.equal(res.status, 200);
  const odd = res.body.structured.remotes.find(r => r.remoteId === 'odd');
  assert.equal(odd.kind, 42);
  assert.deepEqual(odd.label, ['x']);
  assert.deepEqual(odd.createdAt, {});
  assert.deepEqual(odd.config, {});
  assert.equal(res.body.structured.remotes.length, 2);
  // And the text view survives it too.
  await listRemotes(call, 'text');
});

// Invariant: a credential-bearing field never reaches either view — including
// through the probe `detail`, where ssh echoes the key path. Run once per
// credential kind, because the stub's stderr stands for what ssh would echo for
// THAT record.
for (const [name, field, secret, echo] of [
  ['password', 'password', 'pw-PLANTED-hunter2', 'pw-PLANTED-hunter2'],
  ['key path', 'identityFile', '/keys/PLANTED_id_ed25519',
    'Warning: Identity file /keys/PLANTED_id_ed25519 not accessible: No such file or directory.'],
]) {
  test(`an ssh ${name} reaches neither view, probe detail included`, async (t) => {
    const stub = await stubSshCli(t, { checkExit: 255, checkStderr: `${echo}\\n` });
    const { call, store } = await withApi(t, {}, { CODE_SYSTEM_SSH: JSON.stringify(stub.cli) });
    const config = (host, extra) => ({ host, user: 'dev', [field]: secret, token: 'tok-PLANTED', ...extra });
    await plant(store,
      remoteRecord('off', { kind: 'ssh', enabled: false, config: config('h1') }),
      remoteRecord('on', { kind: 'ssh', enabled: true, config: config('h2') }));
    const json = await listRemotes(call, 'json');
    const text = await listRemotes(call, 'text');
    for (const body of [json.body, text.body]) {
      const dump = JSON.stringify(body);
      for (const planted of [secret, 'tok-PLANTED']) {
        assert.equal(dump.includes(planted), false, `${planted} must not be carried`);
      }
    }
    for (const r of json.body.structured.remotes) {
      assert.ok(r.withheld.includes(field), `${r.remoteId} names ${field}`);
      assert.ok(r.withheld.includes('token'));
      assert.equal(field in r.config, false);
      assert.equal('token' in r.config, false);
      assert.equal(r.config.user, 'dev');
    }
    const on = json.body.structured.remotes.find(r => r.remoteId === 'on');
    // NON-VACUOUS: the stub's stderr really reached the detail, scrubbed.
    assert.equal(on.reachability.connected, false);
    assert.ok(on.reachability.detail.includes('[withheld]'), on.reachability.detail);
  });
}

// Invariant: an empty store is a normal answer in both views.
test('an empty store is {remotes: []} in json and a sentence in text', async (t) => {
  const { call } = await withApi(t);
  assert.deepEqual((await listRemotes(call, 'json')).body, { structured: { remotes: [] } });
  assert.equal((await listRemotes(call, 'text')).body.text, 'no remotes are registered');
});
