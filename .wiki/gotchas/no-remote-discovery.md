# cc has no remote discovery — the plugin is the only catalog

**What:** cc's protocol has no `listRemotes` frame. cc cannot enumerate what remotes exist behind a System; it only knows the `remoteId` string a project's *Remote* field is set to.

**Why:** This plugin is therefore not a convenience layer on top of some cc-side registry — it is the *only* place remotes are catalogued. The `remoteId` string is the entire hand-off contract between the plugin (where a remote is configured) and cc (where a project points at it via the *Remote* field).

**One catalog, two read surfaces, one writer.** The cards and the `list_remotes` MCP tool (`src/mcp.mjs`) both read the same store, so neither is a second catalog; a remote is added, edited, connected and deleted in the card UI alone. The MCP tool exists because an agent cannot read the cards, and there is nowhere else to ask — see [plugin-mcp-surface.md](plugin-mcp-surface.md).

**How to apply:** `remoteId` values must be stable (never silently renamed/regenerated once a project references one) and human-typable (something a user can read off the UI and paste into cc, not an opaque token). Any UI flow that lets a user rename or delete a remote needs to account for projects that still reference its `remoteId`.
