# `ExecRequest.env` is the FRAME's env, and `null` means the FAR SIDE's

**What:** `ExecRequest.env` (`src/launcher/kinds/index.mjs`) carries the `exec`
frame's own `env` field, unchanged — an object **replaces** the environment
posix_spawn-style (§5), and `null` means **inherit the far side's**. The core
never substitutes its own `process.env` for an absent field.

**Why this is a rule and not a style choice.** `session.mjs` used to do
`const baseEnv = f.env ? f.env : process.env`, so `env` was never `null` on the
exec path. For `host` the two are identical, which is why it survived. For
`docker` they are not:

- cc sends **no `env` field on any `exec` it issues** — its own §7 plumbing
  (`stat`, `readDir`, `realpath`, `mkdir`, `removeTree`, `unlink`, `chmod`) and a
  caller's command alike. §7 at cc `8b7b10bf`: *"Every command therefore runs in
  the provider's own environment … the far side's PATH and toolchain, not cc's."*
- `run.mjs` sets `env: null` for every `fileops` script and for the baseline probe.

Under the collapse, a kind honouring `env` as a replacement would run every one
of those **inside the container with cc's host PATH**. Measured:

```
docker exec <ctr> env -i -- PATH=/usr/local/nvm/versions/node/v24.0.0/bin git --version
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

## What cc sends at `8b7b10bf`, and how the REPLACE branch is fenced

cc card 2026-0317 landed. `providerSystem.ts`'s `exec()` is now
`this.#exec(spec, opts, opts.env ?? null)`; `ProviderShell` no longer holds an
`env` field at all; and the post-worktree hook — the only cc caller that ever
named one — ships its `CC_*` vars **in argv** through `env(1)`
(`src/worktrees.ts`). No cc call site names `opts.env`, so nothing cc issues puts
an `env` on the wire.

**The REPLACE branch stays anyway** — the contract and the reason are in
`docs/protocol.md` → *"A frame `env` is still REPLACE, and every kind still
implements it"*. What lives here is how it is fenced:
`tests/dockerkind.test.mjs` → *"a frame env REPLACES via `env -i`, with
CC_REMOTE overlaid last"*, and against a real container
`tests/docker-live.test.mjs` L7, where **`HOME` is the discriminator** — an `-e`
overlay leaves `HOME=/root` and passes every other assertion; only a real
replacement makes it UNSET.

## Name the interpreter absolutely (§5's `shell` row at `8b7b10bf`)

§5 now notes that in cc's reference provider an unqualified interpreter resolves
through **the `env` the frame carried**, not the provider's own, and that naming
it absolutely removes the dependence on either side's PATH.

`docker` already names it absolutely, everywhere:

- `/bin/bash -lc` for the `shell` form — `src/launcher/kinds/docker.mjs:237`
- `/bin/sh -c` for the reap script — `src/launcher/kinds/docker.mjs:341`
- `/bin/sh -c` for every fileops script and the baseline probe —
  `src/launcher/run.mjs:39`

`host` uses a bare `bash` (`src/launcher/kinds/host.mjs:119`), so **which
side's PATH resolves it depends on which branch of `execEnv` ran** — both
measured on Node 24:

- **A materialised env** (a frame `env`, or a `CC_REMOTE` overlay): resolved
  through THAT object, the direction §5 names for cc's reference provider.
  `spawnSync('bash', …, { env: { PATH: '/var/empty' } })` → `ENOENT`, so a frame
  `env` whose PATH lacks `bash` makes the `shell` form unspawnable rather than
  falling back to the launcher's PATH.
- **`env: null`**: `execEnv` returns `null` when there is no frame `env` and no
  `remoteId` (`src/launcher/kinds/config.mjs:62`), so the child inherits the
  launcher's environment and `bash` resolves through the PARENT's PATH — the
  opposite direction. With the parent's PATH scrubbed,
  `spawnSync('bash', …, { env: null })` → `ENOENT`; with it intact the command
  runs. **This is the branch usually taken**, since cc sends this kind no frame
  `env` at the pin.

Either way `host` is a test vehicle on cc's own machine, so this is a note, not a
defect — recorded so card 2026-0004's `ssh` names its interpreter absolutely from
the start and depends on neither side's PATH.
