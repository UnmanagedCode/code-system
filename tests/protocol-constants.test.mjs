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
  PROTOCOL_VERSION, classifyStderr, decodeFrame, isBase64,
} from '../src/launcher/protocol.mjs';

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

  assert.deepEqual(PROTOCOL_ERROR_CODES, [
    'EPROTO', 'ETRANSPORT', 'ETIMEDOUT', 'EUNSUPPORTED', 'ESHELLGONE',
    'EFBIG', 'ECANCELLED', 'ENOREMOTE',
  ], "cc's eight protocol-level codes, in cc's order");
  assert.deepEqual(FS_ERROR_CODES, [
    'ENOENT', 'EACCES', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EUNKNOWN',
  ], "cc's seven filesystem codes, in cc's order");
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

  const codes = (name) => {
    const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`).exec(src);
    assert.ok(m, `cc no longer exports ${name}`);
    return [...m[1].matchAll(/'([A-Z]+)'/g)].map(x => x[1]);
  };
  assert.deepEqual(PROTOCOL_ERROR_CODES, codes('PROTOCOL_ERROR_CODES'));
  assert.deepEqual(FS_ERROR_CODES, codes('FS_ERROR_CODES'));
});
