# cc has no remote discovery — the plugin UI is the only catalog

**What:** cc's protocol has no `listRemotes` frame. cc cannot enumerate what remotes exist behind a System; it only knows the `remoteId` string a project's *Remote* field is set to.

**Why:** This plugin's card-based UI is therefore not a convenience layer on top of some cc-side registry — it is the *only* place remotes are catalogued. The `remoteId` string is the entire hand-off contract between the UI (where a remote is configured) and cc (where a project points at it via the *Remote* field).

**How to apply:** `remoteId` values must be stable (never silently renamed/regenerated once a project references one) and human-typable (something a user can read off the UI and paste into cc, not an opaque token). Any UI flow that lets a user rename or delete a remote needs to account for projects that still reference its `remoteId`.
