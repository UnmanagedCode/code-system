# The `host` kind, and what cc's conformance suite really demands

**What:** `src/launcher/kinds/host.mjs` is a third kind that execs on cc's own
machine. It is never auto-registered. It exists because cc's conformance suite —
which cc's own doc calls "the definition of a valid provider" — **builds its
fixtures with node's `fs` and then asks the provider about them**, so it only
verifies a provider reaching the same filesystem as the test process
(the third-party NOTE in `tests/referenceProviderHarness.mjs`). A docker or ssh target does not.
Nothing but a host kind can run that suite against this code.

**Two things the suite demands that its own docs do not say:**

1. **Flags beyond the two `--no-*` ones.** The harness claims it appends
   "exactly the two `--no-*` flags and nothing else" and that "nothing in the
   suite is otherwise specific to the reference provider". Both are false: the
   suite also passes `--remote <id>=<abs root>`, `--mirror` and `--exclude`,
   requires the provider to **fence** each remote to its root (with `cwd:"/"`
   exempt), and asserts the provider **injects `CC_REMOTE`** into the remote
   command's environment. Those facts are documented — in code-conductor's
   `docs/architecture.md`, Component layout → `referenceProvider.ts` — just not in `systems-protocol.md`, the doc that
   claims to be complete on its own. Filed as code-conductor card **2026-0313**.

2. **Capabilities must be DERIVED FROM FLAGS, not declared.** The suite's three
   core configurations pass **no** flags and **deep-equal** the whole
   capabilities object. A provider that hardcoded any of the four booleans fails
   the deep-equal and loses most of the suite. cc's own reference provider does
   `remotes: this.#opts.remotes.size > 0`, and the suite's assertion message
   states it: *"the flags the provider was launched with are what it
   advertises"*.

**Why it matters beyond `host`:** `docker` and `ssh` advertise `remotes:true`
**always** (a capability derived from store contents would flap as remotes were
added, and cc memoises the handshake per connection generation), so **they can
never pass those three core configurations.** That is not a defect and not
something to work around.

**How to apply:**

- Don't delete `host` as dead code, and don't register it. Its guard is
  `CODE_SYSTEM_ALLOW_HOST_KIND=1` — cc spawns the launcher with the
  *orchestrator's* env, so a hand-registered row cannot inherit a variable
  nobody exported into the orchestrator. Failure is stderr + exit 2 **before any
  frame**, so cc answers 502 quoting it.
- Don't "fix" the inconsistency that `host` keeps `persistentShell` while
  `docker`/`ssh` drop it: two of the three core configurations deep-equal
  `persistentShell: true`, and losing them would cost most of the
  exec-lifecycle, fileops, derivation and error-taxonomy coverage.
- **Never add a flag to `docker` or `ssh` to fake `remotes:false`.** That is a
  test-only divergence in the one field cc negotiates on.
- **The `--remote` fence is LEXICAL, not containment.** It is `path.relative`
  against the root with no `realpath`, so a symlink inside the root escapes it.
  Deliberate: on `host`, `exec` is arbitrary by design, so `cat` reads the same
  file anyway, and the fence exists only for the test vehicle — production
  `docker`/`ssh` remotes carry no root at all. **Cards 2026-0003 and 2026-0004
  must not reach for it as a containment primitive.**
- The guard that ships is **one** general seam
  (`CODE_SYSTEM_ALLOW_HOST_KIND=1`) plus a **second** one gating only the
  unfenced-serving path (`CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED=1`, set solely by
  `tests/conformance.mjs`). The plan's mandatory `--remote` fence was dropped
  because the suite's core configurations pass no flags; see
  `docs/architecture.md` → "The `host` kind" for the deviation and its residual
  risk.
- What makes this acceptable is the seam: the codec, the frame loop and fileops
  are kind-agnostic and `spawnPlan` is pure, so **`host` passing the core suite
  proves the core for every kind.** The per-kind residue is argv construction
  and `reap`.
