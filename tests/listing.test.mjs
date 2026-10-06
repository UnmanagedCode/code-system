// PINS REMOTE ENUMERATION (`listRemotes` → `remoteList`, systems-protocol.md
// §2.2) for the store-backed kinds.
//
// The membership rule is the CONFIGURED SET: an id is listed iff the store's
// configuration routes to it — a readable record at the current schema, of this
// launcher's kind, switched on. That is the same predicate `lookup` refuses
// ENOREMOTE with BEFORE any attempt, so these tests drive the real launcher over
// pipes and hold the listing against what a request for each id is answered.
// Reachability is never consulted: a stopped container stays listed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  FAKE_TRANSPORT, Launcher, record, stubDockerCli, stubSshCli, tempStore, writeRecord,
} from './helpers.mjs';

function fakeEnv(storeDir) {
  return { CODE_SYSTEM_STORE: storeDir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT };
}

async function launch(t, args, env) {
  const l = new Launcher(args, env);
  t.after(() => l.kill());
  await l.hello();
  return l;
}

// One `listRemotes`, answered by its terminal frame for that id.
async function list(l, id) {
  l.send({ type: 'listRemotes', id });
  return l.waitFor(f => f.id === id && (f.type === 'remoteList' || f.type === 'error'));
}

const idsOf = (frame) => {
  assert.equal(frame.type, 'remoteList', `expected a remoteList, got ${JSON.stringify(frame)}`);
  return frame.remotes.map(r => r.remoteId);
};

// PINS THAT THE LISTING AND THE CONFIGURATION REFUSAL ARE ONE PREDICATE. For
// every record file in a store mixing each way a record can fail configuration,
// an `exec` naming it is refused ENOREMOTE exactly when it is NOT listed — so a
// `list()` and a `lookup()` that drift apart (one forgets the gate, the kind
// check, the schema) red here. `tooling` fails the BASELINE, which is not
// configuration: it is listed, and its `exec` is refused EUNKNOWN, not
// ENOREMOTE. The frame itself names no remote, so this also proves it is not
// routed through `lookup`, which would refuse it for naming none.
test('listRemotes lists exactly the configured ids, by the same predicate that routes a request', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const dir = path.join(store.dir, 'remotes');
  await writeRecord(store.dir, record('on'));
  await writeRecord(store.dir, record('off', { enabled: false }));
  await writeRecord(store.dir, record('other', { kind: 'docker' }));
  await writeRecord(store.dir, record('tooling', {
    baseline: {
      state: 'unsupported',
      fingerprint: 'fake:1',
      missing: [{ capability: 'readDir', probe: 'find -printf', detail: 'find: unrecognized: -printf' }],
      checkedAt: '2026-09-03T00:00:00.000Z',
    },
  }));
  await writeRecord(store.dir, record('old', { schema: 1 }));
  await fs.writeFile(path.join(dir, 'broken.json'), '{ not json');
  await fs.writeFile(path.join(dir, 'Bad Name.json'), JSON.stringify(record('Bad Name')));
  await fs.writeFile(path.join(dir, '.hidden.json'), JSON.stringify(record('.hidden')));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'not a record');
  await fs.writeFile(path.join(dir, 'on.json.123.0.tmp'), JSON.stringify(record('tmp')));

  const l = await launch(t, ['--kind', 'fake'], fakeEnv(store.dir));
  const answer = await list(l, 'l1');
  assert.equal(answer.type, 'remoteList', `answered ${JSON.stringify(answer)}`);
  assert.equal(answer.id, 'l1', 'addressed to the request');
  const listed = idsOf(answer);
  assert.deepEqual([...listed].sort(), ['on', 'tooling']);
  for (const entry of answer.remotes) {
    assert.deepEqual(Object.keys(entry), ['remoteId'], 'an entry carries remoteId only');
  }

  const stems = (await fs.readdir(dir)).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5));
  for (const [i, stem] of stems.entries()) {
    const id = `e${i}`;
    l.send({ type: 'exec', id, remoteId: stem, cwd: '/tmp', argv: ['printf', 'ran'] });
    const end = await l.waitFor(f => f.id === id && (f.type === 'exit' || f.type === 'error'));
    assert.equal(listed.includes(stem), end.code !== 'ENOREMOTE',
      `'${stem}' is ${listed.includes(stem) ? '' : 'not '}listed, and its exec ended ${JSON.stringify(end)}`);
  }
});

// PINS THE NO-CACHE PROPERTY for the listing, in ONE launcher process: each
// answer is a fresh read of the configuration (§2.2 — "each answer is a
// snapshot"), so the operator gate reaches it on the very next frame.
test('the listing follows the gate on the very next frame, with no restart', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('on'));
  await writeRecord(store.dir, record('stays'));
  const l = await launch(t, ['--kind', 'fake'], fakeEnv(store.dir));

  assert.deepEqual(idsOf(await list(l, 'l1')), ['on', 'stays']);
  await writeRecord(store.dir, record('on', { enabled: false }));
  assert.deepEqual(idsOf(await list(l, 'l2')), ['stays'], 'switched off: out of the configured set');
  await writeRecord(store.dir, record('on', { enabled: true }));
  assert.deepEqual(idsOf(await list(l, 'l3')), ['on', 'stays'], 'switched back on: listed again');
});

// PINS "nothing configured" as a VALID EMPTY ANSWER, not a failure: an empty
// list is legal (§2.2), and an absent remotes directory is the state a fresh
// install is in.
test('an absent or empty store lists remotes: [], never an error', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const l = await launch(t, ['--kind', 'fake'], fakeEnv(store.dir));

  const absent = await list(l, 'l1');
  assert.equal(absent.type, 'remoteList', `absent directory answered ${JSON.stringify(absent)}`);
  assert.deepEqual(absent.remotes, []);

  await fs.mkdir(path.join(store.dir, 'remotes'));
  const empty = await list(l, 'l2');
  assert.equal(empty.type, 'remoteList');
  assert.deepEqual(empty.remotes, []);
});

// PINS ALL-OR-NOTHING (§2.2): a configuration that cannot be read answers an
// id-addressed EUNKNOWN with the reason — never a partial or empty list, which
// cc could not tell from a true one, and never an id-less error, which would
// tear down every other target's work. The remotes path being a regular file
// makes `readdir` fail ENOTDIR deterministically, even as root.
test('a store that cannot be enumerated answers id-addressed EUNKNOWN, never a partial list', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  const dir = path.join(store.dir, 'remotes');
  await fs.writeFile(dir, 'not a directory');
  const l = await launch(t, ['--kind', 'fake'], fakeEnv(store.dir));

  const err = await list(l, 'l1');
  assert.equal(err.type, 'error', `answered ${JSON.stringify(err)}`);
  assert.equal(err.id, 'l1', 'ID-ADDRESSED — an id-less error is connection-level');
  assert.equal(err.code, 'EUNKNOWN');
  assert.match(err.message, /could not enumerate/);
  assert.match(err.message, /not a directory/i, 'the reason rides message');

  // The SAME launcher still serves, so the refusal took nothing down.
  await fs.rm(dir);
  await writeRecord(store.dir, record('on'));
  assert.deepEqual(idsOf(await list(l, 'l2')), ['on']);
  assert.equal(l.frames.filter(f => f.id === 'l1').length, 1, 'exactly one terminal frame for the refused id');
});

// PINS THAT COMPOSING THE LIST ATTEMPTS NO TARGET (§2.2: reachability is "not
// consulted"), on the two shipped kinds, by COUNT on each stub CLI's argv log.
// Each launcher lists its own kind only. Then the docker half makes the
// listed container UNREACHABLE — the daemon answers "No such container" — and
// shows the exec refused ENOREMOTE (a reachability refusal) while the id stays
// listed: reachability is a per-operation outcome, not membership.
test('listRemotes on docker and ssh lists from the store, runs no CLI, and keeps an unreachable target', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('ctr', { kind: 'docker', config: { container: 'app' } }));
  await writeRecord(store.dir, record('ctr-off', { kind: 'docker', config: { container: 'app' }, enabled: false }));
  await writeRecord(store.dir, record('box', { kind: 'ssh', config: { host: 'box' } }));

  const docker = await stubDockerCli(t, {
    execStdout: '', execExitCode: 1, execStderr: 'Error response from daemon: No such container: app\n',
  });
  const ssh = await stubSshCli(t);

  const dl = await launch(t, ['--kind', 'docker'], {
    CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_DOCKER: JSON.stringify(docker.cli), CODE_SYSTEM_CHANNEL: '0',
  });
  const sl = await launch(t, ['--kind', 'ssh'], {
    CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_SSH: JSON.stringify(ssh.cli), TMPDIR: store.dir,
  });

  assert.deepEqual(idsOf(await list(dl, 'l1')), ['ctr']);
  assert.deepEqual(idsOf(await list(sl, 'l1')), ['box']);
  assert.deepEqual(await docker.argv(), [], 'the docker listing ran no docker command');
  assert.deepEqual(await ssh.argv(), [], 'the ssh listing ran no ssh command');

  dl.send({ type: 'exec', id: 'e1', remoteId: 'ctr', cwd: '/', argv: ['true'] });
  const refused = await dl.waitFor(f => f.id === 'e1' && (f.type === 'exit' || f.type === 'error'));
  assert.equal(refused.code, 'ENOREMOTE', `the gone container is a reachability refusal: ${JSON.stringify(refused)}`);
  assert.notDeepEqual(await docker.argv(), [], 'and that refusal came from attempting the target');
  assert.deepEqual(idsOf(await list(dl, 'l2')), ['ctr'], 'an unreachable configured target stays listed');
});
