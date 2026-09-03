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
// (docs/systems-protocol.md:657). Deriving here gives both kinds one
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

import {
  BINARY_SNIFF_BYTES, MAX_FILE_BYTES, ProtocolError, classifyStderr,
} from './protocol.mjs';

// Single-quote for `sh -c`. Everything we interpolate is a path or a number
// from a frame, so nothing may be allowed to reach the shell as syntax.
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// The header the read script prints before the payload, so a host-side parse
// never has to guess where `stat`'s output ends and the file's bytes begin.
const STAT_TAG = 'CCSTAT';
// stderr marker for the one refusal the script makes on its own behalf.
const EFBIG_TAG = 'CCEFBIG';

let tmpSeq = 0;

export function tempNameFor(targetPath) {
  return `${targetPath}.${process.pid}.${tmpSeq++}.tmp`;
}

export function buildReadScript({ path, offset = 0, length = null, maxBytes = MAX_FILE_BYTES }) {
  const p = shellQuote(path);
  const off = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const wantExpr = length === null || length === undefined
    ? `want=$((size - ${off})); if [ "$want" -lt 0 ]; then want=0; fi`
    : `want=${Math.max(0, Math.trunc(length))}`;
  return [
    'LC_ALL=C; export LC_ALL',
    `p=${p}`,
    // Order matters: existence first (a broken symlink is ENOENT because -e
    // follows), then directory, then readability.
    `if [ ! -e "$p" ]; then printf '%s: No such file or directory\\n' "$p" >&2; exit 2; fi`,
    `if [ -d "$p" ]; then printf '%s: Is a directory\\n' "$p" >&2; exit 21; fi`,
    `if [ ! -r "$p" ]; then printf '%s: Permission denied\\n' "$p" >&2; exit 13; fi`,
    // -L follows symlinks, matching fs.stat. %f is the RAW mode so the type
    // bits survive; %s is the whole file's size, which is what
    // readFileResult.size means regardless of the range returned.
    `st=$(stat -L -c '%f %s' -- "$p") || exit 1`,
    'set -- $st',
    'mode=$1; size=$2',
    wantExpr,
    // Refused BEFORE a byte is transferred.
    `if [ "$want" -gt ${maxBytes} ]; then printf '${EFBIG_TAG} %s\\n' "$want" >&2; exit 27; fi`,
    `printf '${STAT_TAG} %s %s\\n' "$mode" "$size"`,
    `if [ "$want" -gt 0 ]; then tail -c +${off + 1} -- "$p" | head -c "$want" | base64 | tr -d '\\n'; fi`,
    `printf '\\n'`,
  ].join('\n');
}

export function buildWriteScript({ path, mode = null, atomic = false, exclusive = false, tmpPath }) {
  const p = shellQuote(path);
  const lines = ['LC_ALL=C; export LC_ALL', `p=${p}`, `d=$(dirname -- "$p")`];

  if (exclusive) {
    // Tested explicitly, and the tail emitted by us, because this is the code
    // cc's "create if absent" callers branch on.
    lines.push(`if [ -e "$p" ]; then printf '%s: File exists\\n' "$p" >&2; exit 17; fi`);
  }
  if (atomic) {
    // An atomic write CREATES THE PARENT DIRECTORY (docs/systems-protocol.md:456).
    lines.push(`mkdir -p -- "$d" 2>/dev/null`);
  }
  lines.push(
    `if [ ! -d "$d" ]; then`,
    `  if [ -e "$d" ]; then printf '%s: Not a directory\\n' "$d" >&2; exit 20; fi`,
    `  printf '%s: No such file or directory\\n' "$d" >&2; exit 2`,
    `fi`,
    `if [ -d "$p" ]; then printf '%s: Is a directory\\n' "$p" >&2; exit 21; fi`,
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
      `if [ ! -w "$d" ]; then printf '%s: Permission denied\\n' "$d" >&2; exit 13; fi`,
      `t=${t}`,
      `base64 -d > "$t" || { rc=$?; rm -f -- "$t"; exit $rc; }`,
      ...(chmod ? [`chmod ${chmod} -- "$t" || { rc=$?; rm -f -- "$t"; exit $rc; }`] : []),
      `mv -f -- "$t" "$p" || { rc=$?; rm -f -- "$t"; exit $rc; }`,
    );
  } else {
    lines.push(
      `if [ -e "$p" ]; then`,
      `  if [ ! -w "$p" ]; then printf '%s: Permission denied\\n' "$p" >&2; exit 13; fi`,
      `else`,
      `  if [ ! -w "$d" ]; then printf '%s: Permission denied\\n' "$d" >&2; exit 13; fi`,
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

function refuse(stderr, exitCode, fallbackMessage) {
  const text = String(stderr ?? '');
  if (text.includes(EFBIG_TAG)) {
    const want = text.split(EFBIG_TAG)[1]?.trim().split(/\s/)[0] ?? '?';
    return new ProtocolError('EFBIG', `${want} bytes requested, above the ${MAX_FILE_BYTES}-byte protocol cap`,
      { exitCode, stderr: text });
  }
  const code = classifyStderr(text);
  const detail = text.trim() || fallbackMessage;
  return new ProtocolError(code, detail, { exitCode, stderr: text });
}

/**
 * @param {(req:{script:string, stdinData?:Buffer|null}) => Promise<{code:number, stdout:Buffer, stderr:string}>} runExec
 * @returns {Promise<{size:number, mode:number, isBinary:boolean, data:Buffer}>}
 */
export async function readFileOp(runExec, { path, offset = 0, length = null }) {
  const script = buildReadScript({ path, offset, length });
  const { code, stdout, stderr } = await runExec({ script });
  if (code !== 0) throw refuse(stderr, code, `read of '${path}' failed with exit ${code}`);

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
    // answers about that range (docs/systems-protocol.md:439).
    isBinary: data.subarray(0, BINARY_SNIFF_BYTES).includes(0),
    data,
  };
}

/**
 * @param {(req:{script:string, stdinData?:Buffer|null}) => Promise<{code:number, stdout:Buffer, stderr:string}>} runExec
 */
export async function writeFileOp(runExec, { path, data, mode = null, atomic = false, exclusive = false }) {
  if (atomic && exclusive) {
    // An atomic write ends in a rename, which overwrites by definition, so the
    // combination has no honest meaning.
    throw new ProtocolError('EUNKNOWN', `'atomic' and 'exclusive' are mutually exclusive on a write to '${path}'`);
  }
  if (data.length > MAX_FILE_BYTES) {
    throw new ProtocolError('EFBIG', `write to '${path}' exceeds the ${MAX_FILE_BYTES}-byte protocol cap`);
  }
  const script = buildWriteScript({ path, mode, atomic, exclusive, tmpPath: tempNameFor(path) });
  // The payload rides to the far side as base64 on the command's stdin — never
  // through argv, which has a length limit and would put file bytes into a
  // process listing.
  const stdinData = Buffer.from(data.toString('base64'), 'utf8');
  const { code, stderr } = await runExec({ script, stdinData });
  if (code !== 0) throw refuse(stderr, code, `write to '${path}' failed with exit ${code}`);
}
