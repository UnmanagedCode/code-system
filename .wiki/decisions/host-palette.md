# The card UI wears the host's palette

**What:** the UI reads cc's tokens from the host sheet (`/pluginTheme.css`) and
uses them only through Tailwind utilities or `var(--token)`. Standalone, a
one-time snapshot of cc's `web/src/themeTokens.css` inside `@layer base`
(`frontend/src/cc-theme-fallback.css`) keeps it legible. It follows cc's
light/dark live, the OS standalone, and has no toggle of its own.

**Decisions a reader cannot re-derive:**

- **The snapshot is never re-synced.** Embedded, cc's sheet is unlayered and
  beats anything in `@layer base`, so the snapshot only shows standalone, where
  a slightly old palette costs nothing.
- **Status is `success` / `warning` / `destructive`, never `primary`.** The gate
  word, the probe dot, the baseline badge, the registration pill, a broken card
  and the alerts take a status token. `primary` is cc's control colour; a status
  that borrows it reads as a button. One home: `frontend/src/lib/tone.ts`.
- **The primary FILL is a form's Create/Save only.** A card's Connect is an
  outline button tinted `success`; Disconnect and Delete outline tinted
  `destructive`. A cross-plugin rule; it covers code-hub's Start as well.
- **Kind badges are `outline` plus an icon** (`BoxIcon` docker, `TerminalIcon`
  ssh), not a hue of their own: cc has no categorical palette to borrow from.
- **The identity stripe is the one exception, and it is bounded.** A card's left
  border colour is one of a FIXED set of classes, `stripe-0`…`stripe-7`,
  picked by `stripeClass(remoteId)` (`frontend/src/lib/cardState.mjs`). Each
  class reads a named property `--cs-stripe-N`, declared light (`:root`) and dark
  (`.dark`) in `frontend/src/index.css`: the plugin's only custom properties and
  only literal colours, categorical hues with no host equivalent. The id never
  becomes a class or a `style`: a remoteId is operator-typed, and Part 2 of cc's
  plugin-ui.md forbids content in `style` once `'unsafe-inline'` is allowed.
- **The stripe hues must stay legible:** at least 3:1 against `--card` in both
  modes (WCAG 1.4.11), measured in the test.

**Enforced by:** `tests/frontend-theme.test.mjs` (tokens declared, no literal
colour outside the named set, the set exactly `--cs-stripe-0…7` on both modes,
contrast), `frontend/src/palette.test.tsx` (status tokens, primary fill),
`tests/cardstate.test.mjs` (`stripeClass` output), `frontend/src/security.test.tsx`
(a hostile id reaches no class and no style).
