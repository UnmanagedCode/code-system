// PINS our mirrored copy of cc's protocol constants against the documented
// values — and, when CC_CHECKOUT names a code-conductor checkout, against cc's
// OWN src/systems/protocol.ts, so drift is CAUGHT here rather than discovered
// on the wire as a truncated payload or a spurious EPROTO.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BINARY_SNIFF_BYTES, CHUNK_BYTES, FS_ERROR_CODES, MAX_FILE_BYTES, MAX_LINE_BYTES,
  MIRROR_EXCLUDE_MAX, MIRROR_PATH_MAX, NdjsonDecoder, PROTOCOL_ERROR_CODES,
  PROTOCOL_VERSION, REMOTE_ID_MAX, classifyStderr, decodeFrame, isBase64, remoteIdDefect,
} from '../src/launcher/protocol.mjs';
import { CC_FILE_KILL_MS } from './ccCheckout.mjs';

// UNGATED, and that is the point: the taxonomy claim used to live only in the
// CC_CHECKOUT-gated test below, which nothing in `npm test` runs — which is how
// a stale `EBUSY` survived cc removing it. Written out here as a literal, so an
// added, removed or reordered code reds a plain `npm test` with no checkout.
test('the constants equal the documented values', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(CHUNK_BYTES, 64 * 1024);
  assert.equal(MAX_FILE_BYTES, 32 * 1024 * 1024);
  assert.equal(BINARY_SNIFF_BYTES, 8 * 1024);
  assert.equal(MAX_LINE_BYTES, 4 * 1024 * 1024);
  assert.equal(MIRROR_EXCLUDE_MAX, 64);
  assert.equal(MIRROR_PATH_MAX, 4096);
  assert.equal(REMOTE_ID_MAX, 128);
  // Not a protocol constant — cc's per-file TEST hang guard, which the bound
  // conformance runner prints its wall-clock margin against
  // (tests/conformance-docker.mjs). Mirrored here for the same reason as the
  // rest: a copy nothing drift-checks measures against the wrong number the day
  // cc moves it.
  assert.equal(CC_FILE_KILL_MS, 90_000);

  assert.deepEqual(PROTOCOL_ERROR_CODES, [
    'EPROTO', 'ETRANSPORT', 'ETIMEDOUT', 'EUNSUPPORTED', 'ESHELLGONE',
    'EFBIG', 'ECANCELLED', 'ENOREMOTE',
  ], "cc's eight protocol-level codes, in cc's order");
  assert.deepEqual(FS_ERROR_CODES, [
    'ENOENT', 'EACCES', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'ENOTEMPTY', 'EINVAL',
    'ENAMETOOLONG', 'ELOOP',
    'EUNKNOWN',
  ], "cc's filesystem codes, in cc's order");
});

// PINS THE REMOTE-ID RULE cc's Remote field and `readRemoteList` share. Every
// id a `remoteList` carries must pass it, or cc refuses the whole enumeration.
test('remoteIdDefect names the defect cc refuses a Remote for', () => {
  assert.equal(remoteIdDefect(''), 'empty');
  assert.equal(remoteIdDefect('x'.repeat(REMOTE_ID_MAX)), null, 'the ceiling itself is accepted');
  assert.equal(remoteIdDefect('x'.repeat(REMOTE_ID_MAX + 1)), 'too-long');
  for (const c of [' ', '\t', '\n', '\u0000', '\u001f', '\u007f', '\u00a0']) {
    assert.equal(remoteIdDefect(`a${c}b`), 'invalid-char', JSON.stringify(c));
  }
  // `_`, `.`, `-` and upper case are legitimate in container names and hosts.
  assert.equal(remoteIdDefect('Ctr_1.a-b'), null);
});

test('strict base64: a lenient decode is what turns a corrupt chunk into a silent truncation', () => {
  assert.equal(isBase64('V09STEQ='), true);
  assert.equal(isBase64(''), true);
  assert.equal(isBase64('V09STEQ=!!corrupted'), false, 'a trailing tail is not canonical');
  assert.equal(isBase64('abc'), false, 'length must be a multiple of 4');
  assert.equal(isBase64('ab=c'), false, 'padding only at the end');
  assert.equal(isBase64('a b='), false);
});

test('the decoder ignores blank lines, rejects a bad payload, and holds a partial line', () => {
  const d = new NdjsonDecoder();
  assert.deepEqual(d.push(Buffer.from('\n  \n')), []);
  assert.deepEqual(d.push(Buffer.from('{"type":"ping"}\n')), [{ type: 'ping' }]);
  // A multi-byte character split across a chunk boundary still decodes: the
  // split is found on the RAW bytes, and 0x0A cannot occur inside a UTF-8
  // multi-byte sequence.
  const utf8 = Buffer.from('{"type":"x","v":"héllo"}\n');
  assert.deepEqual(d.push(utf8.subarray(0, 12)), []);
  assert.equal(d.pending, 12);
  assert.deepEqual(d.push(utf8.subarray(12)), [{ type: 'x', v: 'héllo' }]);
  assert.equal(d.pending, 0);

  for (const bad of ['{not json}', '[1,2,3]', '"a string"', '{"noType":1}', '{"type":""}']) {
    assert.throws(() => decodeFrame(bad), (e) => e.code === 'EPROTO', bad);
  }
  assert.throws(() => decodeFrame('{"type":"data","id":"a","seq":0}'),
    (e) => e.code === 'EPROTO', 'a payload frame with no dataB64');
  assert.throws(() => decodeFrame('{"type":"data","id":"a","seq":0,"dataB64":"V09STEQ=!!x"}'),
    (e) => e.code === 'EPROTO', 'a payload frame with non-canonical base64');
  // A dataB64 on a frame whose meaning is NOT its payload stays ignorable.
  assert.deepEqual(decodeFrame('{"type":"weird","dataB64":"!!"}'), { type: 'weird', dataB64: '!!' });
});

test('the classifier matches the strerror TAIL, not a tool prefix', () => {
  assert.equal(classifyStderr("stat: cannot statx '/p': No such file or directory"), 'ENOENT');
  assert.equal(classifyStderr("bfs: error: /p/.: Not a directory."), 'ENOTDIR');
  assert.equal(classifyStderr("find: '/p/.': Not a directory"), 'ENOTDIR');
  assert.equal(classifyStderr('Permission denied'), 'EACCES');
  assert.equal(classifyStderr('/x: File exists'), 'EEXIST');
  assert.equal(classifyStderr('Is a directory'), 'EISDIR');
  assert.equal(classifyStderr('No space left on device'), 'ENOSPC');
  assert.equal(classifyStderr("rm: cannot remove '/d': Directory not empty"), 'ENOTEMPTY');
  assert.equal(classifyStderr('readlink: /p: Invalid argument'), 'EINVAL');
  assert.equal(classifyStderr("stat: cannot statx '/p': File name too long"), 'ENAMETOOLONG');
  assert.equal(classifyStderr("cat: /loop: Too many levels of symbolic links"), 'ELOOP');
  assert.equal(classifyStderr('busybox says something else entirely'), 'EUNKNOWN');
});

// GATED, and it SKIPS rather than fails when the checkout is not there, so
// `npm test` needs nothing but Node. Its job is now pure DRIFT DETECTION — the
// claim itself is pinned ungated above — and `npm run conformance` runs this
// file first with the checkout in its environment, so "I ran conformance"
// implies "I checked for drift".
test('our mirror matches cc\'s own protocol.ts', { skip: !process.env.CC_CHECKOUT }, async () => {
  const src = await fs.readFile(
    path.join(process.env.CC_CHECKOUT, 'src', 'systems', 'protocol.ts'), 'utf8');

  const num = (name) => {
    const m = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`).exec(src);
    assert.ok(m, `cc no longer exports ${name}`);
    // The expressions are simple arithmetic over integers, by construction.
    assert.match(m[1], /^[\d*\s+]+$/, `${name} is no longer a plain arithmetic literal: ${m[1]}`);
    return Function(`return (${m[1]})`)();
  };
  assert.equal(PROTOCOL_VERSION, num('PROTOCOL_VERSION'));
  assert.equal(CHUNK_BYTES, num('CHUNK_BYTES'));
  assert.equal(MAX_FILE_BYTES, num('MAX_FILE_BYTES'));
  assert.equal(BINARY_SNIFF_BYTES, num('BINARY_SNIFF_BYTES'));
  assert.equal(MAX_LINE_BYTES, num('MAX_LINE_BYTES'));
  assert.equal(MIRROR_EXCLUDE_MAX, num('MIRROR_EXCLUDE_MAX'));
  assert.equal(MIRROR_PATH_MAX, num('MIRROR_PATH_MAX'));
  assert.equal(REMOTE_ID_MAX, num('REMOTE_ID_MAX'));

  const codes = (name) => {
    const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`).exec(src);
    assert.ok(m, `cc no longer exports ${name}`);
    return [...m[1].matchAll(/'([A-Z]+)'/g)].map(x => x[1]);
  };
  assert.deepEqual(PROTOCOL_ERROR_CODES, codes('PROTOCOL_ERROR_CODES'));
  assert.deepEqual(FS_ERROR_CODES, codes('FS_ERROR_CODES'));

  // THE SAME EXTRACTION OVER BOTH FILES, so the comparison is between two
  // source texts rather than between cc's text and a value we typed.
  const ours = await fs.readFile(new URL('../src/launcher/protocol.mjs', import.meta.url), 'utf8');
  assert.equal(remoteIdCharClass(ours), remoteIdCharClass(src),
    "remoteIdDefect's character class differs from cc's");
  assert.deepEqual(stderrTable(ours), stderrTable(src), "STDERR_TABLE differs from cc's");
});

// The regex literal on remoteIdDefect's `invalid-char` line.
function remoteIdCharClass(text) {
  const m = /if \((\/\[[^\n]*?\]\/)\.test\(id\)\) return 'invalid-char';/.exec(text);
  assert.ok(m, "no `if (/[…]/.test(id)) return 'invalid-char'` line");
  return m[1];
}

// Every `['<needle>', '<CODE>']` pair of STDERR_TABLE, in order.
function stderrTable(text) {
  const m = /const STDERR_TABLE[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
  assert.ok(m, 'no STDERR_TABLE literal');
  const pairs = [...m[1].matchAll(/\['([^']+)',\s*'([A-Z]+)'\]/g)].map(x => [x[1], x[2]]);
  // Two empty parses would compare equal and prove nothing.
  assert.ok(pairs.length > 0, 'STDERR_TABLE parsed to no rows — the literal format changed');
  return pairs;
}

// The same drift check for the one constant that is NOT in protocol.ts. cc's
// tests/hangGuardConfig.mjs is the single source for every hang-guard deadline,
// and each is `ms('<ENV>', <default>)` — so the default is what a mirror has to
// track. FOLDED IN HERE rather than given a mechanism of its own: this file is
// already the one that runs with CC_CHECKOUT in its environment, and both
// conformance runners run it first.
test('our mirror of cc\'s per-file hang guard matches cc\'s own', { skip: !process.env.CC_CHECKOUT }, async () => {
  const src = await fs.readFile(
    path.join(process.env.CC_CHECKOUT, 'tests', 'hangGuardConfig.mjs'), 'utf8');
  const m = /export const FILE_KILL_MS\s*=\s*ms\(\s*'CC_TEST_FILE_KILL_MS'\s*,\s*([\d_]+)\s*\)/.exec(src);
  assert.ok(m, 'cc no longer exports FILE_KILL_MS as ms(\'CC_TEST_FILE_KILL_MS\', <default>)');
  assert.equal(CC_FILE_KILL_MS, Number(m[1].replaceAll('_', '')),
    'the bound runner would print its hang-guard margin against a stale number');
});
