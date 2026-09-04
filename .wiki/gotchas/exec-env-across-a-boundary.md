# `ExecRequest.env` is the FRAME's env, and `null` means the FAR SIDE's

**What:** `ExecRequest.env` (`src/launcher/kinds/index.mjs`) carries the `exec`
frame's own `env` field, unchanged — an object **replaces** the environment
posix_spawn-style (§5), and `null` means **inherit the far side's**. The core
never substitutes its own `process.env` for an absent field.

**Why this is a rule and not a style choice.** `session.mjs` used to do
`const baseEnv = f.env ? f.env : process.env`, so `env` was never `null` on the
exec path. For `host` the two are identical, which is why it survived. For
`docker` they are not:

- cc sends **no `env` field** on all seven of its §7 derivations (`stat`,
  `readDir`, `realpath`, `mkdir`, `removeTree`, `unlink`, `chmod`), and §7 says
  why: *"they inherit the far side's environment (its PATH, its toolchain)"*.
- `run.mjs` sets `env: null` for every `fileops` script and for the baseline probe.

Under the collapse, a kind honouring `env` as a replacement would run every one
of those **inside the container with cc's host PATH**. Measured:

```
docker exec <ctr> env -i PATH=/usr/local/nvm/versions/node/v24.0.0/bin git --version
→ env: 'git': No such file or directory      (exit 127)
```

**How to apply:**

- Pass the frame's env through untouched, `null` included. Fenced docker-free by
  `tests/launcher-frames.test.mjs` → *"an absent frame `env` reaches the kind as
  null"*, which asserts on the `ExecRequest` itself — the outcome is
  indistinguishable on `host`, so an outcome-shaped test proves nothing.
- **Compose in the kind, with `execEnv`** (`kinds/config.mjs`). `CC_REMOTE` is
  overlaid **after** the frame's replacement, so the provider's binding beats a
  frame-supplied value. A test of that ordering **must collide on `CC_REMOTE`**:
  `{...frameEnv, CC_REMOTE}` and `{CC_REMOTE, ...frameEnv}` are byte-identical
  otherwise.
- **`docker` does not call `execEnv` for the inherit case at all.** "Inherit the
  far side's" there means "add no `env -i`", not "materialise anything" — the
  container keeps its own PATH/HOME/toolchain, and only `CC_REMOTE` /
  `CC_EXEC_TOKEN` ride as `-e` flags. See
  [docker-exec-transport.md](docker-exec-transport.md) §4.

## The interim limitation, and the card that tracks it

At cc `bf5f2afe`, cc's **non-derived** `exec` sends cc's own host environment as
a wholesale `env`: `providerSystem.ts`'s `exec()` is
`this.#exec(spec, opts, opts.env ?? process.env)`, with a comment defending it.
§5's `env` row still says **REPLACES**, so implementing it faithfully is correct —
and the consequence is that a container command sees cc's host `HOME` and `PATH`.
The `shell` form largely self-repairs (`/bin/bash -lc` re-sets PATH from
`/etc/profile`); the **argv** form does not, and a host PATH lacking the
container's binary directories yields exit 127.

cc has an **unmerged** branch fixing its side —
`code-conductor/systems-exec-env-plan` @ `47446c24`, cc card 2026-0317,
*"Stop sending cc's process.env across the System wire"*, which makes cc send
`env` only when a caller named one. It is live, unmerged and **off the pin**:
treat it as corroboration, never as authority, and do **not** design around cc's
current behaviour either.

Tracked on this side as **code-system card 2026-0008**, "Re-verify exec env
across the transport boundary once cc 2026-0317 lands". Card 2026-0004 (`ssh`)
inherits all of the above unchanged.
