# `docker` and `ssh` have no persistent shell — and cc's fallback is visible

**What:** Both kinds advertise `persistentShell: false`, permanently (an owner
decision, not a not-yet). cc gates `stdin`/`stdinClose` on that capability, so
it never sends them; `session.mjs` refuses one `EUNSUPPORTED`, id-addressed, if
one ever arrives. The `exec` frame's own `stdin?` field is unaffected — one-shot
stdin stays.

**Why it needs stating:** cc's contract requires an optional capability to have
a flag name, an absent-behaviour, **a user-visible difference**, and a test that
runs the fallback. We are the ones *taking* the fallback, so the difference has
to be visible to a user rather than a silent surprise.

**The difference.** cc runs every redirected shell command as a **one-shot
`exec`** of the same framing, passing `cwd` explicitly and reading `$PWD` back
from the sentinel to carry into the next call. So:

- **Headline: cwd persists across commands; exports, shell functions and
  background jobs do not.** This matches the local Claude Code CLI, whose `Bash`
  also carries only cwd.
- **Each command gets a fresh login shell**, so profile-file output would land
  in the command's output — the framing's *opening* sentinel is what stops it,
  and it is load-bearing here in a way it is not for a persistent shell.
- **A cwd deleted since the last command fails the NEXT command** with `ENOENT`
  rather than running it somewhere; a persistent shell would have kept running
  in the deleted directory.
- **The command rides the `exec` frame's `shell` form**, so what it needs of the
  far side is that form's login shell (`bash -lc`) — *not* the `system.shell` a
  persistent session would have been opened with.

**How to apply:**

- Don't implement a long-lived shell for `docker` or `ssh`, and don't add
  `stdin` handling beyond the refusal.
- **`host` keeps the capability, and that is deliberate** — two of the three
  configurations in cc's conformance suite deep-equal `persistentShell: true`,
  so hardcoding `false` there would lose most of the suite. See
  [host-kind-and-conformance.md](host-kind-and-conformance.md).
- `persistentShell` is a **per-kind boolean on `Transport`**, like
  `processGroupSignal`. The core must never hardcode it.
