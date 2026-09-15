// WHICH `exec` FRAMES MAY RIDE THE HELD-OPEN CHANNEL, and — far more
// importantly — which may not.
//
// Every test here names the invariant it pins. The rule fails CLOSED: a refusal
// costs today's per-op spawn and nothing else, while a wrong admission would put
// an unbounded or stdin-carrying command on a shared sequential shell.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admits } from '../src/launcher/admission.mjs';

// The envelope every cc derivation carries on the wire (code-conductor
// src/systems/providerSystem.ts → `execFrame`): `cwd` always present, `stdin`
// 'ignore', and no `env`/`timeoutMs`/`killGraceMs` keys at all.
const derivation = (argv, over = {}) => ({
  type: 'exec', id: 'x', cwd: '/', stdin: 'ignore', argv, ...over,
});

const E = ['env', 'LC_ALL=C'];

// THE WHOLE TABLE, spelled out here independently of the implementation's own
// copy — a table asserted against itself proves nothing.
const ROWS = [
  ['stat', [...E, 'stat', '-L', '-c', '%f %s %.3Y', '--', '/a/b']],
  ['lstat', [...E, 'find', '/a/b', '-maxdepth', '0', '-printf', '%y\\t%m\\t%s\\t%T@\\t%l\\n']],
  ['readDir', [...E, 'find', '/a/b/.', '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%m\\t%s\\t%T@\\t%l\\t%f\\n']],
  ['readlink', [...E, 'readlink', '-v', '--', '/a/b']],
  ['realpath', [...E, 'realpath', '-e', '--', '/a/b']],
  ['mkdir', [...E, 'mkdir', '--', '/a/b']],
  ['mkdir -p', [...E, 'mkdir', '-p', '--', '/a/b']],
  ['chmod', [...E, 'chmod', '0755', '--', '/a/b']],
  ['unlink', [...E, 'unlink', '--', '/a/b']],
  ['removeEntry', [...E, 'rm', '-d', '--', '/a/b']],
  ['symlink', [...E, 'ln', '-sfnT', '--', '../t', '/a/b']],
  ['liveness probe', ['true']],
];

// PINS that every row of the vector table is reachable, and that the admitted
// argv is handed back verbatim for the script builder.
test('every derivation in the table is admitted, and its argv comes back verbatim', () => {
  for (const [what, argv] of ROWS) {
    const v = admits(derivation(argv));
    assert.equal(v.ok, true, `${what} must be admitted: ${JSON.stringify(v)}`);
    assert.deepEqual(v.argv, argv, `${what} argv is passed through unchanged`);
  }
});

// PINS that no row shadows another — each frame matches exactly one row, so a
// future edit that widened a row into a superset of its neighbour is caught.
test('no two rows match the same frame', () => {
  for (const [what, argv] of ROWS) {
    const hits = admits(derivation(argv), { all: true });
    assert.equal(hits.length, 1, `${what} matched ${hits.length} rows: ${JSON.stringify(hits)}`);
  }
});

// PINS `removeTree`'s exclusion BY NAME. No derivation is output- or
// time-fenced (cc's `#derive` passes no `maxBufferBytes`), and `rm -rf` is the
// one row whose runtime scales with its target rather than being a single
// bounded syscall — so it must never reach a shared sequential shell.
test('`rm -rf` is refused, and refused as a deliberate exclusion rather than as drift', () => {
  const v = admits(derivation([...E, 'rm', '-rf', '--', '/a/b']));
  assert.equal(v.ok, false);
  assert.equal(v.drift, false, 'an excluded row is not cc-side drift and must not warn');
  assert.equal(v.reason, 'excluded');
});

// PINS that routing is by EXACT COMMAND VECTOR, never by argv FORM. Each of
// these is argv-form, and two of the three even lead with `env` — the acceptance
// criterion's own disqualification of form-based routing.
test('a user command is refused structurally, and a leading `env` is not a derivation marker', () => {
  const cases = [
    ['project_bash', { shell: 'ls -la' }],
    ['project_bash argv form', { argv: ['bash', '--noprofile', '--norc', '-c', 'rm -rf /'] }],
    ['runGit', { argv: ['git', '-C', '/repo', 'clone', 'https://example.invalid/x'] }],
    ['the post-worktree hook', {
      argv: ['env', 'CC_WORKTREE_PATH=/w', 'bash', '/w/.conduct/hook.sh'],
      cwd: '/w', timeoutMs: 60_000,
    }],
  ];
  for (const [what, over] of cases) {
    const f = { type: 'exec', id: 'x', cwd: '/', stdin: 'ignore', ...over };
    if (over.shell) delete f.argv;
    const v = admits(f);
    assert.equal(v.ok, false, `${what} must be refused`);
    assert.equal(v.drift, false, `${what} is an ordinary command, not drift`);
  }
});

// PINS that the envelope fails closed on ONE wrong field: each of these is an
// otherwise-perfect `stat` row.
test('each envelope condition refuses on its own', () => {
  const good = [...E, 'stat', '-L', '-c', '%f %s %.3Y', '--', '/a/b'];
  const cases = {
    'a cwd that is not the placeholder': { cwd: '/tmp' },
    'an env object': { env: { PATH: '/usr/bin' } },
    'a piped stdin': { stdin: 'pipe' },
    'an absent stdin (which means pipe)': { stdin: undefined },
    'a timeoutMs': { timeoutMs: 1000 },
    'a killGraceMs': { killGraceMs: 50 },
    'a shell beside the argv': { shell: 'echo hi' },
    'a non-exec frame': { type: 'readFile' },
  };
  for (const [what, over] of Object.entries(cases)) {
    const v = admits(derivation(good, over));
    assert.equal(v.ok, false, `${what} must refuse`);
    assert.equal(v.reason, 'envelope', `${what} must refuse at the envelope, before the table`);
    assert.equal(v.drift, false, 'an envelope refusal is never reported as drift');
  }
});

// PINS BYTE-FOR-BYTE matching of every fixed element, including the `-printf`
// format strings — which are literal backslash-t/backslash-n sequences `find`
// itself interprets, not tabs and newlines. A cc that changed one flag must
// DE-ADMIT that row (and take today's path), never mis-route it.
test('a row with a flag added, removed, reordered or one byte different is refused', () => {
  const mutations = [
    ['a flag removed', [...E, 'stat', '-c', '%f %s %.3Y', '--', '/a/b']],
    ['a flag added', [...E, 'stat', '-L', '-t', '-c', '%f %s %.3Y', '--', '/a/b']],
    ['flags reordered', [...E, 'stat', '-c', '-L', '%f %s %.3Y', '--', '/a/b']],
    ['the stat format changed', [...E, 'stat', '-L', '-c', '%f %s %.6Y', '--', '/a/b']],
    ['the LC_ALL value changed', ['env', 'LC_ALL=en_US.UTF-8', 'stat', '-L', '-c', '%f %s %.3Y', '--', '/a/b']],
    ['a find field dropped', [...E, 'find', '/a/b', '-maxdepth', '0', '-printf', '%y\\t%m\\t%s\\t%T@\\n']],
    ['a find format with a REAL tab instead of the two-character escape',
      [...E, 'find', '/a/b', '-maxdepth', '0', '-printf', '%y\t%m\t%s\t%T@\t%l\n']],
    ['readDir depths swapped', [...E, 'find', '/a/b/.', '-mindepth', '1', '-maxdepth', '2', '-printf', '%y\\t%m\\t%s\\t%T@\\t%l\\t%f\\n']],
    ['ln without -T', [...E, 'ln', '-sfn', '--', '../t', '/a/b']],
    ['rm without -d', [...E, 'rm', '--', '/a/b']],
    ['a chmod mode that is not four octal digits', [...E, 'chmod', 'u+x', '--', '/a/b']],
    ['a chmod mode of the wrong width', [...E, 'chmod', '755', '--', '/a/b']],
    ['an extra trailing operand', [...E, 'stat', '-L', '-c', '%f %s %.3Y', '--', '/a/b', '/c']],
    ['a missing operand', [...E, 'stat', '-L', '-c', '%f %s %.3Y', '--']],
    ['the liveness probe with an argument', ['true', '-x']],
  ];
  for (const [what, argv] of mutations) {
    const v = admits(derivation(argv));
    assert.equal(v.ok, false, `${what} must be refused`);
  }
});

// PINS the DRIFT SIGNAL itself: an envelope-passing frame whose argv opens
// `['env','LC_ALL=C',…]` is a cc derivation by construction, so a no-row verdict
// on it is unambiguously cc-side drift and must be distinguishable from an
// ordinary refusal — that is the whole basis of the one-shot warning.
test('a derivation-shaped frame that matches no row is reported as drift', () => {
  const v = admits(derivation([...E, 'stat', '-L', '-c', '%f %s %.6Y', '--', '/a/b']));
  assert.equal(v.ok, false);
  assert.equal(v.drift, true);
  assert.equal(v.reason, 'no-row');
});

// PINS that drift is NOT reported for a frame that failed the envelope: a
// derivation-shaped argv carried by a frame cc never sends that way is not
// evidence about the table.
test('a derivation-shaped argv that fails the envelope is not drift', () => {
  const v = admits(derivation([...E, 'stat', '-L', '-c', '%f %s %.6Y', '--', '/a/b'], { cwd: '/tmp' }));
  assert.equal(v.ok, false);
  assert.equal(v.drift, false);
});

// PINS that free operands really are free — a path is data, never matched.
test('free operands accept anything, including shell metacharacters and newlines', () => {
  for (const p of ["/a b/c'd", '/a\nb', '/a;rm -rf /', '/$(whoami)', '/`id`']) {
    assert.equal(admits(derivation([...E, 'realpath', '-e', '--', p])).ok, true, p);
    assert.equal(admits(derivation([...E, 'ln', '-sfnT', '--', p, p])).ok, true, p);
  }
});
