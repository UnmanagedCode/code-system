// readFile and writeFile, DERIVED OVER `exec` — one implementation for every
// kind.
//
// WHY DERIVED RATHER THAN `docker cp` / `scp`: the target must satisfy cc's
// POSIX/GNU baseline anyway, because cc's own derived operations (`stat`,
// `readDir`, `realpath`, …) are `exec` frames against that toolchain
// (docs/systems-protocol.md §1, §7). `base64` is therefore ALREADY REQUIRED on
// every supported target, so a copy primitive buys no capability at all — only
// a second code path with its own tar-wrapper semantics (and, for scp, its own
// auth path) to keep correct. cc's own docker sanity check maps these two to
// "`cat` / `cat >`, with a companion `stat` for size/mode"
// (systems-protocol.md §11). Deriving here gives both kinds one
// implementation and makes the mode/atomic/exclusive rules a single piece of
// code cards 2026-0003 and 2026-0004 inherit for free.
//
// THE FAR-SIDE SCRIPTS NORMALISE THEIR OWN FAILURE TEXT to POSIX strerror
// tails. Shells disagree — `set -C` gives "cannot overwrite existing file" on
// bash and "File exists" on dash, and dash's redirect failure says "Directory
// nonexistent" where bash says "No such file or directory" — while cc's
// classifier matches on the TAIL. cc's callers branch on the resulting codes
// ("create the file unless it already exists" is written as catch-EEXIST), so
// testing the condition explicitly and emitting the exact tail ourselves is
// what keeps the codes deterministic across every target shell.

import { randomBytes } from 'node:crypto';
import {
  BINARY_SNIFF_BYTES, FS_ERROR_CODES, MAX_FILE_BYTES, ProtocolError, classifyStderr,
} from './protocol.mjs';

// Single-quote for `sh -c`. Everything we interpolate is a path or a number
// from a frame, so nothing may be allowed to reach the shell as syntax.
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// The header the read script prints before the payload, so a host-side parse
// never has to guess where `stat`'s output ends and the file's bytes begin.
const STAT_TAG = 'CCSTAT';

// HOW OUR OWN REFUSALS ARE CLASSIFIED, and why not by stderr text.
//
// `classifyStderr` matches a strerror tail ANYWHERE in stderr, and our scripts
// interpolate the requested path into their own failure lines — so a file
// literally named `.../Is a directory` would misclassify an ENOENT, and cc's
// callers branch on these codes. Exit codes are no better: the same noclobber
// failure is exit 2 on dash and exit 1 on bash (measured on this host).
//
// So each script carries a PER-CALL NONCE and tags its own refusals
// `CCERR-<nonce> <CODE>`. A path cannot contain a nonce it has never seen, so
// the tag is unspoofable, and matching it anywhere in stderr means we do not
// depend on whether the shell wrote its own message first. Anything untagged is
// the far side's own tool talking, and falls through to `classifyStderr` — which
// is the right reader for text we did not write.
const ERR_TAG = 'CCERR';

export function makeNonce() {
  return randomBytes(6).toString('hex');
}

// A tagged refusal: the machine-readable tag, then the human/POSIX tail cc's
// own classifier would also accept.
function refuseLine(nonce, code, fmt, arg) {
  return `printf '${ERR_TAG}-${nonce} ${code}\\n${fmt}\\n' ${arg} >&2; exit 2`;
}

let tmpSeq = 0;

export function tempNameFor(targetPath) {
  return `${targetPath}.${process.pid}.${tmpSeq++}.tmp`;
}

export function buildReadScript({ path, offset = 0, length = null, maxBytes = MAX_FILE_BYTES, nonce = makeNonce() }) {
  const p = shellQuote(path);
  const off = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const wantExpr = length === null || length === undefined
    ? `want=$((size - ${off})); if [ "$want" -lt 0 ]; then want=0; fi`
    : `want=${Math.max(0, Math.trunc(length))}`;
  const refuse = (code, fmt, arg) => refuseLine(nonce, code, fmt, arg);
  return [
    'LC_ALL=C; export LC_ALL',
    `p=${p}`,
    // Order matters: existence first (a broken symlink is ENOENT because -e
    // follows), then directory, then readability.
    `if [ ! -e "$p" ]; then ${refuse('ENOENT', '%s: No such file or directory', '"$p"')}; fi`,
    `if [ -d "$p" ]; then ${refuse('EISDIR', '%s: Is a directory', '"$p"')}; fi`,
    `if [ ! -r "$p" ]; then ${refuse('EACCES', '%s: Permission denied', '"$p"')}; fi`,
    // -L follows symlinks, matching fs.stat. %f is the RAW mode so the type
    // bits survive; %s is the whole file's size, which is what
    // readFileResult.size means regardless of the range returned.
    `st=$(stat -L -c '%f %s' -- "$p") || exit 1`,
    'set -- $st',
    'mode=$1; size=$2',
    wantExpr,
    // Refused BEFORE a byte is transferred.
    `if [ "$want" -gt ${maxBytes} ]; then ${refuse('EFBIG', `%s bytes requested, above the ${maxBytes}-byte protocol cap`, '"$want"')}; fi`,
    `printf '${STAT_TAG} %s %s\\n' "$mode" "$size"`,
    `if [ "$want" -gt 0 ]; then tail -c +${off + 1} -- "$p" | head -c "$want" | base64 | tr -d '\\n'; fi`,
    `printf '\\n'`,
  ].join('\n');
}

export function buildWriteScript({ path, mode = null, atomic = false, exclusive = false, tmpPath, nonce = makeNonce() }) {
  const p = shellQuote(path);
  const refuse = (code, fmt, arg) => refuseLine(nonce, code, fmt, arg);
  const lines = ['LC_ALL=C; export LC_ALL', `p=${p}`, `d=$(dirname -- "$p")`];

  if (exclusive) {
    // A cheap pre-check for the common case. It is NOT the guarantee — see the
    // `set -C` below, which is.
    lines.push(`if [ -e "$p" ]; then ${refuse('EEXIST', '%s: File exists', '"$p"')}; fi`);
  }
  if (atomic) {
    // An atomic write CREATES THE PARENT DIRECTORY (systems-protocol.md §6).
    lines.push(`mkdir -p -- "$d" 2>/dev/null`);
  }
  lines.push(
    `if [ ! -d "$d" ]; then`,
    `  if [ -e "$d" ]; then ${refuse('ENOTDIR', '%s: Not a directory', '"$d"')}; fi`,
    `  ${refuse('ENOENT', '%s: No such file or directory', '"$d"')}`,
    `fi`,
    `if [ -d "$p" ]; then ${refuse('EISDIR', '%s: Is a directory', '"$p"')}; fi`,
  );

  const chmod = mode === null || mode === undefined
    ? null
    : (mode & 0o7777).toString(8).padStart(4, '0');

  if (atomic) {
    // Temp-then-rename, so a reader never sees a torn write — and the rename is
    // what makes `mode` PRESERVING: chmod lands on the temp before it is
    // installed, so an edited script does not come back 0644 and silently stop
    // being executable.
    const t = shellQuote(tmpPath);
    lines.push(
      `if [ ! -w "$d" ]; then ${refuse('EACCES', '%s: Permission denied', '"$d"')}; fi`,
      `t=${t}`,
      `base64 -d > "$t" || { rc=$?; rm -f -- "$t"; exit $rc; }`,
      ...(chmod ? [`chmod ${chmod} -- "$t" || { rc=$?; rm -f -- "$t"; exit $rc; }`] : []),
      `mv -f -- "$t" "$p" || { rc=$?; rm -f -- "$t"; exit $rc; }`,
    );
  } else if (exclusive) {
    // THE ACTUAL GUARANTEE, and the reason the pre-check above is not enough.
    // Testing `-e` and then truncating in a separate command is check-then-act:
    // a writer creating the target in between would be TRUNCATED rather than
    // refused, which is precisely the lost update `exclusive` exists to prevent
    // ("callers catch EEXIST; that is how 'create if absent' stays safe against
    // a concurrent writer", systems-protocol.md §6). cc's own reference
    // provider gets this from the syscall, with `fs.writeFile(..., {flag:'wx'})`.
    //
    // `set -C` (noclobber) is the shell's O_EXCL and was measured honoured by
    // both dash and bash on this host. The two disagree on the message AND on
    // the exit code, which is exactly why the tag above carries the verdict.
    lines.push(
      `if [ ! -w "$d" ]; then ${refuse('EACCES', '%s: Permission denied', '"$d"')}; fi`,
      `set -C`,
      `base64 -d > "$p" || { rc=$?; set +C;`,
      `  if [ -e "$p" ]; then ${refuse('EEXIST', '%s: File exists', '"$p"')}; fi`,
      `  exit $rc; }`,
      `set +C`,
      ...(chmod ? [`chmod ${chmod} -- "$p" || exit $?`] : []),
    );
  } else {
    lines.push(
      `if [ -e "$p" ]; then`,
      `  if [ ! -w "$p" ]; then ${refuse('EACCES', '%s: Permission denied', '"$p"')}; fi`,
      `else`,
      `  if [ ! -w "$d" ]; then ${refuse('EACCES', '%s: Permission denied', '"$d"')}; fi`,
      `fi`,
      // A direct truncating redirect, matching fs.writeFile — which PRESERVES
      // an existing file's mode. Routing this through temp-then-rename would
      // silently reset the mode of every plain write.
      `base64 -d > "$p" || { rc=$?; exit $rc; }`,
      ...(chmod ? [`chmod ${chmod} -- "$p" || exit $?`] : []),
    );
  }
  return lines.join('\n');
}

// Read our own verdict off the tagged line if the script emitted one, and strip
// the tag from the stderr we report — cc surfaces that text to a user, and the
// marker is our plumbing.
function readTag(stderr, nonce) {
  const marker = `${ERR_TAG}-${nonce} `;
  const lines = String(stderr ?? '').split('\n');
  let code = null;
  const kept = [];
  for (const line of lines) {
    if (code === null && line.startsWith(marker)) {
      const c = line.slice(marker.length).trim();
      if (FS_ERROR_CODES.includes(c) || c === 'EFBIG') { code = c; continue; }
    }
    kept.push(line);
  }
  return { code, stderr: kept.join('\n') };
}

function refuse(stderr, exitCode, nonce, fallbackMessage) {
  const { code: tagged, stderr: text } = readTag(stderr, nonce);
  const detail = text.trim() || fallbackMessage;
  // A tagged line is OUR script speaking, and it is authoritative. Untagged
  // text is the far side's own tool, which is what classifyStderr is for.
  const code = tagged ?? classifyStderr(text);
  return new ProtocolError(code, detail, { exitCode, stderr: text });
}

/**
 * @param {(req:{script:string, stdinData?:Buffer|null}) => Promise<{code:number, stdout:Buffer, stderr:string}>} runExec
 * @returns {Promise<{size:number, mode:number, isBinary:boolean, data:Buffer}>}
 */
export async function readFileOp(runExec, { path, offset = 0, length = null, signal = null }) {
  const nonce = makeNonce();
  const script = buildReadScript({ path, offset, length, nonce });
  const { code, stdout, stderr } = await runExec({ script, signal });
  if (code !== 0) throw refuse(stderr, code, nonce, `read of '${path}' failed with exit ${code}`);

  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
  const nl = buf.indexOf(0x0a);
  const header = (nl === -1 ? buf : buf.subarray(0, nl)).toString('utf8');
  const parts = header.split(' ');
  if (parts[0] !== STAT_TAG || parts.length < 3) {
    throw new ProtocolError('EUNKNOWN', `read of '${path}' produced an unreadable header: ${header.slice(0, 120)}`,
      { exitCode: code, stderr: String(stderr ?? '') });
  }
  const mode = parseInt(parts[1], 16);
  const size = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(mode) || !Number.isFinite(size)) {
    throw new ProtocolError('EUNKNOWN', `read of '${path}' produced an unreadable stat: ${header.slice(0, 120)}`,
      { exitCode: code, stderr: String(stderr ?? '') });
  }
  const payload = nl === -1 ? '' : buf.subarray(nl + 1).toString('utf8').trim();
  const data = payload === '' ? Buffer.alloc(0) : Buffer.from(payload, 'base64');
  return {
    size,
    mode,
    // OF THE RETURNED RANGE, not of the file: a ranged read from an offset
    // answers about that range (systems-protocol.md §6).
    isBinary: data.subarray(0, BINARY_SNIFF_BYTES).includes(0),
    data,
  };
}

/**
 * @param {(req:{script:string, stdinData?:Buffer|null}) => Promise<{code:number, stdout:Buffer, stderr:string}>} runExec
 */
export async function writeFileOp(runExec, { path, data, mode = null, atomic = false, exclusive = false, signal = null }) {
  if (atomic && exclusive) {
    // An atomic write ends in a rename, which overwrites by definition, so the
    // combination has no honest meaning.
    throw new ProtocolError('EUNKNOWN', `'atomic' and 'exclusive' are mutually exclusive on a write to '${path}'`);
  }
  if (data.length > MAX_FILE_BYTES) {
    throw new ProtocolError('EFBIG', `write to '${path}' exceeds the ${MAX_FILE_BYTES}-byte protocol cap`);
  }
  const nonce = makeNonce();
  const script = buildWriteScript({ path, mode, atomic, exclusive, tmpPath: tempNameFor(path), nonce });
  // The payload rides to the far side as base64 on the command's stdin — never
  // through argv, which has a length limit and would put file bytes into a
  // process listing.
  const stdinData = Buffer.from(data.toString('base64'), 'utf8');
  const { code, stderr } = await runExec({ script, stdinData, signal });
  if (code !== 0) throw refuse(stderr, code, nonce, `write to '${path}' failed with exit ${code}`);
}
