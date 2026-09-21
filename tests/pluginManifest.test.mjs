// PINS THE MANIFEST, which is the one file in this repo whose failures are all
// invisible here: the conductor reads it at plugin discovery, and a manifest it
// refuses leaves the plugin `invalid` and never startable. No test in this repo
// runs under the conductor, so these assertions are the only place that reach
// is available.
//
// THIS DOES NOT RE-IMPLEMENT THE CONDUCTOR'S VALIDATOR. A local copy of
// somebody else's checker drifts from it silently and then lies in both
// directions. What is asserted here is what THIS manifest declares — one flat,
// scalar-typed schema — which is inside the subset whatever that subset's exact
// edges turn out to be.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const readJson = async (name) => JSON.parse(await fs.readFile(path.join(REPO, name), 'utf8'));

test('the manifest version matches package.json', async () => {
  const pkg = await readJson('package.json');
  const manifest = await readJson('conductor.plugin.json');
  assert.equal(manifest.version, pkg.version);
});

test('the required top-level fields are what the conductor mounts', async () => {
  const manifest = await readJson('conductor.plugin.json');
  assert.equal(manifest.id, 'code-system');
  assert.equal(manifest.name, 'Code System');
  assert.equal(manifest.pluginApi, 1);
  assert.equal(manifest.backend.start, 'npm start');
  assert.equal(manifest.backend.healthPath, '/api/health');
  assert.equal(manifest.frontend.path, '/');
  // The route src/api.mjs actually serves. A mismatch is a tool that 404s.
  assert.equal(manifest.mcp.endpoint, '/api/mcp');
});

// PINS THE TOOL ROSTER. This plugin's MCP surface is READ-ONLY — the card UI
// and the REST API stay the only writers — so a mutating tool appearing here is
// a decision being overturned, not a feature being added, and it fails this
// test first.
test('mcp.tools is exactly the read-only roster', async () => {
  const manifest = await readJson('conductor.plugin.json');
  assert.deepEqual(manifest.mcp.tools.map(t => t.name).sort(), ['list_remotes']);
  for (const tool of manifest.mcp.tools) {
    assert.ok(tool.description && tool.description.length > 0, `${tool.name} needs a description`);
  }
});

// PINS THE OMISSION OF `mcp.scope`, which is a decision and not an oversight:
// the conductor ACCEPTS the key, does not normalise it onto the plugin record
// and does not enum-check it, and `toolsFor()` takes no caller argument — every
// enabled plugin's tools are visible to every caller. A `scope` here would be a
// claim about routing that nothing implements.
test('the mcp block declares no scope', async () => {
  const manifest = await readJson('conductor.plugin.json');
  assert.equal('scope' in manifest.mcp, false,
    'mcp.scope is inert — declaring one would claim a routing this plugin does not get');
});

// PINS THE SCHEMA THIS MANIFEST DECLARES as flat and scalar-typed. A schema
// outside the conductor's subset — a `$ref`, a combinator, a nested object, a
// key it does not recognise — is refused at load, and the plugin is never
// startable. `list_remotes` takes no arguments at all, which is the simplest
// point inside that subset.
test('every tool schema is a flat object of scalar properties', async () => {
  const manifest = await readJson('conductor.plugin.json');
  const SCALARS = new Set(['string', 'number', 'integer', 'boolean']);
  for (const tool of manifest.mcp.tools) {
    const schema = tool.inputSchema;
    const label = `${tool.name}.inputSchema`;
    assert.equal(schema.type, 'object', `${label}.type`);
    // Only keys the conductor's subset recognises. Asserted as an allowlist
    // rather than a denylist of combinators, so an unrecognised key added later
    // fails here whatever it is.
    for (const key of Object.keys(schema)) {
      assert.ok(['type', 'properties', 'required', 'description', 'additionalProperties'].includes(key),
        `${label} declares '${key}', which the conductor's schema subset does not accept`);
    }
    for (const [prop, spec] of Object.entries(schema.properties ?? {})) {
      assert.ok(SCALARS.has(spec.type), `${label}.properties.${prop}.type must be a scalar`);
    }
  }
});
