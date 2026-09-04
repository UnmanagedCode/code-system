// PINS the config store's contract: the schema round-trip, the remoteId
// charset (which is both a filename stem and the hand-off contract to cc), that
// a write is atomic and leaves no temp behind, that remotes are isolated from
// each other, that THERE IS NO CACHE, and that an unreadable record is refused
// by name and quarantined rather than guessed at or deleted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { migrate } from '../src/migrate.mjs';
import { quarantineDir, remotesDir } from '../src/paths.mjs';
import {
  SCHEMA, deleteRemote, isValidRemoteId, listRemotes, makeRecord, readRemote, writeRemote,
} from '../src/store.mjs';
import { tempStore } from './helpers.mjs';

async function withStore(t, fn) {
  const store = await tempStore();
  const before = process.env.CODE_SYSTEM_STORE;
  process.env.CODE_SYSTEM_STORE = store.dir;
  t.after(async () => {
    if (before === undefined) delete process.env.CODE_SYSTEM_STORE;
    else process.env.CODE_SYSTEM_STORE = before;
    await store.cleanup();
  });
  return fn(store.dir);
}

test('a record round-trips through the store unchanged', async (t) => {
  await withStore(t, async () => {
    const rec = makeRecord({ remoteId: 'app-ctr', kind: 'docker', label: 'App', config: { container: 'app' } });
    await writeRemote(rec);
    const back = await readRemote('app-ctr');
    assert.equal(back.ok, true);
    assert.deepEqual(back.record, rec);
    assert.equal(back.record.schema, SCHEMA);
    assert.equal(back.record.remoteId, 'app-ctr', 'the remoteId equals the filename stem');
  });
});

test('the remoteId charset is enforced, and "." / ".." are refused', () => {
  for (const ok of ['a', 'app-ctr', 'app.ctr', 'a_b', 'x9', '0abc', 'a'.repeat(64)]) {
    assert.equal(isValidRemoteId(ok), true, `${ok} should be valid`);
  }
  for (const bad of [
    '.', '..', '', 'A', 'Abc', '-lead', '.lead', 'has space', 'has/slash', 'a'.repeat(65),
    'x\n', 'ünicode', null, undefined, 42,
  ]) {
    assert.equal(isValidRemoteId(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test('writeRemote refuses an invalid remoteId rather than writing a file it cannot address', async (t) => {
  await withStore(t, async (dir) => {
    await assert.rejects(() => writeRemote({ remoteId: '../escape', kind: 'docker' }), /invalid remoteId/);
    await assert.rejects(() => writeRemote({ remoteId: '..', kind: 'docker' }), /invalid remoteId/);
    assert.deepEqual(await fs.readdir(dir).catch(() => []), [], 'nothing was created');
  });
});

test('a write is atomic and leaves no .tmp behind, on success or on failure', async (t) => {
  await withStore(t, async () => {
    await writeRemote(makeRecord({ remoteId: 'a', kind: 'docker', config: { container: 'a' } }));
    await writeRemote(makeRecord({ remoteId: 'a', kind: 'docker', config: { container: 'a2' } }));
    const files = await fs.readdir(remotesDir());
    assert.deepEqual(files, ['a.json'], 'no temp file survived');
    assert.equal((await readRemote('a')).record.config.container, 'a2', 'the rename installed the new content');
  });
});

test('remotes are isolated: one file per remote, and delete is an unlink', async (t) => {
  await withStore(t, async () => {
    await writeRemote(makeRecord({ remoteId: 'a', kind: 'docker', config: { container: 'a' } }));
    await writeRemote(makeRecord({ remoteId: 'b', kind: 'ssh', config: { host: 'b' } }));
    assert.equal((await listRemotes()).length, 2);
    assert.equal(await deleteRemote('a'), true);
    assert.equal(await deleteRemote('a'), false, 'deleting twice is not an error');
    const left = await listRemotes();
    assert.equal(left.length, 1);
    assert.equal(left[0].record.remoteId, 'b', "deleting one remote left the other's file alone");
  });
});

// THE MECHANISM behind "the launcher reads the store fresh": there is no cache
// to invalidate, so a value written by the backend is visible to the very next
// read IN THE SAME PROCESS. A memoising store would pass every other test here
// and fail this one.
test('there is no cache: a write is visible to the next read in the same process', async (t) => {
  await withStore(t, async () => {
    await writeRemote(makeRecord({ remoteId: 'a', kind: 'docker', config: { container: 'first' } }));
    assert.equal((await readRemote('a')).record.config.container, 'first');
    await writeRemote(makeRecord({ remoteId: 'a', kind: 'docker', config: { container: 'second' } }));
    assert.equal((await readRemote('a')).record.config.container, 'second');
    // And a write that bypasses the store entirely is picked up too — nothing
    // is held between calls.
    const p = path.join(remotesDir(), 'a.json');
    const raw = JSON.parse(await fs.readFile(p, 'utf8'));
    raw.config.container = 'third';
    await fs.writeFile(p, JSON.stringify(raw));
    assert.equal((await readRemote('a')).record.config.container, 'third');
  });
});

test('a record at another schema is refused BY NAME, never upgraded at read time', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true });
    await fs.writeFile(path.join(remotesDir(), 'future.json'),
      JSON.stringify({ schema: SCHEMA + 1, remoteId: 'future', kind: 'docker' }));
    const r = await readRemote('future');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema');
    // Anchored to the `stored at` clause: a bare `/schema N/` would also match
    // the refusal's own "…reads schema N only" tail.
    assert.match(r.message, new RegExp(`stored at schema ${SCHEMA + 1}`),
      'the refusal quotes the schema it FOUND, not the one it reads');
    assert.doesNotMatch(r.message, new RegExp(`stored at schema ${SCHEMA}\\b`),
      'and never reports the found schema as our own');
    assert.match(r.message, /backend/, 'and names the repair');
  });
});

test('an absent and a malformed record are distinguished, and neither throws', async (t) => {
  await withStore(t, async () => {
    assert.equal((await readRemote('ghost')).reason, 'absent');
    await fs.mkdir(remotesDir(), { recursive: true });
    await fs.writeFile(path.join(remotesDir(), 'junk.json'), '{not json');
    assert.equal((await readRemote('junk')).reason, 'malformed');
    // listRemotes SURFACES a broken record rather than showing a shorter list
    // than the user configured.
    const listed = await listRemotes();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].ok, false);
    assert.equal(listed[0].remoteId, 'junk');
  });
});

test('migrate quarantines what it cannot read, leaves good records alone, and is idempotent', async (t) => {
  await withStore(t, async () => {
    await writeRemote(makeRecord({ remoteId: 'good', kind: 'docker', config: { container: 'g' } }));
    await fs.writeFile(path.join(remotesDir(), 'junk.json'), '{not json');
    await fs.writeFile(path.join(remotesDir(), 'future.json'), JSON.stringify({ schema: SCHEMA + 1, remoteId: 'future' }));

    const first = await migrate();
    assert.equal(first.scanned, 3);
    assert.deepEqual(first.quarantined.map(q => q.remoteId).sort(), ['future', 'junk']);
    assert.equal((await readRemote('good')).ok, true, 'a readable record was untouched');
    assert.deepEqual(await fs.readdir(remotesDir()), ['good.json']);
    // NEVER DESTROYED — moved aside, so the user's configuration is recoverable.
    assert.equal((await fs.readdir(quarantineDir())).length, 2);

    const second = await migrate();
    assert.deepEqual(second.quarantined, [], 'running it again is a no-op');
    assert.equal(second.scanned, 1);
  });
});
