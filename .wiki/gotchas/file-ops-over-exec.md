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
- **Our own refusals are classified by a per-call NONCE TAG, not by their text.**
  Each generated script carries a fresh nonce and tags its refusals
  `CCERR-<nonce> <CODE>` on stderr; the host side matches that anywhere in
  stderr and strips it before reporting. **Do not go back to matching the
  strerror tail for our own errors** — the scripts interpolate the requested
  path into their failure text, so a file named `.../Is a directory` makes a
  missing-file `ENOENT` classify as `EISDIR`, and cc's callers branch on these
  codes. Exit codes are no good either: the same noclobber failure is exit 2 on
  dash and exit 1 on bash.
  The tag is unforgeable only because the nonce is generated **per call, after
  cc has already fixed the path** — reusing one, or hoisting it to module scope,
  breaks the property.
- `classifyStderr` (the POSIX tail match) is still the right reader for text we
  did **not** write: the far side's own tools. The scripts also still emit the
  exact tail after their tag, because shells disagree on wording — a failed
  redirect says "Directory nonexistent" on dash and "No such file or directory"
  on bash — and a human reads that line.
- **`exclusive` is `set -C` (noclobber), not a pre-check.** Testing `-e` and then
  truncating in a separate command is check-then-act: a writer appearing in
  between gets truncated instead of refused, which is the lost update the flag
  exists to prevent. The pre-check is only a fast path. Note the guarantee rests
  on the TARGET's shell honouring noclobber — see `docs/protocol.md` →
  "What `exclusive` does and does not guarantee".
- Use the **argv** form (`/bin/sh -c`), never the `shell` form. `bash -lc` is a
  *login* shell whose profile output would arrive before the script's, and the
  read parses the first line.
- `docker cp` / `scp` stay available as a possible later **bulk-transfer
  optimisation**, not as the primitive.
