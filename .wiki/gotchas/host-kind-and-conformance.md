# The `host` kind, and what cc's conformance suite really demands

**What:** `src/launcher/kinds/host.mjs` is a third kind that execs on cc's own
machine. It is never auto-registered. **KEPT — decided with evidence at cc
`bf5f2afe`** — for two reasons, each load-bearing on its own:

1. **It is the only far side that reaches the TEST PROCESS'S OWN filesystem.**
   cc's suite "builds its fixtures with node's own `fs` and then asks the
   provider about them" (`systems-protocol.md` §10). `CC_CONFORMANCE_REMOTE_ID`
   fixes *addressing*, not *filesystem identity*, so binding a docker target
   does **not** substitute. The same requirement makes `host` the far side for
   `tests/fileops.test.mjs` (the only real-shell proof the generated read/write
   scripts are right) and `tests/baseline.test.mjs` (the only proof
   `PROBE_SCRIPT` is valid POSIX sh).
2. **`npm run conformance` drives the battery through the SHIPPED LAUNCHER**
   (`tests/conformance.mjs` → `[node, src/launcher/main.mjs, --kind, host]`), so
   it exercises arg parsing, kind dispatch, the frame loop, routing and
   shutdown. A transport exercised directly proves none of that.

**The rejected fourth option, recorded so nobody re-litigates it:** demoting
`host` to a *test-only* provider entry point is launchable
(`CC_CONFORMANCE_PROVIDER` takes an argv, not a registered cc kind) but fails
reason 2 — recovering it means importing `main.mjs`, i.e. `--kind host` with
extra steps.

**THE OLD JUSTIFICATION WAS FALSE, and is deleted wherever it appeared.** It
held that an always-`remotes:true` kind was permanently barred from the suite's
core capability configurations, and that `host` therefore unlocked rows nothing
else could. Three measurements refute it: `IS_REFERENCE_PROVIDER` is an
*identity* gate (`!process.env[PROVIDER_ARGV_ENV]?.trim()`), not a shape gate;
`assertNegotiatedCapabilities` deep-equals the whole object only for the
reference provider and otherwise loops `TOGGLED_CAPABILITIES`, which derives to
`processGroupSignal` **alone**, tolerating `remotes`/`remoteDescriptors` as a
superset; and `CAPABILITY_CONFIGS` is **two** configurations, not three.
`host` unlocks **zero** rows a bound `docker` would not.

**What a third-party run does NOT verify — four skips, identical for `host` and
for a bound `docker`, all gated on `IS_REFERENCE_PROVIDER`:**

| Test | Printed reason |
|---|---|
| `a provider that does not advertise remotes is never handed a remoteId` | `cc-side fixture, pinned to the reference provider: asserts what CC does, not what a provider does` |
| `a provider without the capability advertises no mirror` | same |
| `CC_CONFORMANCE_REMOTE_ID binds the fixture handle, and an explicit remoteId still wins` | `asserts the unset default` |
| `every code in the taxonomy is produced by a real failure somewhere in this suite` | `counts producers across rows a third-party run skips` |

A **fifth** skip, or a different reason string, means the harness changed.

**Two things about the launch surface:**

1. **`systems-protocol.md` §10 → "The launch surface" is the authority, and it
   is complete.** cc card 2026-0313 landed; the gap this page used to record as
   pending is closed. Read §10's table rather than re-deriving the flags from
   cc's `referenceProvider.ts`. It obliges a provider to accept
   `--no-process-group-signal`, `--remote <id>=<abs root>` (serve that target;
   an unknown or absent id is an id-addressed `ENOREMOTE`), `--mirror` and
   `--exclude`, and to put `CC_REMOTE=<id>` in the environment of **every child
   an `exec` starts**.

   **THE `--remote` ROOT IS NOT A FENCE THE SUITE ASKS YOU TO ENFORCE** — §10's
   own row says so, and cc's architecture doc calls the reference provider's
   root fence "this provider's property, not a protocol obligation", exercised
   by no row in the battery. **`docker` implements none, and card 2026-0004 must
   not implement root fencing as a conformance requirement either.** `host` fences because a test
   vehicle on cc's own machine needs a misroute to be *refusable*; production
   `docker`/`ssh` remotes carry no root at all.

2. **Capabilities must be DERIVED FROM FLAGS, not declared.** The suite's core
   configurations pass **no** flags, and on the reference-provider path
   deep-equal the whole capabilities object. cc's own reference provider does
   `remotes: this.#opts.remotes.size > 0`, and the suite's assertion message
   states it: *"the flags the provider was launched with are what it
   advertises"*. Bare `host` equals `CAPABILITY_CONFIGS[0].caps` verbatim and
   `--no-process-group-signal` equals `CAPABILITY_CONFIGS[1].caps` verbatim
   **because they are derived**.

**Why it matters beyond `host`:** `docker` and `ssh` advertise `remotes:true`
**always** (a capability derived from store contents would flap as remotes were
added, and cc memoises the handshake per connection generation). Since
`CC_CONFORMANCE_REMOTE_ID` exists, that no longer bars them from the battery —
**a bound run against the real `docker` kind is supported and worth doing**. It
needs a container sharing the test process's filesystem (a bind mount), so it
belongs to card **2026-0006** — card 2026-0003 landed the transport and its own
live suite (`tests/docker-live.test.mjs`), not the bound conformance rig.

**RUN cc's SUITE AGAINST A CLONE OF THE PIN, NEVER A LIVE cc WORKTREE.**
`tests/conformance.mjs` runs cc's own test runner with `cwd: <checkout>`, and a
`code-conductor` worktree somebody else is working in has a moving HEAD and may
be read-only to you. Clone it (a clone reads the source and writes only to the
destination), check out the pin, and point `CC_CHECKOUT` at the clone:

```sh
git clone --no-hardlinks <cc-worktree> /tmp/cc-pin
git -C /tmp/cc-pin checkout <pin-sha>
ln -s <cc-worktree>/node_modules /tmp/cc-pin/node_modules   # or npm ci in the clone
CC_CHECKOUT=/tmp/cc-pin npm run conformance
```

Confirm `git -C <cc-worktree> status --porcelain` is empty **before and after** —
that is what proves the other team's tree was not disturbed. Note
`code-conductor` **main** does not carry the suite; only the systems branch does.

**How to apply:**

- Don't delete `host` as dead code, and don't register it. Its guard is
  `CODE_SYSTEM_ALLOW_HOST_KIND=1` — cc spawns the launcher with the
  *orchestrator's* env, so a hand-registered row cannot inherit a variable
  nobody exported into the orchestrator. Failure is stderr + exit 2 **before any
  frame**, so cc answers 502 quoting it.
- **Be accurate about what the two env seams buy.** A cc System row's `launch`
  is an unvalidated `string[]` (`src/systems/registry.ts`): `addSystem`
  validates it only by spawning it and handshaking, `getSystems()` reads it back
  with no content check, and there is **no allow-list or path check anywhere**.
  Anyone able to register a row can already have cc spawn arbitrary argv on cc's
  host. What `--kind host` adds is narrower — a *standing, protocol-speaking*
  exec service any project can be pointed at. The seams are defence-in-depth
  against **our own auto-registration bug** and against a user hand-registering
  it; the `REGISTERED_KINDS` omission is what stops *us* creating such a row.
  Neither is a capability check, and neither stops someone who can already write
  the registry. Don't write, in either direction, that one of them is "the real
  protection".
- **Never add a flag to `docker` or `ssh` to fake `remotes:false`.** That is a
  test-only divergence in the one field cc negotiates on.
- **The `--remote` fence is LEXICAL, not containment.** It is `path.relative`
  against the root with no `realpath`, so a symlink inside the root escapes it.
  Deliberate: on `host`, `exec` is arbitrary by design, so `cat` reads the same
  file anyway, and the fence exists only for the test vehicle — production
  `docker`/`ssh` remotes carry no root at all. **`docker` does not reach for it as
  a containment primitive, and card 2026-0004 must not either.**
- The guard that ships is **one** general seam
  (`CODE_SYSTEM_ALLOW_HOST_KIND=1`) plus a **second** one gating only the
  unfenced-serving path (`CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED=1`, which **no
  shipped code path sets** — only tests do; preserve that property, not a count
  of setters). The plan's mandatory `--remote` fence was dropped because the
  core configurations pass no flags, so our own launcher would exit 2 before any
  frame in every one of them; see
  `docs/architecture.md` → "The `host` kind" for the deviation and its residual
  risk.
- **Every config field that becomes an argv operand must reject a leading `-`.**
  `container`, `host` and `user` do (`src/launcher/kinds/config.mjs`). A leading
  dash turns an operand into an option — `container: "-v /:/host"` is argument
  injection against `docker` — so the refusal lives in `validateConfig`, at the
  store's front door, not in `spawnPlan`. Any new field a kind adds gets the
  same treatment.
- What makes this acceptable is the seam: the codec, the frame loop and fileops
  are kind-agnostic and `spawnPlan` is pure, so **`host` passing the core suite
  proves the core for every kind.** The per-kind residue is argv construction,
  `reap` and the optional `classifyFailure` — for `docker`, covered by
  `tests/dockerkind.test.mjs` (pure) and `tests/docker-live.test.mjs` (a real
  container, self-skipping).
