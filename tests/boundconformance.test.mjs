// The BOUND CONFORMANCE GATE'S own tests: deterministic, docker-free, and part
// of `npm test`.
//
// The gate itself (`npm run conformance:docker`) needs a daemon, a clone of the
// pin and a bound scratch directory, so it can never be part of `npm test`.
// What CAN be is the two pieces of it that decide whether a run is believed:
// the expectation manifest's structural guard, and the parse of cc's reporter
// output. Both are pure.
//
// The reporter fixture is REAL CAPTURED OUTPUT of a bound run (paths scrubbed),
// not text written to match the parser — including the `failing tests:` recap
// and the YAML error blocks, which are exactly what a naive parse trips on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTally, parseSpecReport } from './ccCheckout.mjs';
import {
  EXPECTED, EXPECTED_TOTAL, MIN_CAUSE_CHARS, checkTotal, compareOutcomes, validateExpectations,
} from './boundConformanceExpectations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'specReport.txt');

// A VALID cause: long enough AND citing something. Both halves are required, and
// the tests below drive each one alone.
const GOOD_CAUSE = 'src/launcher/main.mjs refuses the flag before any frame, so the row never handshakes';
const ok = (over = {}) => ({ name: 'a row', outcome: 'fail', cause: GOOD_CAUSE, ...over });

// ── The manifest's structural guard ──────────────────────────────────

// PINS: the SHIPPED manifest satisfies its own rules — so the guard below is
// about a real invariant rather than one nothing has ever met.
test('the shipped manifest validates, and every entry carries a real cause', () => {
  assert.equal(validateExpectations(EXPECTED), EXPECTED);
  for (const e of EXPECTED) {
    assert.ok(e.cause.trim().length >= MIN_CAUSE_CHARS, `${e.name} needs a cause`);
  }
  assert.ok(EXPECTED.some(e => e.outcome === 'skip') && EXPECTED.some(e => e.outcome === 'fail'),
    'the manifest is ONE table for both jobs — a run that lost either kind would not exercise it');
});

// PINS THE LENGTH HALF of the cause guard: absent, blank or too short.
test('an entry with a missing, empty or too-short cause is refused', () => {
  for (const bad of [undefined, '', '   ', 'expected to fail', 'main.mjs:84 refuses it']) {
    assert.throws(() => validateExpectations([ok({ cause: bad })]), /cause/,
      `cause ${JSON.stringify(bad)} must be refused`);
  }
  assert.doesNotThrow(() => validateExpectations([ok()]));
});

// PINS THE CITATION HALF, which is what makes "a bare 'expected to fail' cannot
// be added" TRUE rather than merely intended. A length floor alone is gameable:
// each string below clears MIN_CAUSE_CHARS and says nothing, and before the
// citation rule every one of them was accepted.
test('a long cause that cites nothing is refused, however long', () => {
  const gameable = [
    'x'.repeat(MIN_CAUSE_CHARS),
    'a row '.repeat(12),
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.',
    'expected to fail, for reasons that are long but name no code and no clause',
  ];
  for (const cause of gameable) {
    assert.ok(cause.trim().length >= MIN_CAUSE_CHARS, 'the probe must clear the length floor first');
    assert.throws(() => validateExpectations([ok({ cause })]), /must CITE/,
      `a cause citing nothing must be refused: ${JSON.stringify(cause.slice(0, 24))}…`);
  }
  // Either form of citation is enough: a source file, or a spec section.
  assert.doesNotThrow(() => validateExpectations([ok({
    cause: 'kinds/docker.mjs hardcodes the value, and there is no flag that changes it at all',
  })]));
  assert.doesNotThrow(() => validateExpectations([ok({
    cause: 'systems-protocol.md \u00a710 relaxes one axis only, so a truthful false has no way through',
  })]));
});

// PINS: a skip entry must pin the VERBATIM reason string. Without this the
// reason-changed comparison below has nothing to compare against, and "a
// different reason string means the harness changed" stops being enforceable.
test('a skip entry must carry a verbatim reason, and a fail entry must not', () => {
  assert.throws(() => validateExpectations([ok({ outcome: 'skip' })]), /VERBATIM/);
  assert.throws(() => validateExpectations([ok({ outcome: 'skip', reason: '  ' })]), /VERBATIM/);
  assert.throws(() => validateExpectations([ok({ reason: 'why' })]), /no printed reason/);
  assert.doesNotThrow(() => validateExpectations([ok({ outcome: 'skip', reason: 'because' })]));
});

// PINS: the two ways a manifest can be internally incoherent — a name listed
// twice (two causes for one row, only one of which is ever read) and an outcome
// outside skip/fail (a 'pass' entry would make the table meaningless).
test('a duplicate name or an unknown outcome is refused', () => {
  assert.throws(() => validateExpectations([ok(), ok()]), /listed twice/);
  for (const outcome of ['pass', undefined, 'PASS', 'flaky']) {
    assert.throws(() => validateExpectations([ok({ outcome })]), /outcome must be/);
  }
});

// ── The comparison, in both directions ───────────────────────────────

const observed = (rows) => new Map(rows.map(([name, outcome, reason = null]) => [name, { outcome, reason }]));
const MANIFEST = [
  ok({ name: 'known fail' }),
  ok({ name: 'known skip', outcome: 'skip', reason: 'the verbatim reason' }),
];

// PINS: a matching run is SILENT. A comparison that reported something on a
// good run would be ignored on a bad one.
test('a run that matches the manifest yields no problems', () => {
  const problems = compareOutcomes(observed([
    ['known fail', 'fail'], ['known skip', 'skip', 'the verbatim reason'], ['anything else', 'pass'],
  ]), MANIFEST);
  assert.deepEqual(problems, []);
});

// PINS: ANYTHING NOT LISTED MUST PASS — the rule the whole gate rests on. An
// unlisted failure and an unlisted skip are each red, and are told apart.
test('an unlisted failure and an unlisted skip are each reported, by kind', () => {
  const problems = compareOutcomes(observed([
    ['known fail', 'fail'], ['known skip', 'skip', 'the verbatim reason'],
    ['a new failure', 'fail'], ['a new skip', 'skip', 'some new reason'],
  ]), MANIFEST);
  assert.deepEqual(problems.map(p => [p.kind, p.name]).sort(), [
    ['unexpected-fail', 'a new failure'], ['unexpected-skip', 'a new skip'],
  ]);
  assert.match(problems.find(p => p.kind === 'unexpected-skip').message, /some new reason/,
    'the verbatim reason of an unlisted skip is printed, so it can be diagnosed without a re-run');
});

// PINS: a listed row that starts PASSING is red, and the message hands back its
// cause. A manifest that only catches regressions has stopped discriminating —
// this is the direction that decays silently.
test('a listed row that now passes is red, and the message carries its cause', () => {
  const problems = compareOutcomes(observed([
    ['known fail', 'pass'], ['known skip', 'skip', 'the verbatim reason'],
  ]), MANIFEST);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'unexpected-pass');
  assert.match(problems[0].message, /now passes; delete its entry/);
  assert.match(problems[0].message, new RegExp(MANIFEST[0].cause.slice(0, 20)));
});

// PINS: "a fifth skip, OR A DIFFERENT REASON STRING, means the harness changed"
// — mechanised. A known-skipping row whose reason text moved is red.
test('a known skip with a different reason string is red, showing both strings', () => {
  const problems = compareOutcomes(observed([
    ['known fail', 'fail'], ['known skip', 'skip', 'a reworded reason'],
  ]), MANIFEST);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'reason-changed');
  assert.match(problems[0].message, /the verbatim reason/);
  assert.match(problems[0].message, /a reworded reason/);
});

// PINS: a listed row that the run never reported at all — renamed or deleted
// upstream — is red rather than silently satisfied. Without this, a manifest
// entry survives the row it describes and the gate quietly covers less.
test('a listed row the run never reported is red', () => {
  const problems = compareOutcomes(observed([['known fail', 'fail']]), MANIFEST);
  assert.deepEqual(problems.map(p => [p.kind, p.name]), [['row-missing', 'known skip']]);
});

// PINS: a listed row whose OUTCOME flipped between skip and fail is red — the
// manifest records which of the two it is, and they have different causes.
test('a listed skip that fails (or the reverse) is red', () => {
  const problems = compareOutcomes(observed([
    ['known fail', 'skip', 'newly skipped'], ['known skip', 'fail'],
  ]), MANIFEST);
  assert.deepEqual(problems.map(p => p.kind), ['outcome-changed', 'outcome-changed']);
});

// ── The absolute-total pin ───────────────────────────────────────────

// PINS THE ONE GUARD THAT IS NOT RELATIVE TO THE RUN. `compareOutcomes` walks
// observed union listed and `checkTally` compares two numbers that shrink
// together, so a row VANISHING from cc's suite is invisible to both — the run
// simply covers one row less and stays green. Red in both directions, because a
// vanished row and a new row are the same event: the harness moved.
test('a battery that grew or shrank is red, in both directions', () => {
  assert.deepEqual(checkTotal({ tests: EXPECTED_TOTAL }), []);
  for (const n of [EXPECTED_TOTAL - 1, EXPECTED_TOTAL + 1, 0]) {
    const problems = checkTotal({ tests: n });
    assert.equal(problems.length, 1, `${n} tests must be red`);
    assert.match(problems[0], new RegExp(`reported ${n} tests, not the ${EXPECTED_TOTAL}`));
    assert.match(problems[0], /added or REMOVED/);
  }
  assert.match(checkTotal({})[0], /no `tests <n>` summary diagnostic/,
    'and a run that stopped printing its size is its own alarm');
});

// PINS THE ATTACK ITSELF, against the real captured run: delete one UNLISTED
// PASSING row and decrement the tally to match — exactly what the reporter
// prints when a row disappears — and the two relative guards stay silent while
// the absolute one reds. Written this way round so it fails if `checkTotal` is
// ever folded into either of them and loses its independence.
test('a row silently vanishing from the suite is caught by the total, and only by it', async () => {
  const raw = await fs.readFile(FIXTURE, 'utf8');
  const victim = 'parseFindLines refuses a malformed entry rather than skipping it';
  const shrunk = raw.split('\n').filter(l => !l.includes(victim)).join('\n')
    .replace('\u2139 tests 55', '\u2139 tests 54')
    .replace('\u2139 pass 40', '\u2139 pass 39');
  const report = parseSpecReport(shrunk);
  assert.equal(report.tests.has(victim), false, 'the row really is gone from the parse');
  assert.deepEqual(checkTally(report), [], 'the parse/tally cross-check cannot see consistent shrinkage');
  assert.deepEqual(compareOutcomes(report.tests), [], 'nor can the manifest comparison');
  assert.equal(checkTotal(report.tally).length, 1, 'the absolute total is what catches it');
});

// ── The parse of cc's reporter output ────────────────────────────────

// PINS the parse against REAL captured output of a bound run: the counts, the
// verbatim skip reasons, and the fact that the `failing tests:` recap — which
// repeats every failing line — does not double-count. The last assertion is the
// SHIPPED MANIFEST, checked against the run it was written from, so the two
// cannot drift apart between bound runs.
test('the parser reads a real captured bound run, and the manifest matches it', async () => {
  const text = await fs.readFile(FIXTURE, 'utf8');
  const report = parseSpecReport(text);
  assert.deepEqual(checkTally(report), [], 'the parse must agree with the reporter\'s own tally');
  assert.equal(report.tally.tests, EXPECTED_TOTAL);
  assert.deepEqual(checkTotal(report.tally), []);
  assert.equal(report.tests.size, 55, 'the failing-tests recap repeats every failing line and must not double count');
  assert.equal(
    report.tests.get('every code in the taxonomy is produced by a real failure somewhere in this suite')?.reason,
    'counts producers across rows a third-party run skips');
  assert.equal(report.tests.get('parseFindLines refuses a malformed entry rather than skipping it')?.outcome, 'pass');
  assert.equal(report.tests.get('[all capabilities] process-group signalling: the capability decides whether'
    + ' grandchildren are reachable')?.outcome, 'fail');
  // A YAML error block's own indented lines must not be mistaken for results.
  assert.equal([...report.tests.keys()].some(k => k.startsWith('Error [SystemError]')), false);
  assert.deepEqual(compareOutcomes(report.tests), [],
    'and the shipped manifest is exactly what that run produced');
});
// PINS: the reason is everything after the FIRST ` # `, verbatim — including a
// reason that itself contains ` # ` — and ANSI colouring does not reach the name.
test('a skip reason is taken verbatim after the first hash, colours stripped', () => {
  const esc = String.fromCharCode(27);
  const { tests } = parseSpecReport([
    `${esc}[32m✔ a green row (1ms)${esc}[39m`,
    '﹣ a skipped row (0.5ms) # a reason # with a hash in it',
    '✖ a red row (2.25ms)',
  ].join('\n'));
  assert.deepEqual([...tests], [
    ['a green row', { outcome: 'pass', reason: null }],
    ['a skipped row', { outcome: 'skip', reason: 'a reason # with a hash in it' }],
    ['a red row', { outcome: 'fail', reason: null }],
  ]);
});

// PINS: a name that itself ends in a parenthesised duration keeps it — the
// greedy match, which a lazy one would truncate.
test('a test name containing its own (Nms) is not truncated', () => {
  const { tests } = parseSpecReport('✔ a row about a (250ms) budget (3ms)');
  assert.deepEqual([...tests.keys()], ['a row about a (250ms) budget']);
});

// PINS THE MIS-PARSE ALARM. An empty parse of a red run looks exactly like a
// green one, so the parse is checked against the reporter's own arithmetic:
// a per-test line format change reds the gate instead of emptying it.
test('a parse that disagrees with the reporter tally is reported, not trusted', () => {
  const good = ['✔ one (1ms)', '✖ two (1ms)', '﹣ three (1ms) # why',
    'ℹ pass 1', 'ℹ fail 1', 'ℹ skipped 1'].join('\n');
  assert.deepEqual(checkTally(parseSpecReport(good)), []);

  // The reporter says three passed; only one line parsed as one.
  const drifted = ['✔ one (1ms)', 'ℹ pass 3', 'ℹ fail 0', 'ℹ skipped 0'].join('\n');
  const problems = checkTally(parseSpecReport(drifted));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /parsed 1 pass result lines but the reporter tallied 3/);

  // And a summary that stopped being printed at all is its own alarm.
  assert.equal(checkTally(parseSpecReport('✔ one (1ms)')).length, 3);
});
