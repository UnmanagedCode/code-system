# Registering a System row is an active operation

**What:** Registering this plugin's System row with cc is not passive metadata registration — cc spawns the provider's launch argv and performs a real handshake, **with zero remotes configured**. Two consequences:

1. The handshake must be answerable before any target is reachable. There is no "empty/unconfigured" response that skips it, so nothing in `hello` may be probed from a remote.
2. cc's `assertSessionRootsPlaceable` check refuses (HTTP 400) if any ancestor directory of the session-root path contains a `.git` directory. Registration will fail inside a devcontainer whose projects root is itself a git repo.

**Why:** Both are preconditions cc enforces before a System row is usable at all — they aren't edge cases you can defer past MVP.

**How to apply:** Keep the handshake a pure function of the launch argv — no I/O, no probing. When testing registration in a devcontainer, verify the projects root isn't nested under a `.git` ancestor, or registration will 400 before the provider is ever exercised.
