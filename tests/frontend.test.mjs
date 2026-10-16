// Pins the host-contract and security rules a static read of the UI sources
// can reach (plugin-ui.md Parts 1 and 2). Each fails only once the page is
// mounted under cc, which is the one place no other test here runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FRONTEND, headTags, headUrls, ownFiles, sourceFiles } from './_frontendFiles.mjs';

const files = sourceFiles();
const html = files.find(([n]) => n === 'index.html')[1];

// Invariant: <head> loads the bridge first as a blocking classic script, then
// the host theme, then theme-init.js, then the module entry — each exactly once.
test('index.html head order: bridge (blocking, first), theme, theme-init, entry — each once', () => {
  assert.deepEqual(headUrls(html), ['/pluginBridge.js', '/pluginTheme.css', 'theme-init.js', './src/main.tsx']);
  const tags = headTags(html);
  const bridge = tags.find((t) => t.attrs.includes('/pluginBridge.js'));
  assert.equal(tags.filter((t) => t.tag === 'script' || t.tag === 'link')[0], bridge, 'the bridge is the first script or link');
  assert.doesNotMatch(bridge.attrs, /\b(?:defer|async|type=)/, 'blocking and classic');
  for (const u of ['/pluginBridge.js', '/pluginTheme.css', 'theme-init.js', 'main.tsx']) {
    assert.equal(html.split(u).length - 1, 1, `${u} appears exactly once`);
  }
  assert.match(tags.find((t) => t.attrs.includes('main.tsx')).attrs, /type="module"/);
});

// Invariant: every non-host URL index.html names is relative and names a real
// file (theme-init.js is served from public/).
test('index.html: the non-host refs are relative and exist', () => {
  for (const u of headUrls(html).filter((x) => !x.startsWith('/'))) {
    assert.doesNotMatch(u, /^[a-z][a-z0-9+.-]*:/i, u);
    const onDisk = u === 'theme-init.js' ? path.join(FRONTEND, 'public', u) : path.join(FRONTEND, u);
    assert.ok(existsSync(onDisk), `${u} resolves to ${onDisk}`);
  }
});

// Invariant: every URL is relative (cc mounts the page under /plugins/code-system/),
// except the two host URLs in index.html.
test('frontend uses no root-relative URLs', () => {
  const rootRel = /(?:src|href)\s*=\s*["']\/|['"`]\/api|fetch\(\s*['"`]\//g;
  const HOST = new Set(['src="/pluginBridge.js"', 'href="/pluginTheme.css"']);
  assert.ok(files.length > 10, 'scanned the UI sources');
  for (const [n, src] of files) {
    for (const m of src.matchAll(rootRel)) {
      const at = src.slice(m.index).match(/^(?:src|href)\s*=\s*"[^"]*"/)?.[0];
      assert.ok(n === 'index.html' && HOST.has(at), `${n}: ${at ?? m[0]}`);
    }
  }
});

// Invariant: all network access goes through lib/api.ts, whose api() refuses a
// `/`-led path (pinned in src/lib/api.test.ts). Closing the class rather than a
// spelling: a root-relative URL built at runtime still has to pass that guard.
test('only src/lib/api.ts reaches the network, through one fetch', () => {
  const network = /\bfetch\s*\(|XMLHttpRequest|EventSource|WebSocket|sendBeacon|\bimport\s*\(|new\s+(?:Image|Worker|SharedWorker)\b|\.src\s*=|\.href\s*=|location\.(?:assign|replace)\(|window\.open\(/g;
  for (const [n, src] of files) {
    const hits = [...src.matchAll(network)].map((m) => m[0]);
    if (n === 'src/lib/api.ts') assert.deepEqual(hits, ['fetch('], 'api.ts: exactly one fetch, nothing else');
    else assert.deepEqual(hits, [], n);
  }
});

// Invariant: no HTML-string sinks, dynamic code, hash writes, parent scripting,
// cc storage keys, or style written from script — anywhere in the UI source.
test('frontend uses no HTML-string sinks, eval, style writes, hash writes, window.parent or cc keys', () => {
  const banned = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function|dangerouslySetInnerHTML|setAttribute\(\s*['"]style|\.setProperty\(|\bstyle\s*=|\bstyle=\{|location\.hash\s*=|window\.parent|code-conductor:/;
  for (const [n, src] of files) assert.equal(banned.test(src), false, `${n}: ${src.match(banned)?.[0]}`);
});

// Invariant: the CSP forbids inline script, so the shell has none, and no inline style either.
test('index.html has no inline script or style', () => {
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(html), false, 'inline <script>');
  assert.equal(/<style[\s>]/.test(html), false, '<style>');
  assert.equal(/\sstyle\s*=/.test(html), false, 'style=');
});

// Invariant: the plugin's own code renders controls only through the components
// copied from cc, so they take cc's radius, focus ring and disabled treatment.
test('own code has no raw <button>, <input>, <select> or <textarea>', () => {
  const raw = /<(?:button|input|select|textarea)\b/;
  for (const [n, src] of ownFiles()) assert.equal(raw.test(src), false, `${n}: ${src.match(raw)?.[0]}`);
});

// Invariant: cardState.mjs is PURE — the seam that lets node --test pin every
// card decision with no browser. `location` stays out too: routeFromSearch
// takes the search string as an argument for exactly that reason.
test('cardState.mjs touches no browser global', () => {
  const js = files.find(([n]) => n === 'src/lib/cardState.mjs')?.[1];
  assert.ok(js, 'src/lib/cardState.mjs exists');
  for (const global of ['document', 'window', 'localStorage', 'navigator', 'fetch(', 'location.']) {
    assert.equal(js.includes(global), false, `cardState.mjs must stay DOM-free; found '${global}'`);
  }
});
