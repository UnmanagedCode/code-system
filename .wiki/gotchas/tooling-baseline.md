# Host-side execution doesn't free the target from tooling requirements

**What:** Running the provider on cc's host (not on the target) does not mean the target can be toolless. cc derives its filesystem primitives — `stat`, `readDir`, `realpath`, `mkdir`, `removeTree`, `unlink`, `chmod` — by sending `exec` frames that carry GNU-specific argv, notably:

- `find <path>/. -mindepth 1 -maxdepth 1 -printf '%y\t%f\n'` (for `readDir`)
- `stat -L -c '%f %s %.3Y'` (for `stat`)

**Why:** Busybox `find` (Alpine, most minimal images) has no `-printf` flag, so `readDir` breaks on Alpine targets. distroless/scratch images have no shell at all, so nothing works. "Host-side" only buys no-node-on-target, no-copy-in, and no-auth-back — it is not a toolless-target guarantee.

**How to apply:** When documenting or validating supported targets for the `docker`/`ssh` providers, state the GNU coreutils + GNU findutils + a shell baseline explicitly. Don't advertise Alpine or distroless/scratch as supported without a fallback path.
