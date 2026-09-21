// PINS THE MCP SURFACE: the `list_remotes` rendering, byte for byte, and the
// envelope contract around it.
//
// The rendering is the whole product of this tool — a caller sees the text and
// nothing else — so the tests below assert on exact lines rather than on
// "contains". Two invariants are singled out because neither is visible to a
// reviewer reading the renderer:
//
//  1. FIVE FIELDS AND NO MORE. A record carries a mirror root, a baseline
//     verdict, a docker identity, a schema and two timestamps, and none of them
//     belongs in a catalog listing. Asserted against PLANTED values, so a sixth
//     field added later fails here whatever it is called.
//  2. THE GATE SUPPRESSES THE PROBE. A gate-off remote's word is computed with
//     no `docker inspect` at all — asserted by COUNT on the stub's argv log,
//     which is the only way to tell "probed and ignored" from "not probed".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { renderRemotes } from '../src/mcp.mjs';
import { SCHEMA } from '../src/store.mjs';
import { stubDockerCli, withApi } from './helpers.mjs';

// What `docker inspect`'s format string answers for a RUNNING container:
// `{{.State.Running}} {{.Image}} {{.State.StartedAt}}`.
const RUNNING = 'true img 2026-09-01T00:00:00Z\n';
const STOPPED = 'false img 2026-09-01T00:00:00Z\n';

// A full record on disk, at the current schema. Every field a card carries is
// populated — the point of several tests below is what does NOT come out.
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

async function plant(store, ...records) {
  const dir = path.join(store.dir, 'remotes');
  await fs.mkdir(dir, { recursive: true });
  for (const rec of records) {
    await fs.writeFile(path.join(dir, `${rec.remoteId}.json`),
      `${JSON.stringify(rec, null, 2)}\n`);
  }
}

// A raw record file that is NOT valid JSON, so `readRemote` refuses it by name.
async function plantBroken(store, remoteId) {
  const dir = path.join(store.dir, 'remotes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${remoteId}.json`), '{ this is not json');
}

const listRemotes = (call) => call('POST', '/mcp', { tool: 'list_remotes', arguments: {} });

// ── The rendering ────────────────────────────────────────────────────

// PINS THE LINE FORMAT, BYTE FOR BYTE: field order, the two-space separator,
// the quoted label, store order, and NO TRAILING NEWLINE. A caller reads these
// lines; a change to any of them is a change to the tool's whole output.
test('one line per remote, in store order, with no trailing newline', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store,
    remoteRecord('app-ctr', { label: 'App container', config: { container: 'app' } }),
    remoteRecord('db', { label: 'Postgres', config: { container: 'pg' }, enabled: false }));

  const res = await listRemotes(call);
  assert.equal(res.status, 200);
  assert.equal(res.body.text, [
    'connected  app-ctr  docker  container=app  "App container"',
    'disabled  db  docker  container=pg  "Postgres"',
  ].join('\n'));
  assert.equal(res.body.text.endsWith('\n'), false, 'no trailing newline');
});

// PINS THAT THE IDENTIFYING FIELD IS RESOLVED PER KIND, not by a docker-shaped
// branch: an ssh remote's target is its `host`, under that name. A renderer
// that hardcoded `container=` passes the test above and fails this one.
test('a docker remote names its container, an ssh remote its host', async (t) => {
  const { call, store } = await withApi(t);
  await plant(store,
    remoteRecord('a-ctr', { kind: 'docker', label: 'C', config: { container: 'my-app' }, enabled: false }),
    remoteRecord('b-box', { kind: 'ssh', label: 'B', config: { host: 'my-box' }, enabled: false }));

  const { body } = await listRemotes(call);
  assert.deepEqual(body.text.split('\n'), [
    'disabled  a-ctr  docker  container=my-app  "C"',
    'disabled  b-box  ssh  host=my-box  "B"',
  ]);
});

// PINS "FIVE FIELDS AND NO MORE" — the invariant a reviewer cannot eyeball,
// because it is about what is ABSENT. Every other value the record carries is
// planted as a string nothing else would produce, and the rendering must
// contain none of them. A sixth field added later fails here whatever it is
// named and wherever it is placed.
test('the rendering leaks no other value the record carries', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store, remoteRecord('loud', {
    label: 'Loud',
    config: { container: 'app', user: 'planted-runas-identity' },
    mirror: { root: '/planted-mirror-root', exclude: ['/planted-exclude'] },
    baseline: {
      state: 'unsupported',
      fingerprint: 'planted-fingerprint',
      missing: ['planted-missing-tool'],
      checkedAt: '2026-04-04T04:04:04.004Z',
    },
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:06.000Z',
  }));

  const { body } = await listRemotes(call);
  assert.equal(body.text, 'connected  loud  docker  container=app  "Loud"');
  for (const planted of [
    'planted-runas-identity',    // docker's Run-as identity
    '/planted-mirror-root',      // the mirror advertisement
    '/planted-exclude',
    'unsupported',               // the baseline verdict
    'planted-fingerprint',
    'planted-missing-tool',
    '2026-04-04T04:04:04.004Z',  // every timestamp the record carries
    '2026-01-02T03:04:05.000Z',
    '2026-01-02T03:04:06.000Z',
    `"schema": ${SCHEMA}`,
  ]) {
    assert.equal(body.text.includes(planted), false,
      `the listing must not carry ${planted}`);
  }
  // The schema number on its own, in the one place it could plausibly land.
  assert.doesNotMatch(body.text, /schema/i);
});

// PINS THE EMPTY STATE AS TEXT. An empty store is a normal answer, not an empty
// body: a caller that got `""` could not tell it from a broken tool.
test('an empty store renders a sentence, not an empty string', async (t) => {
  const { call } = await withApi(t);
  const { body } = await listRemotes(call);
  assert.equal(body.text, 'no remotes are registered');
});

// ── The four status words ────────────────────────────────────────────

// One test per row of the derivation. Together they pin that the four words are
// DISTINGUISHABLE: collapsing any two of them loses a fact the caller acts on.

test('status `connected`: the gate is on and the target answers', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store, remoteRecord('r', { enabled: true }));
  const { body } = await listRemotes(call);
  assert.match(body.text, /^connected {2}r {2}/);
});

test('status `not connected`: the gate is on and the target does not answer', async (t) => {
  const stub = await stubDockerCli(t, { stdout: STOPPED });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store, remoteRecord('r', { enabled: true }));
  const { body } = await listRemotes(call);
  assert.match(body.text, /^not connected {2}r {2}/);
});

test('status `disabled`: the gate is off, whatever the target is doing', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store, remoteRecord('r', { enabled: false }));
  const { body } = await listRemotes(call);
  assert.match(body.text, /^disabled {2}r {2}/);
});

test('status `not readable`: the stored record did not parse', async (t) => {
  const { call, store } = await withApi(t);
  await plantBroken(store, 'bad-rec');
  const { body } = await listRemotes(call);
  // A remoteId and NOTHING ELSE — no other field of that record is known.
  assert.equal(body.text, 'not readable  bad-rec');
});

// PINS THE GLOSSARY RESERVATION as an assertion rather than a comment: the gate
// is never called "connected", so a gate-off remote's word must borrow no form
// of the verb. `disconnected` would read as a probe result and is exactly the
// collapse .wiki/gotchas/gate-versus-probe.md exists to prevent.
test('the gate-off word borrows no form of "connect"', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store, remoteRecord('r', { enabled: false }));
  const { body } = await listRemotes(call);
  const word = body.text.split('  ')[0];
  assert.doesNotMatch(word, /connect/i, `'${word}' collapses the gate into the probe`);
});

// ── The gate-off contrast ────────────────────────────────────────────

// PINS BOTH HALVES OF THE GATE-OFF BRANCH AT ONCE, which is what makes it a
// contrast rather than two weaker tests:
//
//   · the MCP tool renders no probe result AND RUNS NO PROBE — zero docker
//     invocations, so a `docker inspect` added "just to decide the word" fails
//     here even though the word would come out the same;
//   · `GET /api/remotes` still probes the same remote, which is the REST card's
//     "a switched-off card still shows reality" — this is the regression guard
//     on that, from the surface that deliberately does the opposite.
test('a gate-off remote is probed by the REST card and NOT by the MCP tool', async (t) => {
  const stub = await stubDockerCli(t, { answers: { stdout: RUNNING } });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store, remoteRecord('off', { label: 'Off', enabled: false }));

  const first = await listRemotes(call);
  assert.deepEqual(await stub.argv(), [],
    'the MCP tool must not invoke docker for a remote whose gate is off');

  // The same remote, with the target now UNREACHABLE: the rendered line is
  // byte-identical, because the gate-off branch never asked.
  await stub.setAnswer({ stdout: '', stderr: 'Error: No such object: app\n', exitCode: 1 });
  const second = await listRemotes(call);
  assert.equal(second.body.text, first.body.text);
  assert.equal(second.body.text, 'disabled  off  docker  container=app  "Off"');
  assert.deepEqual(await stub.argv(), [], 'still zero, after a second call');

  // And the REST surface DOES probe it — the contrast, and the reason the two
  // surfaces cannot share one option.
  const rest = await call('GET', '/remotes');
  assert.equal(rest.status, 200);
  assert.ok((await stub.argv()).includes('inspect'),
    'GET /api/remotes still probes a switched-off remote');
  assert.equal(rest.body.remotes[0].reachability.connected, false);
});

// ── Failure never fails the whole call ───────────────────────────────

// PINS that a probe that cannot even run is one remote's word, not the tool's
// failure — and that the transport's own error text (an ENOENT on a binary that
// does not exist) does not leak into a listing a model reads.
test('a probe that cannot run renders `not connected`, and the call is still 200', async (t) => {
  // withApi's default CLIs point at binaries that cannot exist.
  const { call, store } = await withApi(t);
  await plant(store, remoteRecord('broken-cli', { label: 'B', enabled: true }));

  const res = await listRemotes(call);
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'not connected  broken-cli  docker  container=app  "B"');
  assert.equal(res.body.text.includes('definitely-not-docker'), false);
  assert.doesNotMatch(res.body.text, /ENOENT|spawn/i);
});

// PINS that one unparseable record does not truncate the catalog. The whole
// point of a catalog is that it is complete; a listing silently one short is
// worse than one that says which record it could not read.
test('a malformed record beside good ones is a line, not an aborted list', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store,
    remoteRecord('a-ok', { label: 'A', enabled: true }),
    remoteRecord('z-ok', { label: 'Z', config: { container: 'zed' }, enabled: false }));
  await plantBroken(store, 'm-bad');

  const { body } = await listRemotes(call);
  assert.deepEqual(body.text.split('\n'), [
    'connected  a-ok  docker  container=app  "A"',
    'not readable  m-bad',
    'disabled  z-ok  docker  container=zed  "Z"',
  ]);
});

// ── Read-only ────────────────────────────────────────────────────────

// PINS `baseline: false` AS A REAL PROPERTY OF THE STORE, not of the code path:
// `cardFor`'s baseline refresh persists a moved verdict, and a catalog read
// must never write. Asserted on contents AND mtimes, because a rewrite with
// identical bytes is still a write.
test('listing writes nothing to the store', async (t) => {
  const stub = await stubDockerCli(t, { stdout: RUNNING });
  const { call, store } = await withApi(t, {}, { CODE_SYSTEM_DOCKER: JSON.stringify(stub.cli) });
  await plant(store,
    remoteRecord('one', { enabled: true }),
    remoteRecord('two', { enabled: false }));

  const dir = path.join(store.dir, 'remotes');
  const snapshot = async () => {
    const names = (await fs.readdir(dir)).sort();
    const out = [];
    for (const n of names) {
      const st = await fs.stat(path.join(dir, n));
      out.push([n, await fs.readFile(path.join(dir, n), 'utf8'), st.mtimeMs]);
    }
    return out;
  };
  const before = await snapshot();
  await listRemotes(call);
  await listRemotes(call);
  assert.deepEqual(await snapshot(), before);
});

// ── The envelope ─────────────────────────────────────────────────────

// PINS THE RAW-TEXT CHANNEL. The conductor's bridge unwraps `text` into raw,
// unescaped blocks and JSON-STRINGIFIES `result` — a `result` body would escape
// every newline of the rendering into one `\n`-littered block. `meta` is
// deliberately absent too: this tool has no metadata to send.
test('the success body is {text} — never {result}, and no meta', async (t) => {
  const { call, store } = await withApi(t);
  await plant(store, remoteRecord('r', { enabled: false }));
  const { body } = await listRemotes(call);
  assert.deepEqual(Object.keys(body), ['text']);
  assert.equal(typeof body.text, 'string');
});

// PINS THE STATUS CONTRACT: a malformed ENVELOPE is the only non-200. An
// unknown tool name is a normal MCP outcome the calling model reads and
// recovers from, not a transport failure.
test('an unknown tool is a 200 error body; a missing tool is the only 400', async (t) => {
  const { call, raw } = await withApi(t);

  const unknown = await call('POST', '/mcp', { tool: 'bogus', arguments: {} });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { error: 'unknown tool: bogus' });

  const missing = await call('POST', '/mcp', { arguments: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /tool/);

  const notAString = await call('POST', '/mcp', { tool: 42 });
  assert.equal(notAString.status, 400);

  // Express's own body-parser refusal, answered as JSON by the router tail.
  const malformed = await raw('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(malformed.status, 400);
  assert.ok((await malformed.json()).error, 'a JSON body even when express refused the request');
});

// PINS THAT `caller` IS ACCEPTED AND IGNORED. The conductor sends it on every
// forwarded call; a tool that read it would be scoping itself, and nothing in
// the bridge scopes a plugin's tools.
test('the conductor\'s caller envelope field is accepted and ignored', async (t) => {
  const { call, store } = await withApi(t);
  await plant(store, remoteRecord('r', { label: 'R', enabled: false }));
  const withCaller = await call('POST', '/mcp', {
    tool: 'list_remotes',
    arguments: {},
    caller: { sessionId: 'abc', project: 'somewhere' },
  });
  assert.equal(withCaller.status, 200);
  assert.equal(withCaller.body.text, 'disabled  r  docker  container=app  "R"');
});

// ── The renderer, directly ───────────────────────────────────────────

// PINS the empty-state and broken-record branches at the function's own level,
// so the rendering contract is assertable without standing up a server.
test('renderRemotes is a pure function of the cards it is given', () => {
  assert.equal(renderRemotes([]), 'no remotes are registered');
  assert.equal(
    renderRemotes([{ remoteId: 'x', broken: { reason: 'malformed', message: 'nope' } }]),
    'not readable  x');
  assert.equal(
    renderRemotes([{ remoteId: 'y', kind: 'ssh', label: 'Y', config: { host: 'h' }, enabled: true,
      reachability: { connected: true, detail: '', fingerprint: null } }]),
    'connected  y  ssh  host=h  "Y"');
});
