# The Advanced group: open state and what opens it

**What:** `formFor` (`frontend/app.js`) renders one `<details class="advanced">`
holding a kind's `advanced: true` config fields (docker `user`; ssh `port`,
`password`, `identityFile`) and the mirror form.

**Decisions a reader cannot re-derive:**

- **Open state lives in the draft** (`draft.advancedOpen`), written by the
  `toggle` handler and set once when the draft is built. An open state derived
  from the mirror checkbox would collapse the group under the cursor, because
  the checkbox re-renders.
- **Create is always collapsed, for every kind.** The summary carries the mirror
  state (`advancedSummary` in `frontend/cardState.mjs`), so a collapsed group still
  says what Create will register.
- **Edit opens only for something hidden otherwise:** a stored advanced config
  value (a name in `storedSecrets` counts) or a **custom** mirror (not exactly the
  served `mirrorDefaults`). A default or absent mirror stays collapsed because the
  summary already states it (`advancedOpenOnEdit`).
- **ssh mirrors by default** (`KIND_META.mirrorByDefault`), so its create form
  posts the default mirror. On an ssh host `/` reaches everything that ssh user
  can, which is wider than a container.
