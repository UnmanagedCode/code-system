// PINS the mirror advertisement's ONE validator (src/mirror.mjs), which stands
// at the store's front door so a bad path is a 400 in the operator's form rather
// than cc's MIRROR_ADVERTISEMENT_INVALID (502) at session start.
//
// The rules mirror cc's own (`$CC_CHECKOUT/src/systems/mirror.ts`,
// `validateAdvertisement` / `normalAbsolute`) deliberately, so these tests are
// the record of WHICH rules — including the single one we add beyond cc's shape
// check, and the two cc accepts that we must not tighten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIRROR_EXCLUDE_MAX, MIRROR_PATH_MAX } from '../src/launcher/protocol.mjs';
import { DEFAULT_MIRROR, isNormalAbsolute, validateMirror } from '../src/mirror.mjs';

// PINS THE DEFAULTS TO ONE PLACE, and to cc's own §11 row. The frontend renders
// whatever this holds, served over REST, so a second list cannot appear.
test('the shipped defaults are cc\'s three pseudo-filesystems under /, and they validate', () => {
  assert.deepEqual({ ...DEFAULT_MIRROR, exclude: [...DEFAULT_MIRROR.exclude] },
    { root: '/', exclude: ['/proc', '/dev', '/sys'] });
  const v = validateMirror({ root: DEFAULT_MIRROR.root, exclude: [...DEFAULT_MIRROR.exclude] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.mirror, { root: '/', exclude: ['/proc', '/dev', '/sys'] });
});

// PINS THE OPTED-OUT SHAPE. It is a legal answer, not a missing one: cc reads a
// descriptor with neither field as "I advertise nothing" and takes the same path
// as a provider that never heard of the frame. An absent `mirror` on a POST body
// must therefore be `ok`, never a 400.
test('absent and null are both a valid "advertise nothing"', () => {
  for (const raw of [undefined, null]) {
    const v = validateMirror(raw);
    assert.equal(v.ok, true, `${JSON.stringify(raw)} is opted out, not invalid`);
    assert.equal(v.mirror, null);
  }
});

test('a mirror that is not an object is refused, and the message quotes it', () => {
  for (const raw of ['/', 42, true, ['/proc']]) {
    const v = validateMirror(raw);
    assert.equal(v.ok, false, `${JSON.stringify(raw)} must be refused`);
    assert.match(v.error, /^mirror: /);
    assert.ok(v.error.includes(JSON.stringify(raw)), `the message quotes ${JSON.stringify(raw)}: ${v.error}`);
  }
});

// PINS: a relative root can never be a claim about the target's own layout.
test('a relative root is refused', () => {
  for (const root of ['app', './app', '../x', 'app/sub', '']) {
    const v = validateMirror({ root });
    assert.equal(v.ok, false, `root ${JSON.stringify(root)} must be refused`);
  }
});

// PINS cc's NORMAL-FORM RULE, and the trailing-slash exception. We do not
// normalise on the operator's behalf: a normalised-away `..` is how a hostile
// root gets past a containment test, and `/app/` vs `/app` are two spellings of
// one place that compare unequal downstream.
test('a root that is not already in normal form is refused, but / is', () => {
  for (const root of ['/a/./b', '/a/../b', '/a//b', '/app/', '/app/.', '/./']) {
    const v = validateMirror({ root });
    assert.equal(v.ok, false, `root ${JSON.stringify(root)} must be refused`);
    assert.match(v.error, /normal form/);
  }
  assert.equal(validateMirror({ root: '/' }).ok, true, '/ is its own normal form');
  assert.equal(validateMirror({ root: '/app' }).ok, true);
});

// PINS THE BOUND TO THE MIRRORED CONSTANT, not to a literal: MIRROR_PATH_MAX is
// cc's ceiling, and tests/protocol-constants.test.mjs is what keeps it honest.
// The NUL is refused rather than carried because it is INERT downstream — an
// exclude of `/proc\0` silently matches nothing while reading as `/proc`.
test('a NUL is refused, and the path length bound is cc\'s constant', () => {
  assert.equal(validateMirror({ root: '/proc\0' }).ok, false);
  assert.equal(validateMirror({ root: '/a', exclude: ['/b\0'] }).ok, false);

  const atCap = `/${'a'.repeat(MIRROR_PATH_MAX - 1)}`;
  assert.equal(atCap.length, MIRROR_PATH_MAX);
  assert.equal(validateMirror({ root: atCap }).ok, true, 'exactly at the cap is accepted');
  assert.equal(validateMirror({ root: `${atCap}a` }).ok, false, 'one over is refused');
  assert.equal(isNormalAbsolute(`${atCap}a`), false);
});

test('a non-string or blank root is refused, naming the value', () => {
  for (const root of [undefined, null, 42, {}, ['/'], '   ', '\t']) {
    const v = validateMirror({ root });
    assert.equal(v.ok, false, `root ${JSON.stringify(root)} must be refused`);
    assert.match(v.error, /root must be a non-empty absolute path/);
  }
});

test('exclude must be an array, and absent or null means none', () => {
  assert.deepEqual(validateMirror({ root: '/app' }).mirror, { root: '/app', exclude: [] });
  assert.deepEqual(validateMirror({ root: '/app', exclude: null }).mirror, { root: '/app', exclude: [] });
  for (const exclude of ['/proc', 42, { 0: '/proc' }]) {
    const v = validateMirror({ root: '/app', exclude });
    assert.equal(v.ok, false, `exclude ${JSON.stringify(exclude)} must be refused`);
    assert.match(v.error, /exclude must be an array/);
  }
});

// PINS THAT THE MESSAGE NAMES THE INDEX. The card UI has no per-field error
// display — a 400 arrives as one banner sentence — so the index is the only way
// an operator finds the offending line in a list of sixty-four.
test('a bad exclude entry is refused, and the error names its index and value', () => {
  for (const [i, bad] of [42, '', 'proc', '/a/../b', '/proc/', null].entries()) {
    const exclude = ['/dev', '/sys'];
    exclude.splice(1, 0, bad);
    const v = validateMirror({ root: '/', exclude });
    assert.equal(v.ok, false, `entry ${JSON.stringify(bad)} must be refused (case ${i})`);
    assert.match(v.error, /exclude\[1\]/, 'the index is named');
    assert.ok(v.error.includes(JSON.stringify(bad)), `the value is quoted: ${v.error}`);
  }
});

test('the exclude count bound is cc\'s constant', () => {
  const entry = i => `/x${i}`;
  const atCap = Array.from({ length: MIRROR_EXCLUDE_MAX }, (_, i) => entry(i));
  assert.equal(validateMirror({ root: '/', exclude: atCap }).ok, true, 'exactly at the cap is accepted');
  const over = [...atCap, entry(MIRROR_EXCLUDE_MAX)];
  const v = validateMirror({ root: '/', exclude: over });
  assert.equal(v.ok, false, 'one over is refused');
  assert.match(v.error, new RegExp(`${over.length} entries`));
  assert.match(v.error, new RegExp(`${MIRROR_EXCLUDE_MAX}-entry cap`));
});

// PINS THE ONE RULE WE ADD BEYOND cc's SHAPE CHECK, and — just as importantly —
// the two neighbouring cases we must NOT refuse. cc accepts an exclude that
// covers the root at shape level and then refuses the SESSION with
// MIRROR_EXCLUDE_COVERS_PROJECT (501) at spawn; refusing it in the form is
// strictly better feedback and rejects nothing usable.
//
// CONTAINMENT IS path.posix.relative, NEVER A STRING PREFIX: `/app-backup` is
// not inside `/app`, and a prefix test would refuse a legitimate exclude.
test('an exclude covering the mirror root is refused; one outside it, or a prefix-sharing sibling, is not', () => {
  const covering = validateMirror({ root: '/app', exclude: ['/app'] });
  assert.equal(covering.ok, false, 'equal to the root');
  assert.match(covering.error, /covers the mirror root/);
  assert.equal(validateMirror({ root: '/app', exclude: ['/'] }).ok, false, 'an ancestor of the root');
  assert.equal(validateMirror({ root: '/app/sub', exclude: ['/app'] }).ok, false, 'a deeper ancestor');
  assert.equal(validateMirror({ root: '/', exclude: ['/'] }).ok, false, '/ under root /');

  // INERT, NOT AN ERROR — cc's own word for it. A provider that mirrors /app and
  // also lists /proc is sane configuration.
  assert.equal(validateMirror({ root: '/app', exclude: ['/proc'] }).ok, true);
  // Merely prefix-SHARING, so not covering. A string-prefix test fails here.
  assert.equal(validateMirror({ root: '/app', exclude: ['/app-backup'] }).ok, true);
  // Strictly INSIDE the root is the ordinary case and stays legal.
  assert.equal(validateMirror({ root: '/', exclude: ['/proc'] }).ok, true);
  assert.equal(validateMirror({ root: '/app', exclude: ['/app/node_modules'] }).ok, true);
});

// PINS: the stored list is the operator's list. Sorting or de-duplicating it
// would make the textarea they typed and the value they saved two different
// things.
test('exclude entry order is preserved', () => {
  const exclude = ['/sys', '/proc', '/dev', '/var/tmp'];
  assert.deepEqual(validateMirror({ root: '/', exclude }).mirror.exclude, exclude);
});
