// WHICH `exec` FRAMES MAY RIDE A HELD-OPEN CHANNEL. Pure, and the only reader
// of a frame outside session.mjs.
//
// ROUTING BY ARGV *FORM* IS DISQUALIFIED, and not as a matter of taste: cc sends
// `project_bash` as `{argv:['bash','--noprofile','--norc','-c',…]}` and every
// `worktrees.ts` git call as argv-form too, so a form rule would put `git clone`
// on a shared sequential shell. The discriminator here is the EXACT COMMAND
// VECTOR — cc's `#derive` catalogue (code-conductor
// src/systems/providerSystem.ts), spelled out below — plus an envelope
// predicate over the frame's other fields.
//
// IT FAILS CLOSED, and that property is what makes the table safe to hold: a
// refusal costs today's per-op spawn and nothing else, so when cc changes a
// derivation's flags the row simply stops matching and that operation quietly
// goes back to the slow path. Drift can never route something unadmitted. What
// it CAN do is silently undo this whole optimisation, which is why `drift` is
// reported separately — session.mjs turns it into a one-shot warning.

// Everything cc's `#derive` prepends, unconditionally, to every derivation.
// `env(1)` ADDS the variable rather than replacing the environment, which is
// why it is argv[0] and not a frame `env`.
const DERIVATION_PREFIX = ['env', 'LC_ALL=C'];

// The ONE cwd a derivation carries: cc sends every one of them with the
// placeholder, never a real location (systems-protocol.md §7).
const PLACEHOLDER_CWD = '/';

// A free operand: matched by shape, never by value. A path is data.
const ANY = () => true;
// chmod's mode, as cc renders it: `(mode & 0o7777).toString(8).padStart(4,'0')`.
const OCTAL4 = (v) => /^[0-7]{4}$/.test(v);

// THE FIND FORMAT IS TWO-CHARACTER ESCAPES, not tabs and newlines. cc's
// `FIND_FIELDS` is the TypeScript literal `'%y\\t%m\\t%s\\t%T@\\t%l'`, so the
// argv element that reaches the wire carries backslash-t for `find` itself to
// interpret. Comparing it to a real tab would de-admit every lstat and readDir.
const FIND_FIELDS = '%y\\t%m\\t%s\\t%T@\\t%l';

/**
 * THE VECTOR TABLE. One row per cc derivation, each a positional matcher: a
 * string element must be equal byte-for-byte, a function element is a free
 * operand. Nothing is optional and nothing is variadic — a row matches only a
 * frame of exactly its length.
 */
const ROWS = [
  { op: 'stat', argv: [...DERIVATION_PREFIX, 'stat', '-L', '-c', '%f %s %.3Y', '--', ANY] },
  { op: 'lstat', argv: [...DERIVATION_PREFIX, 'find', ANY, '-maxdepth', '0', '-printf', `${FIND_FIELDS}\\n`] },
  { op: 'readDir', argv: [...DERIVATION_PREFIX, 'find', ANY, '-mindepth', '1', '-maxdepth', '1', '-printf', `${FIND_FIELDS}\\t%f\\n`] },
  { op: 'readlink', argv: [...DERIVATION_PREFIX, 'readlink', '-v', '--', ANY] },
  { op: 'realpath', argv: [...DERIVATION_PREFIX, 'realpath', '-e', '--', ANY] },
  { op: 'mkdir', argv: [...DERIVATION_PREFIX, 'mkdir', '--', ANY] },
  { op: 'mkdir -p', argv: [...DERIVATION_PREFIX, 'mkdir', '-p', '--', ANY] },
  { op: 'chmod', argv: [...DERIVATION_PREFIX, 'chmod', OCTAL4, '--', ANY] },
  { op: 'unlink', argv: [...DERIVATION_PREFIX, 'unlink', '--', ANY] },
  { op: 'removeEntry', argv: [...DERIVATION_PREFIX, 'rm', '-d', '--', ANY] },
  { op: 'symlink', argv: [...DERIVATION_PREFIX, 'ln', '-sfnT', '--', ANY, ANY] },
  // cc's liveness probe (`registry.ts`, and `ProviderSystem`'s own). It carries
  // no `env LC_ALL=C` prefix because it is not a derivation. On the channel it
  // resolves to the shell's BUILTIN `true`, so unlike the per-op spawn path it
  // cannot report a missing binary at all.
  { op: 'probe', argv: ['true'] },
];

// REFUSED BY NAME, and listed rather than merely absent so the refusal is a
// decision a reader can find. `removeTree` is the one derivation whose runtime
// scales with its target instead of being a single bounded syscall-shaped
// command, and cc fences no derivation with `maxBufferBytes` or a `timeoutMs` —
// so "short and bounded" has to be enforced here, never assumed.
const EXCLUDED = [
  { op: 'removeTree', argv: [...DERIVATION_PREFIX, 'rm', '-rf', '--', ANY] },
];

function matches(spec, argv) {
  if (!Array.isArray(argv) || argv.length !== spec.length) return false;
  for (let i = 0; i < spec.length; i++) {
    const want = spec[i];
    const got = argv[i];
    if (typeof got !== 'string') return false;
    if (typeof want === 'string' ? got !== want : !want(got)) return false;
  }
  return true;
}

/**
 * THE ENVELOPE. Every condition is one cc's own `execFrame` satisfies for a
 * derivation and fails for everything else, so each is load-bearing:
 *
 *  - `cwd` is the placeholder — `runGit` sends the repo path and the
 *    post-worktree hook sends a worktree path, so this alone refuses both;
 *  - `argv` without `shell` — `project_bash` on a remote sends `shell`;
 *  - no `env` — a replacement environment is `env -i`'s job on the spawn path
 *    and has no meaning on a shell whose environment is already fixed;
 *  - `stdin: 'ignore'` — the channel's own stdin is the command stream, so an
 *    op that wanted to read it would eat the next command;
 *  - no `timeoutMs` / `killGraceMs` — a frame carrying a deadline is one cc
 *    expects to be able to kill on a schedule, and it is never a derivation.
 */
function envelopeOk(f) {
  if (f?.type !== 'exec') return false;
  if (!Array.isArray(f.argv) || f.argv.length === 0) return false;
  if (typeof f.shell === 'string') return false;
  if (f.cwd !== PLACEHOLDER_CWD) return false;
  if (f.env !== undefined && f.env !== null) return false;
  if (f.stdin !== 'ignore') return false;
  if (f.timeoutMs !== undefined && f.timeoutMs !== null) return false;
  if (f.killGraceMs !== undefined && f.killGraceMs !== null) return false;
  return true;
}

// Is this argv one cc could only have produced in `#derive`? `env LC_ALL=C` as
// the first two elements is that signature: `#derive` prepends it
// unconditionally, and a user command reaching this point would have had to
// pass the whole envelope as well.
function derivationShaped(argv) {
  return argv[0] === DERIVATION_PREFIX[0] && argv[1] === DERIVATION_PREFIX[1];
}

/**
 * @param {object} f  a decoded `exec` frame
 * @param {{all?:boolean}} [opts] `all: true` answers the LIST of row names that
 *   matched, so a test can prove no row shadows another. Never used in
 *   production.
 * @returns {{ok:true, op:string, argv:string[]}
 *          |{ok:false, reason:'envelope'|'excluded'|'no-row', drift:boolean}}
 */
export function admits(f, { all = false } = {}) {
  if (all) {
    if (!envelopeOk(f)) return [];
    return ROWS.filter(r => matches(r.argv, f.argv)).map(r => r.op);
  }
  if (!envelopeOk(f)) return { ok: false, reason: 'envelope', drift: false };
  const argv = f.argv;
  for (const row of ROWS) {
    if (matches(row.argv, argv)) return { ok: true, op: row.op, argv };
  }
  for (const row of EXCLUDED) {
    if (matches(row.argv, argv)) return { ok: false, reason: 'excluded', drift: false };
  }
  return { ok: false, reason: 'no-row', drift: derivationShaped(argv) };
}
