// PINS the derived readFile/writeFile: that the far-side scripts really work
// against a POSIX shell (round-trip, ranges, atomic, exclusive, mode), that
// every failure is normalised to the strerror tail cc's callers branch on, that
// EFBIG is refused BEFORE a byte is transferred, that `isBinary` describes the
// RETURNED RANGE rather than the file, and that both ends chunk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CHUNK_BYTES, MAX_FILE_BYTES } from '../src/launcher/protocol.mjs';
import { buildReadScript, buildWriteScript, makeNonce, readFileOp, writeFileOp } from '../src/launcher/fileops.mjs';
import { PROBE_SCRIPT } from '../src/baseline.mjs';
import { makeRunner } from '../src/launcher/run.mjs';
import { createHostTransport } from '../src/launcher/kinds/host.mjs';
import { FAKE_TRANSPORT, Launcher, record, tempStore, writeRecord } from './helpers.mjs';

// The real plumbing, against a real POSIX shell on a temp dir. Deterministic,
// local, no network — and it is what proves the SCRIPTS are right rather than
// just the host-side parse.
const run = makeRunner(createHostTransport({}), {}, null);

// A canned far side, for the classification paths that have no local analogue.
const canned = (code, stderr, stdout = '') => async () => ({ code, stdout: Buffer.from(stdout), stderr });

async function withDir(t) {
  const store = await tempStore();
  t.after(() => store.cleanup());
  return store.dir;
}

test('write then read round-trips, including UTF-8 and a payload past one chunk', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'note.txt');
  await writeFileOp(run, { path: p, data: Buffer.from('hello — héllo\n') });
  assert.equal(await fs.readFile(p, 'utf8'), 'hello — héllo\n');
  const r = await readFileOp(run, { path: p });
  assert.equal(r.data.toString('utf8'), 'hello — héllo\n');
  assert.equal(r.size, Buffer.byteLength('hello — héllo\n'), 'size describes the WHOLE file');
  assert.equal(r.mode, (await fs.stat(p)).mode, 'mode is the raw stat(2) mode, type bits and all');
  assert.equal(r.isBinary, false);

  const big = path.join(dir, 'big.bin');
  const payload = Buffer.from('x'.repeat(CHUNK_BYTES * 3 + 17));
  await writeFileOp(run, { path: big, data: payload });
  assert.equal((await readFileOp(run, { path: big })).data.length, payload.length);
});

test('a ranged read is bounded, and offset+length address the right bytes', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'r.txt');
  await fs.writeFile(p, 'abcdefghij');
  assert.equal((await readFileOp(run, { path: p, length: 3 })).data.toString(), 'abc');
  assert.equal((await readFileOp(run, { path: p, offset: 4 })).data.toString(), 'efghij');
  assert.equal((await readFileOp(run, { path: p, offset: 2, length: 3 })).data.toString(), 'cde');
  // The whole file's size, regardless of the range returned.
  assert.equal((await readFileOp(run, { path: p, offset: 2, length: 3 })).size, 10);
  // An offset past the end is an empty answer, not an error.
  assert.equal((await readFileOp(run, { path: p, offset: 99 })).data.length, 0);
  await fs.writeFile(path.join(dir, 'empty'), '');
  assert.equal((await readFileOp(run, { path: path.join(dir, 'empty') })).data.length, 0);
});

test('isBinary describes the RETURNED RANGE, not the file', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'mixed.bin');
  // Text first, a NUL well past the head.
  await fs.writeFile(p, Buffer.concat([Buffer.from('plain text'), Buffer.alloc(1), Buffer.from('tail')]));
  assert.equal((await readFileOp(run, { path: p, length: 5 })).isBinary, false,
    'a ranged read answers about that range');
  assert.equal((await readFileOp(run, { path: p })).isBinary, true,
    'and the whole file finds the NUL');
});

test('a read above the per-file cap is EFBIG, refused BEFORE any transfer', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'small');
  await fs.writeFile(p, 'small');
  await assert.rejects(
    () => readFileOp(run, { path: p, length: MAX_FILE_BYTES + 1 }),
    (e) => e.code === 'EFBIG',
  );
  // The refusal is in the script itself, so no payload was ever produced.
  const script = buildReadScript({ path: p, length: MAX_FILE_BYTES + 1 });
  const res = await run({ script });
  assert.notEqual(res.code, 0);
  assert.equal(res.stdout.length, 0, 'not a byte of the file reached stdout');
});

test('a write above the per-file cap is EFBIG', async (t) => {
  const dir = await withDir(t);
  await assert.rejects(
    () => writeFileOp(run, { path: path.join(dir, 'never'), data: Buffer.alloc(MAX_FILE_BYTES + 1) }),
    (e) => e.code === 'EFBIG',
  );
  assert.equal(await fs.stat(path.join(dir, 'never')).then(() => 'exists', () => 'absent'), 'absent');
});

test('read failures carry the FS code cc branches on', async (t) => {
  const dir = await withDir(t);
  await assert.rejects(() => readFileOp(run, { path: path.join(dir, 'nope') }), (e) => e.code === 'ENOENT');
  await assert.rejects(() => readFileOp(run, { path: dir }), (e) => e.code === 'EISDIR');
  const broken = path.join(dir, 'broken');
  await fs.symlink(path.join(dir, 'gone'), broken);
  await assert.rejects(() => readFileOp(run, { path: broken }), (e) => e.code === 'ENOENT',
    'a broken symlink is ENOENT, matching fs.stat with -L');
  if (process.getuid?.() !== 0) {
    const locked = path.join(dir, 'locked');
    await fs.writeFile(locked, 'secret');
    await fs.chmod(locked, 0o000);
    try {
      await assert.rejects(() => readFileOp(run, { path: locked }), (e) => e.code === 'EACCES');
    } finally { await fs.chmod(locked, 0o600); }
  }
});

test('write failures carry the FS code cc branches on', async (t) => {
  const dir = await withDir(t);
  const data = Buffer.from('x');
  await assert.rejects(
    () => writeFileOp(run, { path: path.join(dir, 'no', 'such', 'dir', 'f'), data }),
    (e) => e.code === 'ENOENT', 'a missing parent is ENOENT');
  await fs.writeFile(path.join(dir, 'afile'), 'x');
  await assert.rejects(
    () => writeFileOp(run, { path: path.join(dir, 'afile', 'under'), data }),
    (e) => e.code === 'ENOTDIR', 'a parent that is a file is ENOTDIR');
  await assert.rejects(
    () => writeFileOp(run, { path: dir, data }),
    (e) => e.code === 'EISDIR', 'writing over a directory is EISDIR');
});

test('exclusive fails EEXIST rather than overwriting, and atomic overwrites', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'x.txt');
  await writeFileOp(run, { path: p, data: Buffer.from('first'), exclusive: true });
  await assert.rejects(
    () => writeFileOp(run, { path: p, data: Buffer.from('second'), exclusive: true }),
    (e) => e.code === 'EEXIST');
  assert.equal(await fs.readFile(p, 'utf8'), 'first', 'the refusal left the file alone');
  await writeFileOp(run, { path: p, data: Buffer.from('third'), atomic: true });
  assert.equal(await fs.readFile(p, 'utf8'), 'third', 'an atomic write ends in a rename, which overwrites');
});

test('atomic and exclusive together are refused — the pair has no honest meaning', async (t) => {
  const dir = await withDir(t);
  await assert.rejects(
    () => writeFileOp(run, { path: path.join(dir, 'p'), data: Buffer.from('x'), atomic: true, exclusive: true }),
    /mutually exclusive/);
});

test('an atomic write creates the parent and PRESERVES mode through the rename', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'made', 'up', 'script.sh');
  await writeFileOp(run, { path: p, data: Buffer.from('#!/bin/sh\n'), mode: 0o100755, atomic: true });
  assert.equal((await fs.stat(p)).mode & 0o777, 0o755,
    'without the chmod-before-rename an edited script silently stops being executable');
  assert.deepEqual(await fs.readdir(path.dirname(p)), ['script.sh'], 'no temp file survived the rename');
});

test('a plain write PRESERVES an existing file\'s mode, matching fs.writeFile', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'keepmode');
  await fs.writeFile(p, 'old');
  await fs.chmod(p, 0o751);
  await writeFileOp(run, { path: p, data: Buffer.from('new') });
  assert.equal(await fs.readFile(p, 'utf8'), 'new');
  assert.equal((await fs.stat(p)).mode & 0o777, 0o751,
    'routing a plain write through temp+rename would silently reset this');
});

test('every strerror tail maps to its code, and an unmatched one is EUNKNOWN carrying the raw stderr', async () => {
  const table = [
    ['stat: cannot statx: No such file or directory', 'ENOENT'],
    ["open '/x': Permission denied", 'EACCES'],
    ['/x: File exists', 'EEXIST'],
    ["find: '/p/.': Not a directory", 'ENOTDIR'],
    ['read /x: Is a directory', 'EISDIR'],
    ['write: No space left on device', 'ENOSPC'],
    ['something nobody has a table row for', 'EUNKNOWN'],
  ];
  for (const [stderr, code] of table) {
    await assert.rejects(
      () => readFileOp(canned(1, stderr), { path: '/x' }),
      (e) => {
        assert.equal(e.code, code, `${stderr} → ${code}`);
        assert.equal(e.stderr, stderr, 'the raw stderr is carried verbatim, never a guess');
        return true;
      });
  }
});

test('an unreadable header from the far side is EUNKNOWN, never parsed as success', async () => {
  await assert.rejects(
    () => readFileOp(canned(0, '', 'garbage from a login banner\n'), { path: '/x' }),
    (e) => e.code === 'EUNKNOWN');
});

// BOTH ENDS MUST CHUNK: a payload riding as one large frame breaches the line
// ceiling and dies EPROTO mid-transfer. Asserted on the WIRE, through the real
// launcher, because the chunking is the frame loop's job.
test('a read past one chunk is delivered as multiple data frames', async (t) => {
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('alpha'));
  const p = path.join(store.dir, 'big.bin');
  const payload = Buffer.from('y'.repeat(CHUNK_BYTES * 2 + 5));
  await fs.writeFile(p, payload);

  const l = new Launcher(['--kind', 'fake'], {
    CODE_SYSTEM_STORE: store.dir, CODE_SYSTEM_FAKE_TRANSPORT: FAKE_TRANSPORT,
  });
  t.after(() => l.kill());
  await l.hello();
  l.send({ type: 'readFile', id: 'r1', remoteId: 'alpha', path: p });
  await l.waitFor(f => f.type === 'end' && f.id === 'r1');

  const chunks = l.frames.filter(f => f.type === 'data' && f.id === 'r1');
  assert.equal(chunks.length, 3, `${payload.length} bytes at ${CHUNK_BYTES} per frame`);
  for (const c of chunks.slice(0, -1)) {
    assert.equal(Buffer.from(c.dataB64, 'base64').length, CHUNK_BYTES);
  }
  const got = Buffer.concat(chunks.map(c => Buffer.from(c.dataB64, 'base64')));
  assert.deepEqual(got, payload, 'and the pieces reassemble to the file');
  const head = l.frames.find(f => f.type === 'readFileResult' && f.id === 'r1');
  assert.equal(head.size, payload.length);
  assert.deepEqual(chunks.map(c => c.seq), [0, 1, 2], 'seq is monotonic per id');
});

// PINS THE ATOMICITY of `exclusive`. The pre-check (`[ -e "$p" ]`) plus a
// separate truncating redirect is check-then-act: a writer creating the target
// in between would be TRUNCATED rather than refused, which is exactly the lost
// update the flag exists to prevent. `set -C` is what closes that window.
//
// The window itself is microseconds wide and cannot be driven deterministically
// from outside the script, so this pins the guard in the two ways that CAN be
// checked without flake: that the generated script really is guarded, and that
// the guard really works on the shell we run it with.
test('the exclusive write is guarded by set -C, not only by the pre-check', () => {
  const script = buildWriteScript({ path: '/tmp/x', exclusive: true, nonce: 'n0' });
  const guard = script.indexOf('set -C');
  const redirect = script.indexOf('base64 -d > "$p"');
  assert.notEqual(guard, -1, 'the exclusive branch must set noclobber');
  assert.ok(guard < redirect, 'and must set it BEFORE the redirect it protects');
  // The plain branch must NOT be guarded — a plain write overwrites by design.
  const plain = buildWriteScript({ path: '/tmp/x', nonce: 'n0' });
  assert.equal(plain.includes('set -C'), false);
});

test('the shell we run scripts with really honours noclobber', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'guarded');
  await fs.writeFile(p, 'ORIGINAL');
  // Exactly the construct the exclusive branch relies on. If a future /bin/sh
  // stopped honouring `set -C`, `exclusive` would silently become a truncating
  // write and this is the test that would say so.
  const res = await run({ script: `set -C; printf 'CLOBBERED' > ${JSON.stringify(p)}` });
  assert.notEqual(res.code, 0, 'noclobber refused the redirect');
  assert.equal(await fs.readFile(p, 'utf8'), 'ORIGINAL', 'and nothing was truncated');
});

test('exclusive refuses EEXIST and leaves the existing file byte-identical', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'raced.txt');
  const racing = async (req) => {
    // NOT a race simulation: this creates the target before the script runs, so
    // it is the `[ -e "$p" ]` PRE-CHECK that fires. The real window — a writer
    // appearing between that check and the redirect — is microseconds wide and
    // is covered structurally by the two tests above. See docs/protocol.md →
    // "What `exclusive` does and does not guarantee".
    await fs.writeFile(p, 'WINNER');
    return run(req);
  };
  await assert.rejects(
    () => writeFileOp(racing, { path: p, data: Buffer.from('loser'), exclusive: true }),
    (e) => e.code === 'EEXIST');
  assert.equal(await fs.readFile(p, 'utf8'), 'WINNER',
    "the loser must not have truncated the winner's file");
});

test('exclusive still creates the file when it genuinely does not exist', async (t) => {
  const dir = await withDir(t);
  const p = path.join(dir, 'fresh.txt');
  await writeFileOp(run, { path: p, data: Buffer.from('made'), exclusive: true, mode: 0o100640 });
  assert.equal(await fs.readFile(p, 'utf8'), 'made');
  assert.equal((await fs.stat(p)).mode & 0o777, 0o640, 'and honours mode on the way');
});

// PINS that our own refusals are classified by OUR tag, not by matching a
// strerror tail anywhere in stderr — because the scripts interpolate the
// requested path into their own failure text, and cc's callers branch on the
// resulting codes.
test('a path containing a strerror tail cannot spoof the classification', async (t) => {
  const dir = await withDir(t);
  // The path itself says "Is a directory". It is a MISSING FILE.
  const poison = path.join(dir, 'Is a directory');
  await assert.rejects(
    () => readFileOp(run, { path: poison }),
    (e) => {
      assert.equal(e.code, 'ENOENT', 'a free-text match would have said EISDIR here');
      return true;
    });

  // The same trap on the write side, where the parent is missing.
  await assert.rejects(
    () => writeFileOp(run, { path: path.join(dir, 'File exists', 'x'), data: Buffer.from('x') }),
    (e) => e.code === 'ENOENT');

  // And a real directory named after a DIFFERENT tail still reads EISDIR.
  const realDir = path.join(dir, 'No such file or directory');
  await fs.mkdir(realDir);
  await assert.rejects(() => readFileOp(run, { path: realDir }), (e) => e.code === 'EISDIR');
});

test('the tag is stripped from the stderr we report to cc', async (t) => {
  const dir = await withDir(t);
  await assert.rejects(
    () => readFileOp(run, { path: path.join(dir, 'absent') }),
    (e) => {
      assert.equal(/CCERR/.test(e.stderr ?? ''), false, 'our plumbing marker is not shown to a user');
      assert.match(e.stderr, /No such file or directory/, 'but the POSIX tail is kept');
      return true;
    });
});

// PINS THE SCRIPT-GENERATION ESCAPE, which is load-bearing for the nonce
// mechanism and easy to break invisibly.
//
// A `\n` written with one backslash inside a JS template literal is a REAL
// newline, so the generated `printf` format ends up spanning lines. `sh` treats
// the two forms identically, so every behavioural test still passes — but the
// tag line stops being a line, and a reader cannot see which form is in the
// source. (This regressed once during development and nothing caught it.)
test('no generated script puts a raw newline inside a printf format', () => {
  const scripts = [
    ['read', buildReadScript({ path: '/tmp/x', nonce: 'n1' })],
    ['read-ranged', buildReadScript({ path: '/tmp/x', offset: 4, length: 9, nonce: 'n1' })],
    ['write-plain', buildWriteScript({ path: '/tmp/x', nonce: 'n1' })],
    ['write-mode', buildWriteScript({ path: '/tmp/x', mode: 0o100644, nonce: 'n1' })],
    ['write-atomic', buildWriteScript({ path: '/tmp/x', atomic: true, mode: 0o100755, tmpPath: '/tmp/x.tmp', nonce: 'n1' })],
    ['write-exclusive', buildWriteScript({ path: '/tmp/x', exclusive: true, nonce: 'n1' })],
    ['probe', PROBE_SCRIPT],
  ];
  for (const [name, script] of scripts) {
    // A single-quoted format string that never closes before end-of-line.
    for (const line of script.split('\n')) {
      const opens = (line.match(/printf '/g) ?? []).length;
      if (opens === 0) continue;
      const quotes = (line.match(/'/g) ?? []).length;
      assert.equal(quotes % 2, 0,
        `${name}: a printf format is left open at end of line — that is a raw newline inside it:\n${line}`);
    }
    assert.equal(/printf '[^']*\n/.test(script), false,
      `${name}: a printf format contains a raw newline`);
  }

  // NEGATIVE CONTROL: the same predicate against the broken form, so this test
  // proves it DISCRIMINATES rather than merely passing. The first is what the
  // bug produced; the second is what the fixed source produces.
  // Both forms are derived from the REAL builder, so there is no hand-written
  // escaping here to get wrong.
  const fixed = buildReadScript({ path: '/tmp/x', nonce: 'n1' })
    .split('\n').find(l => l.includes("printf 'CCERR"));
  assert.ok(fixed, 'the read script emits a tagged refusal line');
  // The broken form is that same line with its \n escapes turned into real
  // newlines — exactly what the one-backslash template-literal bug produced.
  const broken = fixed.split(String.raw`\n`).join('\n');
  assert.notEqual(broken, fixed, 'the two controls really differ');
  assert.equal(/printf '[^']*\n/.test(broken), true, 'the predicate catches a raw newline');
  assert.equal(/printf '[^']*\n/.test(fixed), false, 'and passes the escaped form');
  assert.equal((broken.split('\n')[0].match(/'/g) ?? []).length % 2, 1,
    'and the unbalanced-quote check catches it too');
});

// PINS THE PROPERTY THAT MAKES THE TAG UNFORGEABLE, which is otherwise
// accidental. A path cannot contain a nonce that did not exist when the path was
// chosen — cc fixes the path in its request frame, and the nonce is generated
// per call afterwards. The mechanism becomes forgeable the moment a nonce is
// reused across calls or hoisted to module scope.
test('the nonce is fresh per call and never reused', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const n = makeNonce();
    assert.match(n, /^[0-9a-f]{12}$/, 'hex, and long enough that guessing is infeasible');
    assert.equal(seen.has(n), false, 'a repeated nonce would make the tag forgeable');
    seen.add(n);
  }
  // And the builders really do default to a fresh one rather than a constant.
  const a = buildReadScript({ path: '/tmp/x' });
  const b = buildReadScript({ path: '/tmp/x' });
  assert.notEqual(a, b, 'two builds of the same request must not share a nonce');
});
