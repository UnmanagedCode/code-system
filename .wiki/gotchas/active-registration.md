# Registering a System row is an active operation

**What:** Registering this plugin's System row with cc is not passive metadata registration — cc spawns the provider's launch argv and performs a real handshake. Two consequences:

1. The provider must answer `hello` with an absolute `system.shell` path, even when zero remotes are configured yet. There is no "empty/unconfigured" response that skips this.
2. cc's `assertSessionRootsPlaceable` check refuses (HTTP 400) if any ancestor directory of the session-root path contains a `.git` directory. Registration will fail inside a devcontainer whose projects root is itself a git repo.

**Why:** Both are preconditions cc enforces before a System row is usable at all — they aren't edge cases you can defer past MVP.

**How to apply:** The provider's `hello` response must always resolve a real, absolute shell path (e.g. the host's `/bin/sh`), independent of remote configuration state. When testing registration in a devcontainer, verify the projects root isn't nested under a `.git` ancestor, or registration will 400 before the provider is ever exercised.
