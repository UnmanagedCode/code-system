# The tooling-baseline probe is two-tier, cached on a fingerprint

**What:** Checking that a target has the GNU tooling cc's derived operations
need is split in two (`src/baseline.mjs`):

1. **`Transport.reachability` stays cheap and stays OUT of the target** — a
   `docker inspect` daemon query, or an ssh ControlPath socket's existence — and
   returns a `fingerprint` that costs nothing extra because it is built from
   fields of a call already being made (image id + `State.StartedAt`; for ssh
   the config hash plus the socket's inode+ctime).
2. **The probe itself is one round trip INTO the target**, run by the backend
   and cached on the remote's record **against that fingerprint**.

**Why:** folding the probe into `reachability` was the obvious move and is
wrong on cost — `reachability` runs on every `GET /api/remotes`, i.e. every card
render, so it would be a `docker exec` per container per refresh. A one-shot
probe cached forever is the other extreme and goes stale the moment a container
is recreated from a different image. Keying on a fingerprint costs **one probe
per container start or image change**, and a target that gets fixed clears
itself on the next refresh with no restart.

**It never runs during the `hello` handshake**: cc's handshake budget is 10 s,
and registration handshakes with **zero remotes configured**, so there is
nothing to probe there anyway.

**It is not a registration state.** Registration is per-KIND — one `docker` row
for every container — so a baseline failure on one Alpine container must not
mark the whole row broken. It is per-remote and belongs on the card.

**How to apply:**

- **Check the flag, not the binary.** `command -v find` proves nothing: busybox
  *has* `find` and `stat`; what it lacks is `-printf` and `%.3Y` precision.
  Probe the exact argv cc sends, in the exact form.
- **Assert on output shape, not exit code**, for `stat`. busybox implements
  `-c` but ignores the `.3`, so it **succeeds and is wrong** — one-second
  granularity with no error anywhere. That silent degradation is the one cc will
  never surface on its own, and the only reason the probe exists rather than
  waiting for a failure.
- **Three states, and the launcher treats them differently.** `unsupported`
  refuses every request frame for that remote with an id-addressed `EUNKNOWN`
  naming the capability (refused *whole* — busybox is partly working, and
  half-working is what a clear refusal is worth more than). `unknown` **serves**:
  a launcher can be spawned before the backend ever probed, and blocking on
  absence of evidence would make a cold start useless.
- A probe that **could not run at all** leaves the stored verdict untouched.
  "We could not look" is not the claim "unsupported".
