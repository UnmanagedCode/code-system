// TEST-ONLY. The reply contract cc's bridge holds a plugin's MCP answers to,
// checked against THIS manifest's own `outputSchema`s. Importing it already
// proves every tool's schema is inside cc's validated subset.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { checkSchema, validate } from './_jsonSchemaSubset.mjs';

export const MANIFEST = JSON.parse(readFileSync(path.join(REPO, 'conductor.plugin.json'), 'utf8'));

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

for (const tool of MANIFEST.mcp.tools) {
  if (tool.outputSchema === undefined) continue;
  checkSchema(tool.outputSchema, `${tool.name}.outputSchema`);
  assert.equal(tool.outputSchema.type, 'object', `${tool.name}.outputSchema must have a root type of object`);
}

/**
 * Assert one `POST /mcp` reply is contract-shaped for the format requested
 * (`undefined` means text): a refusal is `{error, code, details?}`; json is
 * exactly `{structured}` and valid against the tool's `outputSchema`; text is
 * `{text, meta?}` with a string `text`.
 */
export function checkReply(tool, format, status, body) {
  assert.ok(isPlain(body), 'the body is a JSON object');
  if ('error' in body) {
    assert.ok(Object.keys(body).every(k => ['error', 'code', 'details'].includes(k)), `refusal keys: ${Object.keys(body)}`);
    assert.equal(typeof body.error, 'string');
    assert.match(body.code, /^[A-Z][A-Z0-9_]*$/, 'a refusal carries a SCREAMING_SNAKE code');
    if ('details' in body) assert.ok(isPlain(body.details), 'details is an object');
    return;
  }
  assert.equal(status, 200);
  if (format === 'json') {
    assert.deepEqual(Object.keys(body), ['structured']);
    assert.ok(isPlain(body.structured));
    const schema = MANIFEST.mcp.tools.find(t => t.name === tool)?.outputSchema;
    assert.ok(schema, `${tool} declares an outputSchema`);
    assert.deepEqual(validate(schema, body.structured), []);
    return;
  }
  assert.ok(Object.keys(body).every(k => ['text', 'meta'].includes(k)), `text keys: ${Object.keys(body)}`);
  assert.equal(typeof body.text, 'string');
}
