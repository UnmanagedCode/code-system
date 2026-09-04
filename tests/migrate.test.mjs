// PINS THE SCHEMA 1 → 2 UPGRADE, which is the single most dangerous change in
// card 2026-0005.
//
// `readRemote` refuses any record whose `schema !== SCHEMA` with reason
// `'schema'`, and `'schema'` is in migrate.mjs's QUARANTINE_REASONS. So bumping
// SCHEMA without adding an upgrade pass BEFORE the quarantine branch would move
// EVERY EXISTING REMOTE ASIDE — the user's whole configuration gone from the UI
// (recoverably; quarantine never deletes, but the cards vanish). The first test
// below is the trap: it fails both when the upgrade is missing entirely and
// when it is ordered after the quarantine branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { migrate } from '../src/migrate.mjs';
import { quarantineDir, remotesDir } from '../src/paths.mjs';
import { SCHEMA, readRemote } from '../src/store.mjs';
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

// A schema-1 record exactly as the shipped store wrote it: no `enabled` field,
// because the gate did not exist. Written raw, since no current writer can
// produce it any more.
async function writeSchema1(id, over = {}) {
  await fs.mkdir(remotesDir(), { recursive: true });
  const rec = {
    schema: 1,
    remoteId: id,
    kind: 'docker',
    label: 'App container',
    config: { container: 'app' },
    baseline: { state: 'ok', fingerprint: 'docker:sha256:abc:2026-09-01T00:00:00Z', missing: [], checkedAt: '2026-09-01T00:00:00.000Z' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...over,
  };
  await fs.writeFile(path.join(remotesDir(), `${id}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

// PINS: an existing remote is UPGRADED IN PLACE, never quarantined — and the
// gate it gains is OFF, which is the ruled default for a remote nobody has
// connected yet. A missing upgrade pass, or one ordered after the quarantine
// branch, empties the user's remotes directory instead.
test('a schema-1 record is UPGRADED to the current schema, never quarantined', async (t) => {
  await withStore(t, async () => {
    const before = await writeSchema1('app-ctr');

    const res = await migrate();
    assert.equal(res.scanned, 1);
    assert.equal(res.upgraded, 1, 'the record was upgraded');
    assert.deepEqual(res.quarantined, [], 'and NOT moved aside');

    // The quarantine directory is not merely empty — it was never created.
    await assert.rejects(fs.readdir(quarantineDir()), /ENOENT/,
      'quarantining a record we can upgrade would strand the user\'s configuration');

    const r = await readRemote('app-ctr');
    assert.equal(r.ok, true, 'and it reads at the current schema afterwards');
    assert.equal(r.record.schema, SCHEMA);
    assert.equal(r.record.enabled, false,
      'the operator gate defaults OFF: an existing remote comes up switched off and is connected by hand');

    // EVERYTHING ELSE SURVIVES. An upgrade that rebuilt the record from
    // defaults would silently discard the user's label, config and history.
    assert.equal(r.record.remoteId, before.remoteId);
    assert.equal(r.record.kind, before.kind);
    assert.equal(r.record.label, before.label);
    assert.deepEqual(r.record.config, before.config);
    assert.deepEqual(r.record.baseline, before.baseline);
    assert.equal(r.record.createdAt, before.createdAt);
  });
});

// PINS: the migration's "already applied" self-check is the store's own
// contents. A second pass must not touch a byte — a migration that rewrote
// every record on every startup would churn `updatedAt` and re-run the upgrade
// against its own output.
test('the upgrade is idempotent — a second pass changes nothing', async (t) => {
  await withStore(t, async () => {
    await writeSchema1('app-ctr');
    await migrate();
    const after = await fs.readFile(path.join(remotesDir(), 'app-ctr.json'), 'utf8');

    const second = await migrate();
    assert.equal(second.upgraded, 0, 'nothing left to upgrade');
    assert.deepEqual(second.quarantined, []);
    assert.equal(await fs.readFile(path.join(remotesDir(), 'app-ctr.json'), 'utf8'), after,
      'byte-identical after the second pass');
  });
});

// PINS: the upgrade did not swallow the quarantine branch. A record that is
// genuinely unreadable — not merely at an older schema — is still moved aside,
// and a record at a schema FROM THE FUTURE is too, because we cannot know what
// it means.
test('a malformed record, and one from the future, are still quarantined', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true });
    await fs.writeFile(path.join(remotesDir(), 'junk.json'), '{not json');
    await fs.writeFile(path.join(remotesDir(), 'future.json'),
      JSON.stringify({ schema: SCHEMA + 1, remoteId: 'future' }));
    await writeSchema1('good');

    const res = await migrate();
    assert.equal(res.upgraded, 1);
    assert.deepEqual(res.quarantined.map(q => q.remoteId).sort(), ['future', 'junk']);
    assert.deepEqual(await fs.readdir(remotesDir()), ['good.json']);
    assert.equal((await fs.readdir(quarantineDir())).length, 2, 'moved aside, never destroyed');
  });
});

// PINS: an upgrade is a WRITE, and a half-written record is unreadable
// configuration. It must go through the store's atomic write like every other
// one — a truncate-then-write would leave an empty file behind a crash.
test('the upgrade leaves no temp file behind', async (t) => {
  await withStore(t, async () => {
    await writeSchema1('app-ctr');
    await migrate();
    const names = await fs.readdir(remotesDir());
    assert.deepEqual(names, ['app-ctr.json'], 'no .tmp survives the upgrade');
  });
});
