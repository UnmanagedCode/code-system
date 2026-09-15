// Our half of the System provider wire contract: the NDJSON codec, the
// spec-fixed constants and the stderr→code table.
//
// A MIRROR of code-conductor's src/systems/protocol.ts, deliberately. The
// values are spec-fixed (docs/systems-protocol.md §1) precisely so a provider
// does not have to negotiate them, and tests/protocol-constants.test.mjs parses
// cc's own file when CC_CHECKOUT is set so drift is CAUGHT rather than
// discovered on the wire.

export const PROTOCOL_VERSION = 1;

// Raw bytes per `data` frame, BEFORE base64. Both ends MUST chunk at it: a
// payload riding as one large frame breaches the line ceiling below.
export const CHUNK_BYTES = 64 * 1024;

// Per-file ceiling for readFile/writeFile. Above it, EFBIG.
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

// Bytes sniffed for a NUL to answer `isBinary` — of the RETURNED RANGE, not of
// the file (docs/systems-protocol.md §6).
export const BINARY_SNIFF_BYTES = 8 * 1024;

// A single NDJSON line longer than this is EPROTO. Enforced on the cc→launcher
// direction too: a framing fence catches a peer that never emits a newline.
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

// The ceilings cc enforces on a MIRROR ADVERTISEMENT (systems-protocol.md
// §2.1): more than MIRROR_EXCLUDE_MAX exclude entries, or a path longer than
// MIRROR_PATH_MAX, and cc refuses the advertisement on its own side
// (MIRROR_ADVERTISEMENT_INVALID, 502). Mirrored here so a kind that advertises
// `remoteDescriptors` knows the bound rather than discovering it as a refusal.
export const MIRROR_EXCLUDE_MAX = 64;
export const MIRROR_PATH_MAX = 4096;

// SIGTERM → SIGKILL delay when the frame names none.
export const DEFAULT_KILL_GRACE_MS = 100;

// The frames that OPEN an operation, and therefore the only ones carrying
// `remoteId`. Everything else inherits the binding through its `id` — AN ID IS
// BOUND TO ONE REMOTE FOR ITS WHOLE LIFETIME (§4).
export const REQUEST_FRAMES = new Set(['exec', 'readFile', 'writeFile', 'describeRemote']);

// The frame types whose meaning IS their payload, so a bad payload is a bad
// frame.
const PAYLOAD_FRAMES = new Set(['stdout', 'stderr', 'data']);

export const PROTOCOL_ERROR_CODES = [
  'EPROTO', 'ETRANSPORT', 'ETIMEDOUT', 'EUNSUPPORTED', 'ESHELLGONE',
  'EFBIG', 'ECANCELLED', 'ENOREMOTE',
];

export const FS_ERROR_CODES = [
  'ENOENT', 'EACCES', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'ENOTEMPTY', 'EINVAL',
  'EUNKNOWN',
];

// stderr text → code, for a command that ran and exited non-zero. Substring
// matching on the strerror() TAIL, because the prefix varies by tool while the
// tail does not — which is what LC_ALL=C is for on every command we send.
//
// Our own far-side scripts normalise their failures to these exact tails
// (src/launcher/fileops.mjs): shells disagree here — `set -C` says "cannot
// overwrite existing file" on bash and "File exists" on dash — and cc's callers
// branch on the resulting codes, so guessing is not available to us.
const STDERR_TABLE = [
  ['No such file or directory', 'ENOENT'],
  ['Permission denied', 'EACCES'],
  ['File exists', 'EEXIST'],
  ['Not a directory', 'ENOTDIR'],
  ['Is a directory', 'EISDIR'],
  ['No space left on device', 'ENOSPC'],
  // cc's `removeEntry` is NON-RECURSIVE, so this is an answer its caller acts
  // on rather than a surprise: a directory still holding children the worker
  // never enumerated fails the op instead of taking them with it.
  ['Directory not empty', 'ENOTEMPTY'],
  // `readlink` of a path that is not a symlink. The taxonomy is CLOSED — every
  // errno a derived command can produce is named — because naming it is what
  // lets a caller tell "that is not a symlink" from "the box hiccuped".
  ['Invalid argument', 'EINVAL'],
];

export function classifyStderr(stderr) {
  for (const [needle, code] of STDERR_TABLE) {
    if (stderr.includes(needle)) return code;
  }
  return 'EUNKNOWN';
}

// A node spawn failure carries its errno as a TOKEN ('spawn /bin/sh ENOENT'),
// not as strerror() text, so it needs its own reader.
export function classifySpawnError(err) {
  const code = err?.code;
  if (typeof code === 'string' && FS_ERROR_CODES.includes(code)) return code;
  const message = err instanceof Error ? err.message : String(err);
  for (const c of FS_ERROR_CODES) {
    if (c !== 'EUNKNOWN' && new RegExp(`\\b${c}\\b`).test(message)) return c;
  }
  return 'EUNKNOWN';
}

// The one error type this layer throws. `code` is what the frame loop puts on
// the wire.
export class ProtocolError extends Error {
  constructor(code, message, { exitCode = null, stderr = null } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

// Strict base64: canonical alphabet, correct padding, length a multiple of 4.
// Two linear tests rather than one regex with a `*` group, so a megabyte of
// garbage cannot become a backtracking cost.
const B64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

export function isBase64(v) {
  return typeof v === 'string' && v.length % 4 === 0 && B64_CHARS.test(v);
}

function clip(s) {
  return s.length <= 200 ? s : `${s.slice(0, 200)}…`;
}

export function decodeFrame(text) {
  let v;
  try { v = JSON.parse(text); }
  catch { throw new ProtocolError('EPROTO', `not JSON: ${clip(text)}`); }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ProtocolError('EPROTO', `frame is not an object: ${clip(text)}`);
  }
  if (typeof v.type !== 'string' || v.type === '') {
    throw new ProtocolError('EPROTO', `frame has no type: ${clip(text)}`);
  }
  // A PAYLOAD IS PART OF THE FRAME. `Buffer.from(s, 'base64')` is lenient — it
  // stops at the first unreadable character and returns the prefix — so
  // decoding without this check turns a corrupted chunk into a SILENT PARTIAL
  // ANSWER: a writeFile reporting success having dropped its tail. Checked
  // here, once, for every payload frame in the cc→launcher direction.
  if (PAYLOAD_FRAMES.has(v.type)) {
    if (typeof v.dataB64 !== 'string') {
      throw new ProtocolError('EPROTO', `'${v.type}' frame has no dataB64: ${clip(text)}`);
    }
    if (!isBase64(v.dataB64)) {
      throw new ProtocolError('EPROTO', `'${v.type}' frame carries invalid base64: ${clip(text)}`);
    }
  }
  return v;
}

// Line-buffered NDJSON decoder. A malformed line is FATAL, not skipped: a
// stream that has proved it cannot be framed cannot be trusted for what
// follows.
//
// Bytes are buffered rather than decoded per chunk so a multi-byte character
// split across a chunk boundary still decodes; the split is found on the RAW
// bytes, which is safe because 0x0A cannot occur inside a UTF-8 multi-byte
// sequence.
export class NdjsonDecoder {
  #buf = Buffer.alloc(0);
  #maxLineBytes;

  constructor({ maxLineBytes = MAX_LINE_BYTES } = {}) {
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk) {
    try { return this.#push(chunk); }
    catch (e) {
      // Any EPROTO drops the buffer: the caller tears the connection down, and
      // keeping bytes would hand the next push a boundary we cannot find.
      this.#buf = Buffer.alloc(0);
      throw e;
    }
  }

  #push(chunk) {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out = [];
    let start = 0;
    for (;;) {
      const nl = this.#buf.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = this.#buf.subarray(start, nl);
      start = nl + 1;
      if (line.length > this.#maxLineBytes) {
        throw new ProtocolError('EPROTO', `frame exceeded ${this.#maxLineBytes} bytes`);
      }
      // A blank line (or a stray \r\n) is whitespace between frames, not an
      // error — a hand-written provider will emit them.
      const text = line.toString('utf8').trim();
      if (text === '') continue;
      out.push(decodeFrame(text));
    }
    this.#buf = start === 0 ? this.#buf : this.#buf.subarray(start);
    if (this.#buf.length > this.#maxLineBytes) {
      throw new ProtocolError('EPROTO', `frame exceeded ${this.#maxLineBytes} bytes`);
    }
    return out;
  }

  get pending() { return this.#buf.length; }
}
