// Pins the theme wiring: cc's tokens with a standalone fallback for both modes,
// colours only through tokens (apart from the one named categorical set, the
// identity stripe), and no theme control of the plugin's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { STRIPE_COUNT } from '../frontend/src/lib/cardState.mjs';
import { FRONTEND, ownFiles, sourceFiles } from './_frontendFiles.mjs';

const read = (rel) => readFileSync(path.join(FRONTEND, rel), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const fallback = strip(read('src/cc-theme-fallback.css'));
const indexCss = strip(read('src/index.css'));

// The body of the first `<selector> {…}` block (no nested braces inside).
const block = (css, selector) => css.match(new RegExp(`(?:^|[\\s}])${selector.replace('.', '\\.')}\\s*\\{([^{}]*)\\}`))?.[1];
const declared = (body) => new Set([...(body ?? '').matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const value = (body, name) => body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1].trim();

// The named categorical set: the only custom properties of the plugin's own.
const STRIPES = Array.from({ length: STRIPE_COUNT }, (_, i) => `--cs-stripe-${i}`);
const STRIPE_DECL = /^\s*--cs-stripe-(\d+)\s*:[^;\n]*;\s*$/gm;

// Invariant: the fallback is one @layer base block (so cc's unlayered sheet wins embedded) declaring :root and .dark.
test('cc-theme-fallback.css is wrapped in @layer base and declares :root and .dark', () => {
  assert.match(fallback.trim(), /^@layer base \{[\s\S]*\}$/);
  assert.ok(declared(block(fallback, ':root')).size > 10, ':root tokens');
  assert.ok(declared(block(fallback, '.dark')).size > 10, '.dark tokens');
});

// Invariant: standalone, every token @theme inline maps resolves in light, and every colour token in dark too.
test('every @theme inline token is declared by the fallback, colours in both modes', () => {
  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(theme, '@theme inline block');
  const light = declared(block(fallback, ':root'));
  const dark = declared(block(fallback, '.dark'));
  const used = [...theme.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
  assert.ok(used.length > 20);
  for (const [, name, v] of used) {
    for (const [, ref] of v.matchAll(/var\(\s*(--[\w-]+)/g)) {
      assert.ok(light.has(ref), `${name}: var(${ref}) not declared in :root`);
      if (name.startsWith('--color-')) assert.ok(dark.has(ref), `${name}: var(${ref}) not declared in .dark`);
    }
  }
});

// Invariant: index.css pulls in Tailwind, the animations, the fallback, and cc's class-based dark variant.
test('index.css imports and dark variant', () => {
  for (const imp of ['tailwindcss', 'tw-animate-css', './cc-theme-fallback.css']) {
    assert.match(indexCss, new RegExp(`@import ['"]${imp.replace(/[./]/g, '\\$&')}['"];`), imp);
  }
  assert.match(indexCss, /@custom-variant dark \(&:is\(\.dark \*\)\);/);
});

// Invariant: no dangling token — every var(--x) in the plugin's own code is a
// host token, an @theme inline name, or one of the named stripe set.
test('every var(--x) in own code is declared', () => {
  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)[1];
  const known = new Set([...declared(fallback), ...declared(theme), ...STRIPES]);
  let seen = 0;
  for (const [n, src] of ownFiles()) {
    for (const [, name] of src.matchAll(/var\(\s*(--[\w-]+)/g)) {
      seen++;
      assert.ok(known.has(name), `${n}: var(${name}) is declared nowhere`);
    }
  }
  assert.ok(seen > 20, 'scanned the var() references');
});

// Invariant: the stripe set is exactly --cs-stripe-0 … N-1 (N = STRIPE_COUNT),
// declared on :root AND .dark and nowhere else; each .stripe-N rule reads its
// own property only; and no other plugin property exists.
test('stripe properties: the named set on both modes, one rule per class', () => {
  const light = block(indexCss, ':root');
  const dark = block(indexCss, '.dark');
  assert.deepEqual([...declared(light)].sort(), [...STRIPES].sort(), ':root declares exactly the stripe set');
  assert.deepEqual([...declared(dark)].sort(), [...STRIPES].sort(), '.dark declares exactly the stripe set');

  const rules = [...indexCss.matchAll(/\.stripe-(\d+)\s*\{([^{}]*)\}/g)];
  assert.deepEqual(rules.map((r) => Number(r[1])), STRIPES.map((_, i) => i), 'one rule per class, in order');
  for (const [, i, body] of rules) {
    assert.equal(body.trim(), `border-left-color: var(--cs-stripe-${i});`, `.stripe-${i}`);
  }

  const theme = indexCss.match(/@theme inline\s*\{([\s\S]*?)\n\}/)[1];
  const outsideTheme = indexCss.replace(theme, '');
  assert.deepEqual([...declared(outsideTheme)].sort(), [...STRIPES].sort(), 'no other custom property of our own');
  for (const [n, src] of ownFiles()) {
    for (const [name] of src.matchAll(/--cs-[\w-]+/g)) assert.ok(STRIPES.includes(name), `${n}: ${name}`);
  }
});

// Invariant: the plugin's own code uses colours only through the theme tokens.
// The one exemption is the declaration lines of exactly the named stripe set.
test('own code has no literal colours', () => {
  const PALETTE = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white';
  const literal = new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\brgba?\\(|\\bhsla?\\(|\\boklch\\(|\\boklab\\(|\\blab\\(|\\blch\\(|\\bcolor\\(|\\b(?:bg|text|border|ring|fill|stroke|outline|decoration|shadow|from|via|to|divide|accent|caret)-(?:${PALETTE})\\b`);
  const own = ownFiles();
  assert.ok(own.length > 10);
  for (const [n, raw] of own) {
    const src = n === 'src/index.css'
      ? raw.replace(STRIPE_DECL, (line, i) => (Number(i) < STRIPE_COUNT ? '' : line))
      : raw;
    assert.equal(literal.test(src), false, `${n}: ${src.match(literal)?.[0]}`);
  }
});

// oklch → linear sRGB (clamped to the gamut) → WCAG relative luminance.
function luminance(css) {
  const m = css.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  assert.ok(m, `an oklch() colour: ${css}`);
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const R = clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s);
  const G = clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s);
  const B = clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
const contrast = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

// Invariant: every stripe hue is legible as a non-text UI mark (WCAG 1.4.11,
// at least 3:1) against the standalone card colour of the same mode.
test('stripe hues are legible against the card in both modes', () => {
  assert.ok(contrast('oklch(1 0 0)', 'oklch(0 0 0)') > 20, 'the helper measures white on black as ~21:1');
  for (const [mode, sel] of [['light', ':root'], ['dark', '.dark']]) {
    const card = value(block(fallback, sel), '--card');
    for (const name of STRIPES) {
      const hue = value(block(indexCss, sel), name);
      const ratio = contrast(hue, card);
      assert.ok(ratio >= 3, `${mode} ${name} ${hue} on --card ${card}: ${ratio.toFixed(2)}:1`);
    }
  }
});

// Invariant: only public/theme-init.js (standalone) touches the dark class or data-cc-theme; cc's choice applies.
test('no theme control of the plugin\'s own', () => {
  const mutates = /classList\.(?:add|remove|toggle|replace)\(\s*['"]dark['"]|(?:set|remove|toggle)Attribute\(\s*['"]data-cc-theme/;
  for (const [n, src] of sourceFiles()) {
    if (n === 'public/theme-init.js') {
      assert.match(src, /classList\.toggle\('dark'/);
      continue;
    }
    assert.equal(mutates.test(src), false, `${n}: ${src.match(mutates)?.[0]}`);
  }
});
