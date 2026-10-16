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
import { remoteIdDefect } from '../src/launcher/protocol.mjs';
import {
  MAX_RECORD_DEPTH, SCHEMA, deleteRemote, isValidRemoteId, listRemoteIds, listRemotes, makeRecord, readRemote, writeRemote,
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

// PINS THAT EVERY ID THE LAUNCHER CAN LIST IS ONE cc ACCEPTS BACK. A listed
// id cc refuses fails the WHOLE `remoteList` (systems-protocol.md §2.2), and the
// launcher lists only stems `readRemote` accepts — so the store's charset must
// sit inside cc's `remoteIdDefect`. Widening REMOTE_ID_RE past cc's rule (a
// space, a control character, more than REMOTE_ID_MAX characters) reds this.
test('every id the store accepts is one cc accepts as a Remote', () => {
  for (let cp = 0; cp <= 0xffff; cp++) {
    const c = String.fromCharCode(cp);
    for (const id of [c, `a${c}`, `a${c}b`]) {
      if (isValidRemoteId(id)) {
        assert.equal(remoteIdDefect(id), null, `the store accepts ${JSON.stringify(id)}, cc does not`);
      }
    }
  }
  for (let n = 1; n <= 300; n++) {
    const id = 'a'.repeat(n);
    if (isValidRemoteId(id)) assert.equal(remoteIdDefect(id), null, `length ${n}`);
  }
});

// PINS the enumeration the launcher's listing reads: every `*.json` stem,
// valid or not (deciding that is `readRemote`'s job), an absent directory as
// "nothing configured", and any OTHER failure thrown rather than read as empty
// — a store that cannot be enumerated must never pass for an empty one.
test('listRemoteIds reads every .json stem, answers [] for an absent directory, and throws otherwise', async (t) => {
  await withStore(t, async (dir) => {
    assert.deepEqual(await listRemoteIds(), [], 'no remotes directory yet');

    await fs.mkdir(path.join(dir, 'remotes'));
    for (const name of ['b.json', 'a.json', 'Bad Name.json', 'notes.txt', 'c.json.123.0.tmp']) {
      await fs.writeFile(path.join(dir, 'remotes', name), '{}');
    }
    assert.deepEqual(await listRemoteIds(), ['Bad Name', 'a', 'b']);

    await fs.rm(path.join(dir, 'remotes'), { recursive: true });
    await fs.writeFile(path.join(dir, 'remotes'), 'not a directory');
    await assert.rejects(() => listRemoteIds(), (e) => e.code === 'ENOTDIR');
  });
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

// PINS `mirror`'s place in the record: a TOP-LEVEL field beside `enabled`,
// defaulting to null (opted out), and carried through verbatim when supplied.
// makeRecord rebuilds from a fixed field list, so a field left off its
// destructure is SILENTLY DROPPED — the hazard that once switched a remote off
// on every rename.
test('makeRecord defaults mirror to null and carries a supplied one through verbatim', () => {
  const bare = makeRecord({ remoteId: 'a', kind: 'docker', config: { container: 'c' } });
  assert.equal(bare.mirror, null, 'a remote that did not opt in advertises nothing');
  assert.equal(bare.schema, 2, 'the mirror field arrived with schema 2');

  const mirror = { root: '/', exclude: ['/proc', '/dev', '/sys'] };
  const withMirror = makeRecord({ remoteId: 'a', kind: 'docker', config: {}, mirror });
  assert.deepEqual(withMirror.mirror, mirror, 'not dropped, not reshaped, not reordered');
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

// ── the schema 1 → 2 upgrade ─────────────────────────────────────────
//
// A schema-1 record predates `mirror` and advertised nothing, so the upgrade
// writes `mirror: null` — the same "I advertise nothing" it already had. The
// pass runs BEFORE the quarantine branch and reads raw JSON itself, because
// readRemote refuses schema 1 with reason 'schema', which is a quarantine
// reason: ordered the other way, every existing remote would be moved aside
// instead of upgraded.

// A schema-1 record as this store used to write one: everything the current
// readers expect, minus `mirror`.
const schema1 = (remoteId, over = {}) => ({
  schema: 1,
  remoteId,
  kind: 'docker',
  label: 'Legacy',
  config: { container: 'app' },
  enabled: true,
  baseline: { state: 'ok', fingerprint: 'f', missing: [], checkedAt: '2026-01-01T00:00:00.000Z' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

// PINS THE UPGRADE ITSELF: the schema moves, `mirror: null` appears, and NOTHING
// ELSE changes. An upgrade that quietly reset the gate or the baseline would
// switch off every remote an operator had connected.
test('a schema-1 record is upgraded in place, gaining mirror:null and nothing else', async (t) => {
  await withStore(t, async () => {
    const before = schema1('legacy');
    await fs.mkdir(remotesDir(), { recursive: true });
    await fs.writeFile(path.join(remotesDir(), 'legacy.json'), JSON.stringify(before, null, 2));

    const r = await migrate();
    assert.deepEqual(r.upgraded, ['legacy']);
    assert.deepEqual(r.quarantined, [], 'an upgradable record is never quarantined');

    const read = await readRemote('legacy');
    assert.equal(read.ok, true, 'and it reads at the current schema afterwards');
    assert.deepEqual(read.record, { ...before, schema: 2, mirror: null });
  });
});

// PINS IDEMPOTENCE WITH NO MARKER FILE: the "already applied" self-check is the
// store's own contents, so a second run must not rewrite a byte.
test('running migrate twice upgrades once and leaves the file untouched', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true });
    const file = path.join(remotesDir(), 'legacy.json');
    await fs.writeFile(file, JSON.stringify(schema1('legacy'), null, 2));

    assert.deepEqual((await migrate()).upgraded, ['legacy']);
    const afterFirst = await fs.readFile(file, 'utf8');

    const second = await migrate();
    assert.deepEqual(second.upgraded, [], 'the second run upgrades nothing');
    assert.deepEqual(second.quarantined, []);
    assert.equal(await fs.readFile(file, 'utf8'), afterFirst, 'and rewrites no bytes');
  });
});

// PINS THAT THE UPGRADE IS EXACT-VERSION, and that adding it did not swallow the
// quarantine branch: a record from the future is still moved aside, and a
// malformed one still is too rather than throwing at backend boot.
test('a future schema and a malformed record are still quarantined, not upgraded', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true });
    await fs.writeFile(path.join(remotesDir(), 'future.json'),
      JSON.stringify({ ...schema1('future'), schema: 3 }));
    await fs.writeFile(path.join(remotesDir(), 'junk.json'), '{not json');

    const r = await migrate();
    assert.deepEqual(r.upgraded, [], 'neither is at schema 1');
    assert.deepEqual(r.quarantined.map(q => q.remoteId).sort(), ['future', 'junk']);
    assert.deepEqual(await fs.readdir(remotesDir()), []);
  });
});

// PINS THE GUARD THAT WOULD OTHERWISE CRASH BACKEND BOOT: writeRemote addresses
// the file BY the record's remoteId, so rewriting a record whose id does not
// match its filename would write the wrong file — or throw on an unaddressable
// id, inside the pass that runs before the server listens.
test('a schema-1 record whose remoteId does not match its filename is quarantined, not rewritten', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true });
    await fs.writeFile(path.join(remotesDir(), 'alpha.json'),
      JSON.stringify(schema1('../escape')));

    const r = await migrate();
    assert.deepEqual(r.upgraded, []);
    assert.deepEqual(r.quarantined.map(q => q.remoteId), ['alpha']);
    assert.deepEqual(await fs.readdir(remotesDir()), [], 'and nothing was written under another name');
  });
});

// ── the pass must not take the backend down with one record ──────────
//
// server.mjs awaits migrate() BEFORE listen, and the backend IS the operator's
// repair tool: a throw here means no UI and no API for every OTHER remote, and
// no way to fix the one that caused it.

// PINS THE UPGRADE WRITE'S GUARD, and — the sharper half — that a record we
// could not rewrite is LEFT ALONE rather than quarantined. It is still at
// schema 1, which readRemote refuses with a quarantine reason, so an unguarded
// fall-through would move aside a record the next boot upgrades cleanly.
test('an upgrade that cannot be written is logged, and the record is left for the next boot', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true });
    const file = path.join(remotesDir(), 'legacy.json');
    const before = JSON.stringify(schema1('legacy'), null, 2);
    await fs.writeFile(file, before);
    // Readable and listable, not writable: readFile and readdir still work, so
    // the pass gets all the way to the write and fails only there.
    await fs.chmod(remotesDir(), 0o500);

    // MEASURED, NEVER ASSUMED. Root ignores the mode bits, and so do some
    // filesystems — and a test that answered that by skipping would assert
    // NOTHING and still report green, which is the one failure mode this repo
    // refuses for its environment-dependent suites (see the ssh suite's
    // prove-by-count). So the precondition is probed, and BOTH branches assert.
    const probe = path.join(remotesDir(), '.writable-probe');
    const enforced = await fs.writeFile(probe, 'x').then(
      async () => { await fs.rm(probe, { force: true }); return false; },
      () => true);

    const lines = [];
    let r;
    // Restored INSIDE the body, not in a `t.after`: withStore's own cleanup hook
    // registered first and would `rm -rf` an unwritable directory before ours
    // ran.
    try { r = await migrate({ log: m => lines.push(m) }); }
    finally { await fs.chmod(remotesDir(), 0o700); }

    if (!enforced) {
      // The guard itself is unreachable here. Assert the half that still holds
      // — the pass completes and upgrades — and say loudly why the rest did not
      // run, so a green line in this environment is not read as coverage.
      t.diagnostic('mode 0500 did not stop a write (running as root?):'
        + ' the upgrade-write guard was NOT exercised by this run');
      assert.deepEqual(r.upgraded, ['legacy'], 'migrate still completes and upgrades');
      assert.ok(lines.some(l => /upgraded remote 'legacy' schema 1 → 2/.test(l)),
        `and logs it: ${JSON.stringify(lines)}`);
      return;
    }

    assert.deepEqual(r.upgraded, [], 'nothing claims to have been upgraded');
    assert.deepEqual(r.quarantined, [], 'and NOTHING was moved aside');
    assert.ok(lines.some(l => /could not upgrade remote 'legacy'/.test(l)),
      `the failure is logged, naming the record: ${JSON.stringify(lines)}`);
    assert.equal(await fs.readFile(file, 'utf8'), before, 'the record is byte-identical');
  });
});

// PINS THE QUARANTINE MOVE'S GUARD, and that the loop CONTINUES past it: the
// failing record sorts first, and the schema-1 record after it is still
// upgraded in the same run.
test('a quarantine move that fails is logged, and the rest of the store is still processed', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true });
    await fs.writeFile(path.join(remotesDir(), 'aaa-junk.json'), '{not json');
    await fs.writeFile(path.join(remotesDir(), 'zzz-legacy.json'),
      JSON.stringify(schema1('zzz-legacy'), null, 2));
    // A regular FILE where the quarantine directory belongs, so mkdir refuses.
    // Deterministic, and it does not depend on who is running the suite.
    await fs.mkdir(path.dirname(quarantineDir()), { recursive: true });
    await fs.writeFile(quarantineDir(), 'not a directory');

    const lines = [];
    const r = await migrate({ log: m => lines.push(m) });

    assert.deepEqual(r.quarantined, [], 'the move did not happen, and is not claimed');
    assert.ok(lines.some(l => /could not quarantine remote 'aaa-junk'/.test(l)),
      `the failure is logged, naming the record: ${JSON.stringify(lines)}`);
    assert.deepEqual(await fs.readFile(path.join(remotesDir(), 'aaa-junk.json'), 'utf8'), '{not json',
      'and the record stays where it is — still refused by name at every read');
    assert.deepEqual(r.upgraded, ['zzz-legacy'],
      'the record AFTER the failure was still processed: one bad file is not a dead pass');
  });
});

// PINS that the records directory ends up private even when it already existed
// with looser bits (mkdir's mode applies only on creation), since records can
// hold a password.
test('writeRemote tightens a pre-existing records directory to 0700', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true, mode: 0o755 });
    await fs.chmod(remotesDir(), 0o755);
    assert.equal((await fs.stat(remotesDir())).mode & 0o777, 0o755, 'precondition: it starts loose');
    await writeRemote(makeRecord({ remoteId: 'a', kind: 'docker', config: { container: 'c' }, enabled: false }));
    assert.equal((await fs.stat(remotesDir())).mode & 0o777, 0o700);
    // And the startup pass does the same for a directory no write has touched.
    await fs.chmod(remotesDir(), 0o755);
    await migrate();
    assert.equal((await fs.stat(remotesDir())).mode & 0o777, 0o700);
  });
});

// PINS that a tightening chmod the store cannot perform is a logged warning, not
// a rejection — `migrate()` runs at backend boot and must not stop it starting —
// while the records dir stays usable. (chmod is made to fail by a stub: a real
// failure needs a foreign-owned directory or a mode-less filesystem.)
test('a records-dir chmod that fails warns and carries on', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true, mode: 0o755 });
    await fs.chmod(remotesDir(), 0o755);
    const warnings = [];
    t.mock.method(console, 'warn', (m) => warnings.push(String(m)));
    t.mock.method(fs, 'chmod', async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); });
    await migrate();
    await writeRemote(makeRecord({ remoteId: 'a', kind: 'docker', config: { container: 'c' }, enabled: false }));
    assert.equal(warnings.length, 1, 'warned once for the directory, not per write');
    assert.match(warnings[0], /could not be made private/);
    assert.equal((await readRemote('a')).ok, true, 'the write still landed');
  });
});

// ── records the readers must refuse by name ──────────────────────────

// A record file whose `config` nests `levels` objects deep, as TEXT: a record
// this deep cannot be built with JSON.stringify, which is the point.
const deepRecordText = (remoteId, levels) => {
  const head = JSON.stringify({ schema: SCHEMA, remoteId, kind: 'docker', label: 'deep', enabled: false, mirror: null });
  return `${head.slice(0, -1)},"config":${'{"k":'.repeat(levels)}"leaf"${'}'.repeat(levels)}}`;
};

// PINS THE DEPTH REFUSAL AND ITS BOUND. A record that parses but nests past
// MAX_RECORD_DEPTH is refused as 'too-deep' — the case measured at 5 000 levels,
// which parsed but could not be re-serialised and failed the whole listing —
// and the bound sits exactly where the constant says (the record object is level 1,
// `config` level 2, its leaf one past the last object).
test('readRemote refuses a record nested past MAX_RECORD_DEPTH as too-deep', async (t) => {
  await withStore(t, async () => {
    await fs.mkdir(remotesDir(), { recursive: true });
    const write = (id, levels) => fs.writeFile(path.join(remotesDir(), `${id}.json`), deepRecordText(id, levels));
    await write('huge', 5000);
    await write('at-limit', MAX_RECORD_DEPTH - 2);
    await write('over-limit', MAX_RECORD_DEPTH - 1);

    const huge = await readRemote('huge');
    assert.equal(huge.ok, false);
    assert.equal(huge.reason, 'too-deep');
    assert.equal(huge.message, `remote 'huge' nests deeper than ${MAX_RECORD_DEPTH} levels`);
    assert.equal((await readRemote('over-limit')).reason, 'too-deep');
    assert.equal((await readRemote('at-limit')).ok, true, 'a record at the bound reads');
    assert.equal(MAX_RECORD_DEPTH, 32);
  });
});

// PINS THAT A RECORD IS ADDRESSED BY ITS FILENAME. A copy of off-up.json saved
// as evil.json would otherwise read as a second `off-up`, and every action on
// its card — Delete included — would reach the real one.
test('readRemote refuses a record whose remoteId is not its filename as id-mismatch', async (t) => {
  await withStore(t, async () => {
    await writeRemote(makeRecord({ remoteId: 'off-up', kind: 'docker', label: 'real', config: { container: 'c' } }));
    const real = await fs.readFile(path.join(remotesDir(), 'off-up.json'), 'utf8');
    await fs.writeFile(path.join(remotesDir(), 'evil.json'), real);

    const evil = await readRemote('evil');
    assert.equal(evil.ok, false);
    assert.equal(evil.reason, 'id-mismatch');
    assert.match(evil.message, /^remote 'evil' is stored as evil\.json but its record names remoteId "off-up"/);
    assert.equal((await readRemote('off-up')).ok, true, 'the real record is untouched');
    const listed = await listRemotes();
    assert.deepEqual(listed.map(e => [e.ok ? e.record.remoteId : e.remoteId, e.ok, e.reason]),
      [['evil', false, 'id-mismatch'], ['off-up', true, undefined]], 'one record per file, each under its own name');
  });
});

// PINS what the migrate comment promises: the startup pass moves both refusals
// aside (never deletes them), and leaves the real record where it is.
test('the startup pass quarantines too-deep and id-mismatch records, and nothing else', async (t) => {
  await withStore(t, async () => {
    await writeRemote(makeRecord({ remoteId: 'off-up', kind: 'docker', label: 'real', config: { container: 'c' } }));
    await fs.writeFile(path.join(remotesDir(), 'evil.json'), await fs.readFile(path.join(remotesDir(), 'off-up.json'), 'utf8'));
    await fs.writeFile(path.join(remotesDir(), 'huge.json'), deepRecordText('huge', 5000));

    const r = await migrate();
    assert.deepEqual(r.quarantined.map(q => [q.remoteId, q.reason]), [['evil', 'id-mismatch'], ['huge', 'too-deep']]);
    assert.deepEqual(await fs.readdir(remotesDir()), ['off-up.json']);
    const aside = await fs.readdir(quarantineDir());
    assert.equal(aside.length, 2, 'moved aside, not deleted');
    assert.equal((await readRemote('off-up')).record.label, 'real');
  });
});
