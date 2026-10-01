// Pins: frontend/styles.css is dark-only, declares code-conductor's shell token
// names on :root, references no custom property it doesn't declare there, and
// keeps the host's colour roles: status is green/amber/red and never the
// accent, the accent fill is a form's submit, and controls take the host's
// radius and disabled treatment. Reads the stylesheet as text: the node:test
// suite loads no DOM to compute styles in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../frontend/styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const appJs = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
const root = rootMatch ? rootMatch[1] : '';
const declared = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// Custom properties set per element by app.js rather than declared on :root.
const SET_BY_SCRIPT = ['--accent-bar'];

// Bodies of every rule whose selector list contains `selector` exactly. The
// innermost-brace match also reaches rules nested in @media.
function bodiesFor(selector) {
  const out = [];
  for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (sel.split(',').map((s) => s.trim()).includes(selector)) out.push(body);
  }
  return out;
}

function declares(selector, prop, value) {
  const re = new RegExp(`(^|[;\\s])${prop}\\s*:\\s*${value.replace(/[.()]/g, '\\$&')}\\s*(;|$)`);
  return bodiesFor(selector).some((b) => re.test(b));
}

test(':root block exists', () => {
  assert.ok(rootMatch, 'styles.css has no :root block');
});

test('dark-only: no prefers-color-scheme query, :root declares color-scheme: dark', () => {
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(root, /(^|[;\s])color-scheme\s*:\s*dark\s*(;|$)/);
});

test("declares the host shell's token names on :root", () => {
  for (const name of ['--bg', '--panel', '--panel-2', '--text', '--muted', '--border',
    '--accent', '--green', '--amber', '--red']) {
    assert.ok(declared.has(name), `:root does not declare ${name}`);
  }
});

test('every var(--name) used is declared on :root, or set by app.js', () => {
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 0);
  for (const name of used) {
    if (SET_BY_SCRIPT.includes(name)) continue;
    assert.ok(declared.has(name), `var(${name}) is not declared on :root`);
  }
});

test('every script-set exemption is still set by app.js', () => {
  for (const name of SET_BY_SCRIPT) {
    assert.ok(appJs.includes(`setProperty('${name}'`), `app.js no longer sets ${name}`);
  }
});

test('status rules use the host status colours, never the accent', () => {
  const STATUS = {
    '--green': ['.gate-word.on', '.dot.ok', '.pill.ok', '.badge.base-ok', '.controls .connect'],
    '--red': ['.card.broken', '.pill.bad', '.badge.base-unsupported', '.err', '.controls .danger'],
    '--amber': ['.dot.down', '.warn'],
  };
  for (const [token, selectors] of Object.entries(STATUS)) {
    for (const sel of selectors) {
      const bodies = bodiesFor(sel);
      assert.ok(bodies.length > 0, `no rule for ${sel}`);
      assert.ok(bodies.some((b) => b.includes(`var(${token})`)), `${sel} does not use var(${token})`);
      for (const b of bodies) assert.doesNotMatch(b, /var\(--accent\)/, `${sel} uses the accent`);
    }
  }
});

test("a form's submit is the host primary, with the host's disabled swap", () => {
  assert.ok(declares('.form-actions .connect', 'background', 'var(--accent)'),
    '.form-actions .connect is not accent-filled');
  const disabled = '.form-actions .connect:disabled';
  for (const [prop, value] of [['background', 'var(--panel-2)'], ['color', 'var(--muted)'],
    ['border-color', 'var(--border)'], ['font-weight', '400']]) {
    assert.ok(declares(disabled, prop, value), `${disabled} does not declare ${prop}: ${value}`);
  }
  assert.ok(declares('button:disabled', 'opacity', '.5'), 'button:disabled is not opacity .5');
  assert.ok(declares('button:disabled', 'cursor', 'not-allowed'), 'button:disabled is not cursor: not-allowed');
});

test('controls take the host 6px radius', () => {
  for (const sel of ['button', 'select', 'input', 'textarea', '.controls button']) {
    assert.ok(declares(sel, 'border-radius', '6px'), `${sel} is not border-radius: 6px`);
  }
});

test('no raw colour functions: tints derive from tokens', () => {
  assert.doesNotMatch(css, /\b(rgba?|hsla?)\(/);
});
