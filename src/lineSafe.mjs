// ONE LINE, WHATEVER THE TEXT: the escaping every surface applies to a value it
// interpolates into a line-oriented output — the MCP listing (src/mcp.mjs) and
// the agent broker's refusal records and log (src/agent/broker.mjs), where the
// value can come from an unauthenticated peer.
//
// The class is escaped as a class: the backslash first, so the result is
// unambiguous, then everything Unicode treats as a control or a line boundary —
// C0 (CR and LF among them), DEL, C1 (which includes U+0085 NEL, a mandatory
// break under UAX #14), and the U+2028 / U+2029 separators.

const SHORT = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const UNSAFE = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function lineSafe(value) {
  return String(value ?? '').replace(UNSAFE, (ch) =>
    SHORT[ch] ?? `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
}
