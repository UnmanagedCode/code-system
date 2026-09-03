# File movement rides `exec`, not `docker cp` / `scp`

**What:** `readFile`/`writeFile` are derived from the `exec` channel — a
`/bin/sh -c` script on the far side using `stat`, `tail`/`head` and `base64` —
in one place for every kind (`src/launcher/fileops.mjs`). No copy primitive is
used, and the earlier claim that this plugin uses `docker cp` / `scp` was wrong.

**Why:** `docker cp` buys **no capability at all**, because the target must
satisfy cc's POSIX/GNU baseline anyway: cc's own derived operations (`stat`,
`readDir`, `realpath`, …) are `exec` frames against that toolchain, and §1 of
cc's protocol doc lists `base64`, `tr` and `printf` precisely so a provider can
carry file bytes over an `exec`. So `base64` is *already required* on every
supported target. What a copy primitive would add is a second code path with its
own tar-wrapper semantics — and, for `scp`, its own auth path — to keep correct.
cc's own docker sanity check maps `readFile`/`writeFile` to "`cat` / `cat >`,
with a companion `stat` for `size`/`mode`" for the same reason.

Deriving it once also means the `mode` / `atomic` / `exclusive` rules are a
single piece of code that `docker` and `ssh` inherit for free.

**How to apply:**

- Don't reach for `docker cp`/`scp` when implementing a kind. A kind builds
  argv; it never implements file operations.
- The far-side scripts **normalise their own failure text to POSIX `strerror`
  tails** (`No such file or directory`, `File exists`, …). This is not tidiness:
  shells disagree — `set -C` says "cannot overwrite existing file" on bash and
  "File exists" on dash, and a failed redirect says "Directory nonexistent" on
  dash — while cc's classifier matches on the tail, and cc's callers branch on
  the resulting codes ("create unless it exists" is written as catch-`EEXIST`).
  Test the condition explicitly and emit the exact tail yourself.
- Use the **argv** form (`/bin/sh -c`), never the `shell` form. `bash -lc` is a
  *login* shell whose profile output would arrive before the script's, and the
  read parses the first line.
- `docker cp` / `scp` stay available as a possible later **bulk-transfer
  optimisation**, not as the primitive.
