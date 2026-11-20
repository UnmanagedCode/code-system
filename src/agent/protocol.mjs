// THE AGENT WIRE, node side: the codec, the MACs and the constants — every one
// of which is READ from the PROTOCOL block inside agent/agent.py, so the Python
// agent and this side cannot drift. Nothing here restates a value that block
// owns (tests/agentprotocol.test.mjs scans for that).
//
// Spec: docs/agent-wire.md.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { AGENT_PY, AGENT_SRC_DIR } from '../paths.mjs';

const BLOCK_RE = /# BEGIN PROTOCOL\n[A-Z_]+ = r'''\n([\s\S]*?)\n'''\n# END PROTOCOL/;

/** The PROTOCOL object out of the agent's source text. */
export function extractProtocol(source) {
  const m = BLOCK_RE.exec(source);
  if (!m) throw new Error(`no PROTOCOL block in ${AGENT_PY}`);
  return JSON.parse(m[1]);
}

export const AGENT_SOURCE = readFileSync(AGENT_PY);
export const PROTOCOL = extractProtocol(AGENT_SOURCE.toString('utf8'));
export const LABELS = PROTOCOL.labels;

// The block's code lists, keyed by their camelCased spelling (`REFUSAL.authFailed`,
// `BYE.staleKey`). Read, never retyped.
const byName = list => Object.fromEntries(list.map(c => [c.replace(/[-_](\w)/g, (_, x) => x.toUpperCase()), c]));
export const REFUSAL = byName(PROTOCOL.refusalCodes);
export const BYE = byName(PROTOCOL.byeCodes);

// TEST-ONLY: a JSON object overriding PROTOCOL.timings keys, read by the agent,
// the broker and the bridge alike so a test can shrink every deadline at once.
export const TIMINGS_ENV = 'CODE_SYSTEM_AGENT_TIMINGS';

export function timings(env = process.env) {
  const out = { ...PROTOCOL.timings };
  const raw = String(env[TIMINGS_ENV] ?? '').trim();
  if (!raw) return out;
  const over = JSON.parse(raw);
  for (const [k, v] of Object.entries(over)) {
    if (Object.hasOwn(out, k) && typeof v === 'number' && v > 0) out[k] = v;
  }
  return out;
}

// ── the listen address (an operator setting, not a protocol constant) ──

export const LISTEN_ENV = 'CODE_SYSTEM_AGENT_LISTEN';
export const DEFAULT_LISTEN = '127.0.0.1:7420';

/** The listen address the operator asked for, as written. */
export function desiredListen(env = process.env) {
  return String(env[LISTEN_ENV] ?? '').trim() || DEFAULT_LISTEN;
}

/** `host:port` (or `[v6]:port`) → {host, port}, or throws naming the setting. */
export function parseListen(spec) {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(String(spec));
  const port = m ? Number(m[3]) : NaN;
  if (!m || port > 65535) {
    throw new Error(`${LISTEN_ENV} wants <host:port> (e.g. 0.0.0.0:7420), got ${JSON.stringify(spec)}`);
  }
  return { host: m[1] ?? m[2], port };
}

// ── the bridge's outcome line ────────────────────────────────────────

// The one stderr line a bridge writes when the outcome is ITS, not the far
// command's: `code-system-agent: <tag> <message>`. The kind's classifyFailure
// reads it back (src/launcher/kinds/agent.mjs).
export const MARKER_PREFIX = 'code-system-agent: ';
export const BRIDGE_TAGS = {
  brokerDown: 'broker-down',
  notConnected: 'not-connected',
  staleKey: BYE.staleKey,
  tooManyStreams: 'too-many-streams',
  lost: 'lost',
  neverStarted: 'never-started',
};
// Exit statuses a bridge uses for its own outcomes.
export const BRIDGE_EXIT_NEVER_STARTED = 127;
export const BRIDGE_EXIT_OWN = 255;

// ── codec ────────────────────────────────────────────────────────────

export class BadFrame extends Error {}

export function encode(frame) {
  return Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
}

/** Splits a byte stream into lines, refusing one longer than `cap`. */
export class LineDecoder {
  #parts = [];
  #len = 0;
  constructor(cap) { this.cap = cap; }

  push(chunk) {
    const lines = [];
    let start = 0;
    for (;;) {
      const i = chunk.indexOf(10, start);
      if (i < 0) break;
      const piece = chunk.subarray(start, i);
      if (this.#len + piece.length > this.cap) throw new BadFrame(`a line is longer than ${this.cap} bytes`);
      lines.push(this.#len ? Buffer.concat([...this.#parts, piece]) : piece);
      this.#parts = [];
      this.#len = 0;
      start = i + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length) {
      this.#len += rest.length;
      if (this.#len > this.cap) throw new BadFrame(`a line is longer than ${this.cap} bytes`);
      this.#parts.push(Buffer.from(rest));
    }
    return lines;
  }

  /** Bytes buffered past the last whole line. */
  get pending() { return this.#len; }
}

const HEX_RE = /^[0-9a-f]+$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const isInt = v => Number.isSafeInteger(v) && v >= 0;
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const CHECKS = {
  str: v => typeof v === 'string',
  hex: v => typeof v === 'string' && HEX_RE.test(v),
  int: isInt,
  bool: v => typeof v === 'boolean',
  strlist: v => Array.isArray(v) && v.every(x => typeof x === 'string'),
  argv: v => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string'),
  strmap: v => isPlain(v) && Object.values(v).every(x => typeof x === 'string'),
  b64: v => typeof v === 'string' && v.length % 4 === 0 && B64_RE.test(v)
    && Buffer.from(v, 'base64').toString('base64') === v,
  size: v => isPlain(v) && Object.keys(v).length === 2 && isInt(v.cols) && isInt(v.rows),
  'int|null': v => v === null || isInt(v),
  'str|null': v => v === null || typeof v === 'string',
};

/** Exact keys and types against `table[frame.t]`, or throws BadFrame. */
export function checkShape(frame, table) {
  if (!isPlain(frame) || typeof frame.t !== 'string') throw new BadFrame('a frame is an object with a string `t`');
  if (!Object.hasOwn(table, frame.t)) throw new BadFrame(`unknown frame '${frame.t}'`);
  const spec = table[frame.t];
  const seen = new Set(['t']);
  for (const [name, type] of Object.entries(spec)) {
    const optional = name.endsWith('?');
    const key = optional ? name.slice(0, -1) : name;
    if (!Object.hasOwn(frame, key)) {
      if (optional) continue;
      throw new BadFrame(`frame '${frame.t}' lacks '${key}'`);
    }
    seen.add(key);
    if (!CHECKS[type](frame[key])) throw new BadFrame(`frame '${frame.t}': '${key}' is not ${type}`);
  }
  const extra = Object.keys(frame).filter(k => !seen.has(k));
  if (extra.length) throw new BadFrame(`frame '${frame.t}' has unexpected keys ${extra.join(', ')}`);
  return frame;
}

/** One line → a shape-checked frame, or throws BadFrame. */
export function decodeLine(line, table) {
  let frame;
  try { frame = JSON.parse(line.toString('utf8')); }
  catch { throw new BadFrame('a line is not JSON'); }
  return checkShape(frame, table);
}

// ── the MACs ─────────────────────────────────────────────────────────

/** HMAC-SHA256, hex, keyed by the secret's UTF-8, over the fields joined with `\n`. */
export function mac(secret, fields) {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(fields.join('\n'), 'utf8').digest('hex');
}

/** Constant-time: the lengths are compared first, then the bytes. */
export function verifyMac(secret, fields, got) {
  if (typeof got !== 'string') return false;
  const want = Buffer.from(mac(secret, fields), 'utf8');
  const have = Buffer.from(got, 'utf8');
  return want.length === have.length && timingSafeEqual(want, have);
}

/**
 * The public name of a secret: which secret a session authenticated with,
 * comparable against the store without the secret itself ever travelling. It
 * is what a bridge's argv and a broker's status answer carry.
 */
export function keyIdOf(secret) {
  return createHash('sha256').update(`${LABELS.keyId}\n${secret}`, 'utf8').digest('hex')
    .slice(0, PROTOCOL.keyIdHexChars);
}

export const newNonce = () => randomBytes(PROTOCOL.nonceBytes).toString('hex');
export const newSessionId = () => randomBytes(PROTOCOL.sessionBytes).toString('hex');

/**
 * The broker's build: sha256 over agent.py and src/agent/*.mjs in name order.
 * The backend and the broker compute it the same way, so a plugin update
 * replaces a broker still running the old code.
 */
export function buildId() {
  const h = createHash('sha256');
  h.update(readFileSync(AGENT_PY));
  for (const name of readdirSync(AGENT_SRC_DIR).filter(n => n.endsWith('.mjs')).sort()) {
    h.update(`\n${name}\n`);
    h.update(readFileSync(path.join(AGENT_SRC_DIR, name)));
  }
  return h.digest('hex').slice(0, 16);
}
