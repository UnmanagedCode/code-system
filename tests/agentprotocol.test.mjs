// PINS THE AGENT WIRE'S SINGLE SOURCE OF TRUTH: the PROTOCOL block inside
// agent/agent.py is what BOTH sides read, the MAC construction is identical in
// node and Python (by golden vector, not by comparing the two to each other
// only), and no protocol constant is restated in src/agent/*.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { AGENT_PY, NEEDS_PYTHON, PY } from './agentFixture.mjs';
import {
  BadFrame, LineDecoder, PROTOCOL, checkShape, extractProtocol, keyIdOf, mac, verifyMac,
} from '../src/agent/protocol.mjs';

// Python's own reading of the same file, as JSON.
function pythonEval(expr, prelude = '') {
  const code = 'import importlib.util,json,sys\n'
    + `s=importlib.util.spec_from_file_location("agent", ${JSON.stringify(AGENT_PY)})\n`
    + 'a=importlib.util.module_from_spec(s); s.loader.exec_module(a)\n'
    + prelude
    + `print(json.dumps(${expr}))`;
  return JSON.parse(execFileSync(PY.python, ['-I', '-c', code], { encoding: 'utf8' }));
}

test('node extracts the PROTOCOL block that Python loads, value for value', { skip: NEEDS_PYTHON }, () => {
  assert.deepEqual(extractProtocol(readFileSync(AGENT_PY, 'utf8')), pythonEval('a.PROTOCOL'));
  assert.deepEqual(PROTOCOL, pythonEval('a.PROTOCOL'));
  // The constants the plan fixes, read through the block.
  assert.equal(PROTOCOL.nonceBytes, 32);
  assert.equal(PROTOCOL.maxFrameBytes, 131072);
  assert.equal(PROTOCOL.windowBytes, 262144);
});

// A GOLDEN VECTOR: a literal digest, so changing the construction on BOTH sides
// at once (field order, separator, label) still fails here.
const GOLDEN = {
  secret: 'golden-secret',
  fields: ['code-system-agent/1 agent', 'rid', 'nb', 'na'],
  mac: 'a258286c1d0bb11cc356738f7069f7c68aa1518a7c464f4450b5f3608a03e3f9',
  keyId: '6a1c4a90376d512d',
};

test('the MAC and key id match a golden vector in node and in Python', { skip: NEEDS_PYTHON }, () => {
  assert.equal(mac(GOLDEN.secret, GOLDEN.fields), GOLDEN.mac);
  assert.equal(keyIdOf(GOLDEN.secret), GOLDEN.keyId);
  assert.equal(pythonEval(`a.mac(${JSON.stringify(GOLDEN.secret)}, ${JSON.stringify(GOLDEN.fields)})`), GOLDEN.mac);
  assert.equal(pythonEval(`a.key_id_of(${JSON.stringify(GOLDEN.secret)})`), GOLDEN.keyId);
  // Non-ASCII secrets are keyed by their UTF-8 on both sides.
  const s = 'sécret-ü';
  assert.equal(pythonEval(`a.mac(${JSON.stringify(s)}, ["x"])`), mac(s, ['x']));
});

test('verifyMac accepts only the exact MAC, whatever the length of the guess', () => {
  assert.equal(verifyMac(GOLDEN.secret, GOLDEN.fields, GOLDEN.mac), true);
  assert.equal(verifyMac(GOLDEN.secret, GOLDEN.fields, GOLDEN.mac.toUpperCase()), false);
  assert.equal(verifyMac(GOLDEN.secret, GOLDEN.fields, GOLDEN.mac.slice(0, -1)), false);
  assert.equal(verifyMac(GOLDEN.secret, GOLDEN.fields, ''), false);
  assert.equal(verifyMac(GOLDEN.secret, GOLDEN.fields, null), false);
  // Domain separation: the broker's label over the same fields is a different MAC.
  assert.equal(verifyMac(GOLDEN.secret, ['code-system-agent/1 broker', ...GOLDEN.fields.slice(1)], GOLDEN.mac), false);
});

// The shape checker both sides run; Python's verdict must agree case by case.
const SHAPES = [
  [{ t: 'hello', v: 1, remoteId: 'r', nonce: 'ab' }, true],
  [{ t: 'hello', v: 1, remoteId: 'r', nonce: 'AB' }, false],
  [{ t: 'hello', v: 1, remoteId: 'r' }, false],
  [{ t: 'hello', v: 1, remoteId: 'r', nonce: 'ab', extra: 1 }, false],
  [{ t: 'hello', v: true, remoteId: 'r', nonce: 'ab' }, false],
  [{ t: 'hello', v: -1, remoteId: 'r', nonce: 'ab' }, false],
  [{ t: 'out', s: 1, fd: 1, b64: 'aGk=' }, true],
  [{ t: 'out', s: 1, fd: 1, b64: 'aGk' }, false],
  [{ t: 'out', s: 1, fd: 1, b64: 'aGl=' }, false],
  [{ t: 'open', s: 1, argv: ['a'], cwd: '/', env: { A: 'b' }, stdin: false }, true],
  [{ t: 'open', s: 1, argv: ['a'], cwd: '/', env: { A: 'b' }, stdin: false, pty: { cols: 80, rows: 24 } }, true],
  [{ t: 'open', s: 1, argv: ['a'], cwd: '/', env: { A: 1 }, stdin: false }, false],
  [{ t: 'open', s: 1, argv: [], cwd: '/', env: {}, stdin: false }, false],
  [{ t: 'open', s: 1, argv: ['a'], cwd: '/', env: {}, stdin: false, pty: { cols: 80 } }, false],
  [{ t: 'exit', s: 1, code: null, signal: 'SIGINT' }, true],
  [{ t: 'exit', s: 1, code: 0, signal: null }, true],
  [{ t: 'nope' }, false],
  [{ t: 'ping' }, true],
  [['ping'], false],
];

test('checkShape refuses every extra, missing or mistyped key, and Python agrees', { skip: NEEDS_PYTHON }, () => {
  const node = SHAPES.map(([f]) => { try { checkShape(f, PROTOCOL.wire); return true; } catch (e) { assert.ok(e instanceof BadFrame); return false; } });
  assert.deepEqual(node, SHAPES.map(([, ok]) => ok));
  const cases = JSON.stringify(SHAPES.map(([f]) => f));
  const py = pythonEval(`[ok(f) for f in json.loads(${JSON.stringify(cases)})]`,
    'def ok(f):\n    try:\n        a.check_shape(f, a.WIRE)\n        return True\n    except a.BadFrame:\n        return False\n');
  assert.deepEqual(py, node);
});

test('LineDecoder refuses a line past its cap, whether it arrives whole or in pieces', () => {
  const d = new LineDecoder(8);
  assert.deepEqual(d.push(Buffer.from('12345678\nab')).map(String), ['12345678']);
  assert.deepEqual(d.push(Buffer.from('c\n')).map(String), ['abc']);
  assert.throws(() => new LineDecoder(8).push(Buffer.from('123456789\n')), BadFrame);
  const p = new LineDecoder(8);
  p.push(Buffer.from('12345'));
  assert.throws(() => p.push(Buffer.from('6789')), BadFrame);
});

// code-hub V17 style: a constant the PROTOCOL block owns is never typed again
// in the modules that speak the wire — they read it.
test('no protocol constant is restated in src/agent/* or the agent kind', () => {
  const files = [
    ...readdirSync(path.join(REPO, 'src', 'agent')).filter(n => n.endsWith('.mjs')).map(n => path.join(REPO, 'src', 'agent', n)),
    path.join(REPO, 'src', 'launcher', 'kinds', 'agent.mjs'),
  ];
  // EVERY LEAF of the PROTOCOL block, so a constant added to it is covered with
  // no edit here. Excluded, each for a stated reason:
  //   - the shape tables' values (`hex`, `int|null`, …): a type vocabulary the
  //     checker in protocol.mjs is what defines;
  //   - numbers below 100: generic sizes and counts (a 32-byte secret, a
  //     16-character slice) that would collide with any protocol value that small;
  //   - 1000 and 10000: round millisecond values this code uses for its OWN local
  //     timeouts (a ping's deadline, the supervisor's tick), not protocol timings.
  const SHAPE_TABLES = new Set(['wire', 'control', 'toBridge']);
  const ROUND_MS = new Set([1000, 10000]);
  const leaves = [];
  const walk = (v, top) => {
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, top ?? k); return; }
    if (!SHAPE_TABLES.has(top)) leaves.push(v);
  };
  walk(PROTOCOL, null);
  const strings = [...new Set(leaves.filter(v => typeof v === 'string'))].map(c => `'${c}'`);
  const numbers = [...new Set(leaves.filter(v => typeof v === 'number' && v >= 100 && !ROUND_MS.has(v)))];
  assert.ok(numbers.includes(PROTOCOL.maxStreamsPerSession) && numbers.includes(PROTOCOL.timings.keepaliveTimeoutMs),
    'the scan really covers counts and timings');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const s of strings) assert.equal(src.includes(s), false, `${path.basename(f)} restates '${s}'`);
    for (const n of numbers) {
      const re = new RegExp(`(?<![\\w.])(${n}|${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_')})(?![\\w.])`);
      assert.equal(re.test(src), false, `${path.basename(f)} restates ${n}`);
    }
  }
});
