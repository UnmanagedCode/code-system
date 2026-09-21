// PINS THE PLUGIN-COMPLIANCE ITEMS A UNIT TEST CAN REACH, by reading the files
// off disk — cc's own tests/static.test.mjs does exactly this. Deterministic,
// no browser, no server.
//
// These three are worth a test rather than a comment because each fails ONLY
// once the plugin is mounted under code-conductor, which is the one place no
// test in this repo runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const FRONTEND = path.join(REPO, 'frontend');
const read = name => fs.readFile(path.join(FRONTEND, name), 'utf8');

// PINS compliance item 4: the bridge tag, EXACTLY. cc serves /pluginBridge.js
// itself, so this one URL is absolute by requirement, and the checklist asks
// for this literal tag rather than an equivalent.
test('index.html carries the pluginBridge tag verbatim', async () => {
  const html = await read('index.html');
  assert.ok(html.includes('<script src="/pluginBridge.js" defer></script>'),
    'the compliance checklist asks for this exact tag');
  assert.equal((html.match(/pluginBridge\.js/g) ?? []).length, 1, 'exactly once');
});

// PINS compliance item 3, BASE-PATH COMPLIANCE. The plugin is served under an
// X-Forwarded-Prefix it never learns, so any other absolute URL 404s the
// instant it is mounted under cc — while working perfectly standalone, which is
// what makes this failure mode so easy to ship.
test('every asset URL except the bridge is relative, and resolves to a real file', async () => {
  const html = await read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 3, 'the page references its own assets');

  for (const ref of refs) {
    if (ref === '/pluginBridge.js') continue;
    assert.doesNotMatch(ref, /^\//, `'${ref}' is absolute — it would 404 under a forwarded prefix`);
    assert.doesNotMatch(ref, /^[a-z][a-z0-9+.-]*:/i, `'${ref}' is a scheme URL`);
    // A relative ref that names nothing is a 404 in both deployments.
    await fs.access(path.join(FRONTEND, ref.split('?')[0]));
  }
});

// PINS the same rule on the SIDE THE HTML CANNOT SHOW: every fetch app.js makes
// is relative too. An absolute `/api/...` is the exact shape that works
// standalone and breaks under the prefix.
test('app.js fetches nothing absolute', async () => {
  const js = await read('app.js');
  for (const m of js.matchAll(/(?:api\(\s*'[A-Z]+'\s*,\s*|fetch\(\s*)(['"`])([^'"`]*)\1/g)) {
    assert.doesNotMatch(m[2], /^\//, `fetch target '${m[2]}' is absolute`);
    assert.doesNotMatch(m[2], /^[a-z][a-z0-9+.-]*:/i, `fetch target '${m[2]}' is a scheme URL`);
  }
  // And the template-literal paths, which the pattern above cannot see whole.
  assert.doesNotMatch(js, /['"`]\/api\//, 'no absolute /api/ path anywhere');
});

// PINS THE SEAM the whole frontend test strategy rests on: cardState.mjs is
// PURE. The moment it touches the DOM it stops being unit-testable with
// `node --test`, and the card's decisions become browser-only again.
test('cardState.mjs touches no browser global', async () => {
  const js = await read('cardState.mjs');
  for (const global of ['document', 'window', 'localStorage', 'navigator', 'fetch(']) {
    assert.equal(js.includes(global), false,
      `cardState.mjs must stay DOM-free; found '${global}'`);
  }
  // `location` appears only in app.js: routeFromSearch takes the search string
  // as an argument precisely so this module never reads it.
  assert.equal(js.includes('location.'), false);
});
