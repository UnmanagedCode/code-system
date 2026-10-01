# The card UI wears the host's palette

**What:** `frontend/styles.css` declares code-conductor's shell tokens on
`:root`, with values copied from the `:root` block of code-conductor's shell
stylesheet (`public/styles.css`). The page is **dark-only**: no
`prefers-color-scheme` query, `color-scheme: dark`. When the host's values
change, re-copy them; the host is the source, this file is a copy.

**Why by value:** cc injects no CSS and no tokens across the plugin iframe, and
hard-codes a white `#plugin-frame` background. A `var()` that names a host token
resolves to nothing inside the frame, so every token the UI uses must be
declared here.

## The colour roles

- **Status is `--green` / `--amber` / `--red`, never `--accent`.** The gate word,
  the probe dot, the baseline badge, the registration pill, a broken card and
  the error text all take a status token. `--accent` is the host's control and
  focus colour; a status that borrows it reads as a button.
- **The accent FILL is reserved for a form's submit.** Create/Save
  (`.form-actions .connect`) copy the host primary (`#composer-send`,
  `.uq-submit`): accent fill, dark text, the host's lighter hover. A card's
  **Connect** (`.controls .connect`) is a quiet panel-2 button tinted with
  `--green`, and Disconnect/Delete are tinted with `--red`. This is a
  cross-plugin rule, and it covers code-hub's Start as well.
- **Disabled copies the host exactly:** the generic `button:disabled` opacity
  and `not-allowed` cursor, plus the primary's own `:disabled` swap to a panel-2
  button stacked on top.
- **Kind badges keep their own hues** (`--kind-docker`, `--kind-ssh`). They are
  categorical labels, not status and not controls, so they get named tokens
  rather than borrowing a status colour.
- **Translucent tints derive from tokens** with
  `color-mix(in srgb, var(--token) N%, transparent)`, so each colour lives once
  on `:root`. The stylesheet contains no `rgb()` / `rgba()` / `hsl()`.

## The one script-set property

`--accent-bar` is a card's identity stripe. `app.js` sets it inline per card from
the `remoteId` (`hueFor`), so it is not on `:root`. The guard test exempts it by
name and also asserts that `app.js` still sets it, so the exemption cannot go
stale.

**Enforced by:** `tests/frontend-styles.test.mjs`.
