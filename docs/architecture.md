# Architecture

Internals: the two processes, the seam a provider kind plugs into, the on-disk
store and its startup pass, the shutdown contract, and the test patterns.

## Two processes, one ownership split

| | Owns | Does not |
|---|---|---|
| **Backend** (`server.mjs`) | config storage, the REST API, the card UI, auto-registration, the tooling-baseline probe | never speaks the System protocol, never proxies a frame |
| **Launcher** (`src/launcher/main.mjs`) | the System protocol: frames, ids, routing, chunking, error codes, timeouts, killing children | never writes to the store, never talks to the backend |

They share **no in-memory state**. The launcher reads the store fresh on every
request frame; the backend is the only writer. A frame-forwarding proxy through
the backend was rejected because the conductor kills and restarts a plugin
backend at any time (`docs/plugins.md` compliance item 7) — a live provider
connection must not die with it.

cc spawns the launcher with `spawn(argv[0], argv.slice(1))`, **no shell**,
carrying the **orchestrator's** environment and no reliable cwd
(the provider spawn in `src/systems/providerConnection.ts`; `SystemRecord` carries no `env` or
`cwd`). Everything the launcher needs is therefore on its argv or computed from
an absolute path — which is what forces the store location below.

## Component layout

| Path | Owns |
|---|---|
| `src/paths.mjs` | the store root and the launcher entry path — the only place either is spelled |
| `src/store.mjs` | the per-`remoteId` record: read fresh, atomic write, charset |
| `src/migrate.mjs` | the one-shot idempotent startup migration |
| `src/registration.mjs` | auto-registration of the two cc System rows |
| `src/baseline.mjs` | the tooling-baseline probe and its fingerprint cache |
| `src/api.mjs` | the REST surface (`docs/protocol.md` has the routes) |
| `src/launcher/protocol.mjs` | NDJSON codec, spec-fixed constants, stderr→code table |
| `src/launcher/session.mjs` | the frame loop: handshake, routing, exec lifecycle, shutdown |
| `src/launcher/fileops.mjs` | `readFile`/`writeFile`, derived over `exec`, once for every kind |
| `src/launcher/run.mjs` | run one script on a target — shared by fileops and the probe |
| `src/launcher/remotes.mjs` | `RemoteSource`: store-backed (production) and flag-backed (conformance) |
| `src/launcher/kinds/` | one file per kind, plus the registry and the kill-relay script (`reapscript.mjs`) shared by `docker` and `ssh` |

## The `Transport` seam

A Transport answers only **"how do I reach this target from cc's host"**. It
never touches frames, ids, chunking, error codes, timeouts or file semantics.
The JSDoc typedef is the contract: `src/launcher/kinds/index.mjs`.

Two properties earn their keep:

- **`spawnPlan` is a pure function.** It builds argv and returns; the core
  spawns it. That makes every kind's command assertable in a unit test with no
  docker and no ssh (`tests/capabilities.test.mjs`).
- **`reachability` reads a host-side artifact only** — a `docker inspect` daemon
  query, an ssh ControlPath socket's existence — never in-memory state, so the
  backend and the launcher can each ask independently and get the same answer.
  It returns a `fingerprint` the baseline cache keys on.

**Adding a kind is one file under `kinds/` plus one line in `kinds/index.mjs`.**
Nothing in `registration.mjs` or `store.mjs` changes.

`reap(config, handle)` is where protocol MUST 3 lives for a kind whose children
are not its OS descendants. `handle` carries the host child's pid and the
per-exec `token` — the core generates the token and passes it in the
`ExecRequest`, but never injects it into the environment itself, so a
frame-supplied `env` (which **replaces** the environment) is never polluted; a
kind that needs it puts it on the far side inside its own `spawnPlan`.

`reap` may **throw**, and that is part of the contract: a kind that cannot prove
its relay reached the far side must say so rather than return quietly. The core
reports it and carries on.

`connect(config)` / `disconnect(config)` are **required on every registered
kind** — they are the operator gate's per-kind side effect, not a multiplexing
feature, so a kind with nothing to open still implements them. Nothing in the
frame loop calls them; the backend's two gate routes and the live fixtures do.
**The typedef at `src/launcher/kinds/index.mjs` is the single home** for what
they govern, what may throw, and what the backend does when one does — read it
there rather than here.

`channelPlan(config, {remoteId})` is **optional** and, like `spawnPlan`, **pure**
— it builds the argv of **one long-lived shell** on the target which
`src/launcher/channel.mjs` holds open and writes framed commands into, instead
of paying a process + daemon + container-exec setup per frame. Only `docker`
implements it; `ssh` and `host` do not, and every call site treats its absence as
"no channel offered", so those kinds are unchanged. See
"The held-open channel" below.

`classifyFailure(config, {code, stdout, stderr})` is **optional** and reads the
*transport's* own error vocabulary — a docker daemon response — turning a
non-zero exit into a named protocol failure instead of an `exit` frame. Only the
kind can own it: for a stopped container the store record exists, so
`remotes.mjs` resolves the target happily and the failure appears solely as a
non-zero exit of the docker CLI. It is consulted on **both** exec paths, so one
implementation covers `exec`, `readFile`/`writeFile` and the baseline probe:
`session.mjs`'s child-`close` handler (which keeps a bounded 512-byte head of
each stream for it), and `run.mjs`'s single funnel. Returning `null` — the common
case, and every kind without the member — leaves behaviour exactly as it was.

**`ExecRequest.env` is THE FRAME'S OWN `env`**, with `null` meaning "inherit the
**far side's**". The core never substitutes its own `process.env` for an absent
field: cc sends no `env` on **any** `exec` it issues — its own plumbing and a
caller's command alike (§7) — so every command runs in the provider's own
environment, and collapsing the two would run every derivation inside a
container with cc's host PATH. Each kind composes with the shared `execEnv`
(`kinds/config.mjs`), which is also where `CC_REMOTE` is overlaid — **after** the replacement, so the provider's binding beats a
frame-supplied value.

## The `host` kind

`kinds/host.mjs` execs directly on cc's own machine. It is **not** one of
`REGISTERED_KINDS` and never gets a cc System row.

**Why it exists.** Two reasons, each load-bearing on its own:

1. **It is the only far side that reaches the test process's own filesystem.**
   cc's suite "builds its fixtures with node's own `fs` and then asks the
   provider about them, so it verifies a provider that reaches **the same
   filesystem as the test process**" (`systems-protocol.md` §10). A docker or
   ssh target does not. `CC_CONFORMANCE_REMOTE_ID` fixes *addressing*, not
   *filesystem identity*, so binding a docker target to a named handle does not
   substitute. The same requirement makes `host` the far side for two of our own
   suites: `tests/fileops.test.mjs` (the only real-shell proof the generated
   read/write scripts are correct rather than just the host-side parse) and
   `tests/baseline.test.mjs` (the only proof `PROBE_SCRIPT` is valid POSIX sh).
   Both are deterministic, with no docker and no network.
2. **`npm run conformance` drives the battery through the SHIPPED launcher** —
   `tests/conformance.mjs` runs `[node, src/launcher/main.mjs, --kind, host]` —
   so it exercises arg parsing, kind dispatch, the frame loop, routing and the
   shutdown path. A transport exercised directly would prove none of that.

**The rejected fourth option, recorded so nobody re-litigates it.** Demoting
`host` to a *test-only* provider entry point (not a shipped `--kind`) is
launchable — `CC_CONFORMANCE_PROVIDER` takes an argv, never a registered cc
kind — but it fails reason 2: it would prove the transport speaks the protocol,
not that the shipped launcher does. Recovering that means importing `main.mjs`
from the entry point, which is `--kind host` with extra steps and a second code
path to keep correct.

**The old justification was FALSE and has been deleted.** It held that an
always-`remotes:true` kind was permanently barred from the suite's core
capability configurations. Three measurements at cc `8b7b10bf` refute it: `IS_REFERENCE_PROVIDER` is an
*identity* gate (`!process.env[PROVIDER_ARGV_ENV]?.trim()`), not a shape gate;
`assertNegotiatedCapabilities` deep-equals the whole object only for the
reference provider and otherwise loops `TOGGLED_CAPABILITIES`, which derives to
`processGroupSignal` alone, tolerating `remotes`/`remoteDescriptors` as a
superset; and `CAPABILITY_CONFIGS` is **two** configurations, not three. `host`
unlocks **zero** rows a bound `docker` would not — see the four skips below.

**The guard, and a DEVIATION FROM THE PLAN.** The plan required **two**
conditions: an env seam **and** at least one mandatory
`--remote <id>=<absolute root>` fence. The mandatory fence is unimplementable,
and the reason is on **our** side of the wire, not cc's: `CAPABILITY_CONFIGS`
pass no flags at all, so no `--remote` reaches us in the core battery, so
`hostUnfencedRefusal()` fires and the launcher exits 2 **before any frame**.
Every core configuration would die at the launch, not at an assertion — killing
reason 2 above.

What ships is two seams that split along the *risk* instead:

| Launch | Needs |
|---|---|
| `--kind host --remote a=/some/root` | `CODE_SYSTEM_ALLOW_HOST_KIND=1` |
| `--kind host` (serves unfenced) | that **plus** `CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED=1` |

**No shipped code path sets the second one** — only tests do (`conformance.mjs`,
`hostkind.test.mjs`, `capabilities.test.mjs`). That property, not the number of
setters, is what to preserve when adding a test. So a hand-registered row needs
someone to have deliberately exported a variable **with `UNFENCED` in its name**
into the orchestrator's environment.

**What the seams actually buy — the weaker, true claim.** A cc System row's
`launch` is a `string[]` cc validates only for **shape** and **reachability**:
`validateLaunch` (`appSettings.ts`) checks it is a non-empty array of non-empty
strings, and `verifySystemLaunch` proves it works by *spawning it and
handshaking*. `getSystems()` then reads it back with no content check and
`resolveSystem` spawns it. There is **no allow-list and no path check anywhere**
— nothing constrains *which* executable an argv names. So anyone able to
register a System row can already have cc spawn an arbitrary argv on cc's host,
and these seams are **not** what stands between an attacker and host execution.

What `--kind host` genuinely adds over "some arbitrary argv" is narrower: it
turns a one-shot argv into a **standing, documented, protocol-speaking exec
service** any cc project can be pointed at via its *Remote* field. The two env
seams are **defence-in-depth against our own auto-registration bug** — a `host`
row escaping `desiredRows()` — and against a user hand-registering `--kind host`
without understanding it. They stop a **misconfiguration** becoming that
service; they do not stop a **compromise**. The `REGISTERED_KINDS` omission is
the separate half: it is what stops *us* ever creating such a row. Neither is a
capability check. (`kinds/host.mjs`'s header says the same thing; the two used
to contradict each other and no longer do.)

Failure is **stderr + exit 2 before any frame**, so cc's registration answers 502
quoting it, which `registration.mjs` surfaces verbatim. Both seams are pinned by
`tests/hostkind.test.mjs`, which carries a note saying the single-condition guard
is deliberate — so an attempt to "restore" the plan's version reads the reasoning
instead of just a red test.

**The `--remote` fence is LEXICAL, not containment.** It is `path.relative`
against the root with no `realpath`, so a symlink inside the root points wherever
it likes and is not refused. This is deliberate and not worth fixing: on `host`,
`exec` is arbitrary by design (`cat` reads the same file), and the fence exists
only for the test vehicle — production `docker`/`ssh` remotes carry no root at
all. **Neither `docker` nor `ssh` treats it as a containment primitive, and a
future kind must not either.**

**Its capabilities are DERIVED FROM ITS FLAGS, and that is load-bearing.**

| Capability | `host` |
|---|---|
| `processGroupSignal` | `true` unless `--no-process-group-signal` |
| `remotes` | at least one `--remote` given |
| `remoteDescriptors` | at least one `--mirror` or `--exclude` given |

This is the shape cc's own reference provider uses (`remotes:
this.#opts.remotes.size > 0`, the hello capabilities block in
`referenceProvider.ts`), and the suite's assertion message states the intent:
*"the flags the provider was launched with are what it advertises"*. Bare `host`
equals `CAPABILITY_CONFIGS[0].caps` verbatim and `--no-process-group-signal`
equals `CAPABILITY_CONFIGS[1].caps` verbatim — because they are derived, not
hardcoded. A kind that hardcoded any of the three would fail the deep-equal the
reference-provider path makes.

### The launch surface the suite appends

`systems-protocol.md` §10 → **"The launch surface — what the suite sends beyond
the wire contract"** is now the authority, and it is complete: cc card 2026-0313
landed and closed the gap this section used to record as pending. Do not
re-derive the list from cc's `referenceProvider.ts`; read §10's table.

What it obliges a provider being verified to do:

| Flag / variable | The provider must |
|---|---|
| `--no-process-group-signal` | signal the direct child only |
| `--remote <id>=<absolute root>` | **serve that target** — the id is its whole address; an unknown or absent id is an id-addressed `ENOREMOTE` |
| `--mirror <[id=]absolute root>` | answer `describeRemote` with that `mirrorRoot` |
| `--exclude <[id=]absolute path>` | add that path to the same descriptor's `exclude` |
| `CC_REMOTE=<id>` | be in the environment of **every child an `exec` starts** |

Each capability is advertised **iff** at least one of its flags is given, which
is why ours are derived rather than declared. A provider that accepts a flag and
ignores it fails the rows the flag toggles; one that exits on an unknown flag
fails that whole configuration at the handshake. Neither is skipped.

**THE `--remote` ROOT IS NOT A FENCE THE SUITE ASKS YOU TO ENFORCE.** §10's table
says so in the row itself — *"the root is where the suite places that target's
fixtures, **not a fence it asks you to enforce**"* — and cc's own architecture
doc says the reference provider's root fence is *"this provider's property, not
a protocol obligation"*, exercised by no row in the suite. **`docker` implements
no root fencing, and neither does `ssh`.** Our
`host` kind fences because a test vehicle on cc's own machine needs a misroute to
be *refusable*, not because the battery demands it — and production
`docker`/`ssh` remotes carry no root at all.

### What a third-party run does NOT verify

Four rows skip for **any** third-party provider, all gated on
`IS_REFERENCE_PROVIDER`. They are identical for `host` and for a bound `docker`,
and their printed reasons are the list of what the run does not check:

| Test | Printed reason |
|---|---|
| `a provider that does not advertise remotes is never handed a remoteId` | `cc-side fixture, pinned to the reference provider: asserts what CC does, not what a provider does` |
| `a provider without the capability advertises no mirror` | same |
| `CC_CONFORMANCE_REMOTE_ID binds the fixture handle, and an explicit remoteId still wins` | `asserts the unset default` |
| `every code in the taxonomy is produced by a real failure somewhere in this suite` | `counts producers across rows a third-party run skips` |

A **fifth** skip, or a different reason string, means the harness changed and
this section needs re-checking.

### The bound conformance run

`docker` and `ssh` always advertise `remotes:true` and `remoteDescriptors:true`.
Since cc `8b7b10bf` that no longer bars them from the battery: `CC_CONFORMANCE_REMOTE_ID` binds every
fixture handle to one named target, and the third-party capability assertion
tolerates `remotes`/`remoteDescriptors` as a **superset**. Card 2026-0014 landed
the rig — `npm run conformance:docker` — so the shipped `docker` transport is
**measured** under the battery's own fixtures rather than generalised to from
`host`. Every measurement behind this section is in
`.wiki/gotchas/bound-conformance.md`; the design is here.

**What the rig is.** `tests/conformance-docker.mjs` establishes filesystem
identity by measurement, starts one container, probes the tooling baseline,
seeds one store record, runs cc's suite, parses the reporter's output and
compares it against a manifest. `tests/ccCheckout.mjs` holds everything it
shares with the `host` runner: the `CC_CHECKOUT` gate, the drift check, the
spawn, and the parse. `tests/boundConformanceFixture.mjs` owns identity;
`tests/boundConformanceExpectations.mjs` owns the manifest;
`tests/launcherDiagnostics.mjs` reads the launcher's own stderr back;
`tests/boundconformance.test.mjs` covers the pure halves of all three in
`npm test`, with no docker.

**The `TMPDIR` seam is what makes it possible.** cc's suite builds its fixtures
with node's own `fs`, rooting every one at `os.tmpdir()` — which reads `TMPDIR`
on every call. Pointing it at a directory the container also sees redirects the
fixtures with **no edit to cc**, and it survives cc's own run isolation because
`tests/safeStoreRoot.mjs` derives its `REAL_TMP` from `os.tmpdir()` too.

**The container's shape, and why each argument is there.** `--user
<uid>:<gid>` — the suite's `EACCES` row chmods a file to `000` and requires the
refusal, and a default `node:24-slim` runs as root, which reads it. `-v <host
path>:<container path>` of the repo's gitignored `.conformance-tmp` — **a `-v`
source path is resolved by the daemon, on the host**, so only paths that exist
on the host are bindable; `/tmp` in this container is its own overlay and is
not, while the workspace bind is. Both halves of that pair are measured and
cross-checked (`docker inspect .Mounts` against `/proc/self/mountinfo`), never
literals. `--pid=container:<self>` — cc's suite records a grandchild's pid from a
command the **far side** ran and then SIGKILLs that number in **its own**
namespace; sharing the namespace is what makes those the same pid. **A daemon
that refuses it aborts the run**, because an unoccupied low pid range is luck and
not a guard; `CODE_SYSTEM_ALLOW_UNSHARED_PID=1` is the deliberate override. The
runner prints the observed far-side pid and what this namespace called it either
way, so a killed-something-else event is attributable.

**The manifest is one table doing both jobs.** Anything not listed must PASS;
anything listed must produce exactly its listed outcome, verbatim skip reason
included; and a listed row that starts passing is **red**, because a manifest
that only catches regressions has stopped discriminating. Every entry carries a
mandatory `cause` that must **cite** a file or a spec section, and the module
throws at import without one — a length floor alone is gameable, which would make
"a bare 'expected to fail' cannot be added" untrue.

**Three independent guards, catching three different things.** `compareOutcomes`
is per-row; `checkTally` cross-checks the parse against the reporter's own
arithmetic, catching a corrupt or empty parse; and `checkTotal` pins the
battery's **absolute size**. The third is not redundant: the first two are both
relative to what the run reported, so a row VANISHING from cc's suite moves the
parse and the tally together and is invisible to both — the gate would simply
cover one row less and stay green. `checkTotal` is red in both directions,
because a vanished row and a new row are the same event.

**Interruption is handled, `kill -9` is not.** SIGINT/SIGTERM/SIGHUP tear down
and re-raise; a `kill -9` of the runner leaks the container and the scratch, and
the sweep is `docker ps -a --filter name=code-system-test-boundconf` plus
`rm -rf <repo>/.conformance-tmp`.

**The two structural non-coverages, with their causes.**

1. **`processGroupSignal`.** `src/launcher/kinds/docker.mjs` hardcodes `false` —
   a locked decision, argued below under "The `host` kind" and in
   `.wiki/gotchas/docker-exec-transport.md`. `CAPABILITY_CONFIGS[0]` passes no
   flags and requires `true`, and §10's third-party relaxation covers
   `remotes`/`remoteDescriptors` only, so **two rows of that configuration fail
   and neither is skipped**. §10 names our exact shape — a provider that accepts
   `--no-process-group-signal` and ignores it — as failing rather than skipping.
2. **The six `--remote`/`--mirror`/`--exclude` rows.**
   `src/launcher/main.mjs` refuses those flags for a store-backed kind with exit
   2 before any frame, so the rows that launch their own provider with them never
   handshake. Deliberate, and not a gap to close: a flag-backed target source on
   a shipped store-backed kind would be a **second remote path around the single
   `ENOREMOTE` chokepoint** in `StoreRemoteSource.lookup`. The refusal stands now
   that `docker`/`ssh` do answer `describeRemote`: their advertisements come from
   `record.mirror` in the store, not from argv.

Related, and off-spec but legitimate: §10 says `CC_CONFORMANCE_REMOTE_ID`
presupposes `--remote`, and this run passes none. It clears the harness's
bound-run precondition only because `StoreRemoteSource.hasRemotes()` is constant
`true` — the constant is the reason it is legitimate.

**`ssh` does not inherit the result, and needs its own card** — the two kinds'
residues differ in exactly the axis the battery stresses hardest. The argument is
in `.wiki/gotchas/bound-conformance.md` → "`ssh` does NOT inherit this result".

**What the seam carries, and what it does not.** `protocol.mjs`, `session.mjs`
and `fileops.mjs` are kind-agnostic and `spawnPlan` is pure, so **`host` passing
the core suite proves the core's LOGIC for every kind.** The per-kind residue is
argv construction, `reap` and `classifyFailure` — covered for `docker` by unit
tests on the pure `spawnPlan`, `tests/docker-live.test.mjs` against a real
container, and now the bound run; and for `ssh` by `tests/sshkind.test.mjs` plus
`tests/ssh-live.test.mjs` against a real sshd.

**It does not carry the core's ASSUMPTIONS ABOUT WHEN A TRANSPORT MAY SPEAK, and
the bound run proved that with a real defect.** Card 2026-0016's hole is inside
the supposedly kind-agnostic `session.mjs` — it streams a child's stdout before
the exit code lets `classifyFailure` see it — but it is TRIGGERED by a per-kind
property the seam does not describe: where a wrapper CLI puts its own
diagnostic. `host` cannot reach it, and not by luck: node raises `ENOENT` inside
the spawn itself, so a `host` exec that never starts emits zero stream frames and
lands exactly in the "the error fires before any data" case cc's collector
assumes. Read the seam as covering logic, not as covering every interaction
between kind-agnostic code and a kind's own timing.

**Run cc's suite against a CLONE of the pin, never against a live cc worktree.**
Both conformance runners run cc's own test runner with `cwd: <checkout>`
(`tests/ccCheckout.mjs`), so `CC_CHECKOUT` must not point at a checkout somebody
else is working in:

```sh
git clone --no-hardlinks <cc-checkout> /tmp/cc-pin && git -C /tmp/cc-pin checkout <pin>
ln -s <cc-checkout>/node_modules /tmp/cc-pin/node_modules   # or: npm ci in the clone
CC_CHECKOUT=/tmp/cc-pin npm run conformance
```

**Do not add a flag to docker or ssh to fake `remotes:false`.** That would be a
test-only divergence in the one field cc negotiates on, and cc's own harness
says so (`referenceProviderHarness.mjs`, the `assertNegotiatedCapabilities`
note). It is also unnecessary — a bound run needs no such lie.

**Two standing obligations for any kind, both now discharged by both
transports:**

1. **Every config field that becomes an argv OPERAND must reject a leading `-`**
   (`operand()` in `src/launcher/kinds/config.mjs`). `docker`'s `container` and
   `ssh`'s `host` and `user` do, and both `spawnPlan`s really do place their
   operand after a `--`. A leading dash turns an operand into an option —
   `container: "-v /:/host"` is argument injection against `docker`, and
   `host: "-oProxyCommand=…"` against `ssh` — and the refusal belongs in
   `validateConfig`, not in `spawnPlan`, so a bad value never reaches the store.
   **`ssh` needs a second terminator as well**, for GNU `env`'s option section;
   see `docs/protocol.md`.

   **A field that becomes a FLAG'S ARGUMENT is the other case, and must not use
   `operand()`** — `docker`'s `user` (the card's **Run as** → `docker exec -u
   <value>`) is the one today, and is a different field from `ssh`'s `user`. A
   flag consumes the next argv element whatever it begins with, so `operand()`'s
   refusal would tell the operator two untrue things about their field. Such a
   field is still validated — by the kind, to that field's own shape
   (`IDENTITY_RE`), which refuses a leading `-` among much else — and `spawnPlan`
   emits the flag and its value as **two** argv elements, left of the `--`. The
   rule a kind author needs is therefore: decide which of the two a new field is,
   and take the matching treatment; `docs/protocol.md` → *Config values that
   become argv* is the full statement.
2. **`exclusive`'s remaining gap is a check-then-act race on a target shell that
   ignores `noclobber`** — not a routine truncation, because the script's
   `[ -e ]` pre-check is a plain `test` no shell can ignore. Scoped, measured
   against both live targets, and accepted rather than hardened: see
   `docs/protocol.md` → "What `exclusive` does and does not guarantee".

## The config store

**Location:** `$CODE_SYSTEM_STORE`, else `<os.homedir()>/.code-system`.
Resolved in `src/paths.mjs` and nowhere else.

Not under cc's store because the launcher's environment carries no
`PROJECTS_ROOT` and its cwd is cc's — a home-relative absolute path is the only
thing both processes compute identically from nothing. It is also right on the
merits: a container or an ssh host is a fact about the *host machine*, not about
one cc store, so two cc servers on the same box see the same remotes.
`CODE_SYSTEM_STORE` exists for test isolation.

```
<store>/remotes/<remoteId>.json      one file per remote
<store>/quarantine/<id>.<stamp>.json what the migration could not read
```

One file per remote, not one catalog: a per-frame lookup is one small read
instead of a parse of every remote, two concurrent writes cannot clobber each
other, and delete is an `unlink`. The record's fields are in
`makeRecord` (`src/store.mjs`); `config` is **opaque** to the store and owned by
the kind's `validateConfig`.

**`mirror` sits beside `enabled`, not inside `config`**, and for the same reason:
it is **kind-agnostic operator policy**, not connection details the kind owns.
`null` means the remote advertises nothing. Keeping it out of `config` also keeps
it out of `sameConfig` (`src/api.mjs`), so editing a mirror — which names the
same target — does not reset the gate and the baseline the way a config change
does. Validated once, at the API's front door, by `src/mirror.mjs`.

**"Read fresh per operation" is achieved by having no cache at all.**
`readRemote` is `readFile` + `JSON.parse` on every call, with no memoisation and
no `fs.watch`. That absence is the mechanism: the launcher holds no remote state
between frames, so there is nothing for the backend to invalidate. Pinned by
`tests/store.test.mjs` → *"there is no cache"*.

**Writes are backend-only and atomic**: a unique temp beside the target
(`<id>.json.<pid>.<seq>.tmp`), `fsync`, `rename` over, unlink on any failure.

### The operator gate (`record.enabled`)

**Where it lives, and why the store rather than memory.** The backend and the
launcher are different processes — cc spawns the launcher per System row — so a
gate in backend memory would never reach it. As a store field it inherits the
no-cache property above: `readRemote` is `readFile` + `JSON.parse` per call and
`lookup` runs on every request frame, so **a toggle flipped in the UI is visible
to the very next frame**, with no restart, no IPC and nothing to invalidate. The
absence of a cache *is* the mechanism. `tests/gate.test.mjs` pins it end to end
in one launcher process, both directions.

**Where it is enforced: exactly one site.** `gateRefusal(rec)` in
`StoreRemoteSource.lookup()` (`src/launcher/remotes.mjs`), which `session.mjs`
calls once for all four REQUEST frames and nowhere else. Follow-on frames
(`data`, `end`, `signal`, `close`) are addressed by an id already bound to a
remote, so nothing slips past — a `writeFile` was gated when it opened. The wire
shape and the `ENOREMOTE` argument are in `docs/protocol.md` → `remoteId`
routing; they are not restated here.

**It runs before `baselineRefusal`.** A switched-off remote must say *switched
off*, not *fails the tooling baseline*.

**Three things are deliberately NOT gated**, each for its own reason:

| Not gated | Why |
|---|---|
| `Transport.reachability` | it queries a host-side artifact only (`docker inspect`, the ControlPath socket) and never the target, and it is how a disabled card still shows probed reality |
| `Transport.reap` | it does not pass through `lookup`, and gating it would abandon far-side processes at shutdown — the MUST 3 leak. An operator disabling a remote *over live work* is the reachable form of that hazard, and is what the test drives |
| `FlagRemoteSource` | it reads no store, so it has no record to carry a gate. That is why cc's conformance suite (`--kind host`) is unaffected **by construction** rather than by luck — proven twice: a unit test, and an actual suite run |

**The backend has one path that must be gated separately.** The tooling-baseline
probe execs INTO the target but runs in the backend, bypassing `lookup`
entirely, so `enabled` is part of `refreshBaseline`'s condition
(`src/baseline.mjs`). A disabled remote is never probed.

### The card UI

Four files under `frontend/`, vanilla ES modules, no build step — code-hub's
layout.

| File | Owns |
|---|---|
| `index.html` | the static shell |
| `styles.css` | all styling. cc injects **no CSS and no tokens** across the iframe and hard-codes `#plugin-frame { background: #fff }` while its own shell is dark, so the token block is load-bearing, not decoration |
| `app.js` | fetch, poll, state, `render()` — **DOM only** |
| `cardState.mjs` | **pure, DOM-free**: the gate/probe vocabulary, the alerts, the routing, and the mirror form↔wire conversion |

**The split is the test strategy.** Every decision a card makes lives in
`cardState.mjs` and is unit tested with `node --test` and no browser
(`tests/cardstate.test.mjs`); `app.js` is wiring. `tests/frontend.test.mjs`
additionally reads the files off disk for the compliance items that fail only
once mounted under cc, and asserts `cardState.mjs` touches no browser global —
the moment it does, the seam is gone.

**The Advanced group** (`formFor`, `frontend/app.js`) is the first and only
`<details>` in this UI, and it holds **two kinds of member**:

- an **advanced config field** — a `configFields` entry from the kind's own
  descriptor flagged `advanced: true` (docker's `user`). `formFor` builds every
  config field with one `configField(f)` helper and routes the flagged ones here
  instead of into the connection block; nothing else about them differs. It is
  validated and stored by the kind exactly like a connection field, which means
  **changing it resets the gate and the baseline** (`sameConfig`, `src/api.mjs`).
- the **mirror form** — top-level operator policy beside the config: a checkbox
  gating a root `<input>` and an exclude `<textarea>`. The draft holds **form
  state** — `{on, root, exclude}` with `exclude` as raw newline-separated text —
  and `mirrorPayload` / `mirrorSummary` in `cardState.mjs` convert to the wire
  shape and to the card badge, for the same reason every other card decision
  lives there. **Changing it resets neither**: it names the same target.

The mirror prefill comes from the `mirrorDefaults` on `GET /api/remotes`, so the
frontend holds no second copy of the default list — and the **mirror half alone**
is absent until that answer lands. The group itself is not: an advanced config
field comes from the descriptor and has nothing to prefill from, so gating the
whole `<details>` on the defaults would hide a stored value with no error
anywhere (`tests/render.test.mjs`). There is no per-field
error display: a 400 from the validator reaches the operator through the existing
top-of-page banner, which is why `validateMirror`'s messages quote the offending
value and an entry's index.

Two divergences from code-hub, each with its reason:

- **The poll is 10 s and visible-tab-only** (code-hub polls a flat 2 s). Each
  refresh costs one `docker inspect` / `ssh -O check` **per remote**, each
  bounded at 5 s. The manual refresh and the refresh after every action are
  unconditional.
- **Routing is query-string only** (`?add`, `?edit=<id>`), never a path segment.
  cc's proxy guarantees a trailing slash by `301`, but relative URLs resolve
  wrongly under a no-trailing-slash deep link; a constant path makes that
  hazard unreachable. `history.replaceState` plus a `popstate` listener, because
  cc's bridge demotes `pushState` to `replaceState` and delivers its own
  navigation as a synthetic `popstate`.

### `KIND_META` and `kindDescriptors()`

Each kind exports a `KIND_META` — its human label and the `configFields` the
card's form is generated from — and `kindDescriptors()`
(`src/launcher/kinds/index.mjs`) collects them, **throwing** for a registered
kind that has none rather than serving a card with an empty form. `host` has no
meta deliberately: it is never registered and never gets a card.

The label lives there and nowhere else: `src/registration.mjs` reads it for the
cc System row, so the name in cc and the name on a card cannot drift.
`tests/kindmeta.test.mjs` pins `configFields` against what each kind's
`validateConfig` actually accepts — same field names, and every `required` flag
really required — because that drift would fail only in a browser.

A field may carry **`advanced: true`**. It is a **rendering flag only** —
`kindDescriptors()` passes `configFields` through by reference, the card form
draws a flagged field inside its Advanced `<details>`, and the kind validates,
stores and resets it exactly like any other config field.
`tests/kindmeta.test.mjs` pins that last part, so the flag cannot become a
second, weaker class of field.

### The environment seams

Every variable this plugin reads, in one place. **The list is a swept one** — a
row added without re-sweeping is how the claim above stops being true, and it has
already failed twice that way (`CONDUCTOR_URL`/`PORT` were missing when `TMPDIR`
was added; `CODE_SYSTEM_FAKE_REAP_LOG` when the sweep was first written).
Re-derive it, don't extend it — **three probes, and all three are needed**:

```sh
# 1. named reads. tests/ is IN SCOPE: four rows below are read only there.
grep -rhoE 'process\.env\.[A-Z][A-Z0-9_]*' src/ tests/ server.mjs frontend/ \
  | sed 's/process\.env\.//' | sort -u
# 2. names held in a constant, so probe 1 never sees them.
grep -rhoE "'[A-Z][A-Z0-9_]*'" --include='*.mjs' src/ tests/ \
  | grep -E 'CODE_SYSTEM|^.CC_' | tr -d "'" | sort -u
# 3. the ones nothing names. `os.tmpdir()` reads TMPDIR, and no grep for the
#    string would ever find it.
grep -rn 'os\.tmpdir()' src/
```

**Three kinds of hit the probes surface that are NOT rows**, and the reason is
the same each time — they are not how this plugin is configured. `PATH` is read
only to *compose a child's* environment; `CC_REMOTE` and `CC_EXEC_TOKEN` are
variables we *write into the far side's*; `CC_TEST_FILE_KILL_MS` is cc's, named
here only to say we never set it. Separately, and not a named read either:
`execEnv`'s `base` defaults to `process.env`, which is the REPLACE branch's
baseline — see "`exec` env across a boundary" in the wiki.

Two rows are **conductor-set** (`CONDUCTOR_URL`, `PORT`) and the rest are
**operator-set**: cc spawns the launcher with the *orchestrator's* environment,
and the backend reads the same names in-process, so one function serves both
surfaces.

| Variable | Read by | Effect |
|---|---|---|
| `CODE_SYSTEM_STORE` | `src/paths.mjs` | store root; else `<homedir>/.code-system`. Test isolation |
| `CONDUCTOR_URL` | `src/registration.mjs` → `register`, `src/api.mjs` → `projectsNaming` | cc's base URL. **Unset is a normal state, not a failure**: registration reports `skipped` and `projectsNaming` answers `[]`, because standalone-runnable is a plugin-compliance requirement |
| `PORT` | `server.mjs` | the backend's listen port, conductor-allocated. Default `4310`, for the same standalone-runnable reason |
| `CODE_SYSTEM_DOCKER` | `kinds/docker.mjs` → `dockerCliArgv` | the **whole docker invocation** as a JSON array, e.g. `["sudo","-n","docker"]`. Default `["docker"]` — no `sudo` in the shipped default. Malformed → throws → launcher exit 2 before any frame |
| `CODE_SYSTEM_SSH` | `kinds/ssh.mjs` → `sshCliArgv` | the **whole ssh invocation** as a JSON array, e.g. `["ssh","-F","/path/ssh_config"]`. Default `["ssh"]` — the operator's own `~/.ssh/config` and agent. Malformed → throws → launcher exit 2 before any frame |
| `CODE_SYSTEM_ALLOW_HOST_KIND` | `kinds/host.mjs` | permits `--kind host` at all |
| `CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED` | `kinds/host.mjs` | permits `--kind host` with no `--remote` fence. **No shipped path sets it** |
| `CODE_SYSTEM_FAKE_TRANSPORT` | `main.mjs` | module path for `--kind fake`. Tests only |
| `CODE_SYSTEM_FAKE_REAP_LOG` | `tests/fakeTransport.mjs` | file the fake transport appends each `reap` to, so the shutdown tests can prove the relay ran. Tests only |
| `CODE_SYSTEM_CHANNEL` | `launcher/channel.mjs` → `channelEnabled`, read in `main.mjs` | `=0` removes the held-open channel pool **entirely** — the operator's escape hatch, and the arm `tests/conformance-docker.mjs` runs second. Any other value (including unset) is the shipped behaviour |
| `CODE_SYSTEM_FAKE_CHANNEL` | `tests/fakeTransport.mjs` | `=1` gives `--kind fake` a `channelPlan` over the local `/bin/sh`, so the channel's wiring is drivable with no docker. Tests only; without it every existing fake-kind test is byte-identical |
| `CC_CHECKOUT` | `tests/ccCheckout.mjs` | gates both conformance runs |
| `CODE_SYSTEM_ALLOW_UNSHARED_PID` | `tests/conformance-docker.mjs` | `=1` permits the bound run when the daemon refuses `--pid=container:`. **Refused by default**: cc's suite SIGKILLs a far-side pid in this namespace, and an unoccupied low pid range is luck, not a guard |
| `TMPDIR` | `kinds/ssh.mjs` → `controlDir`, via `os.tmpdir()` | the ControlPath's parent directory; `controlPathFor` refuses rather than truncates past the ceiling. Also **set** by `tests/conformance-docker.mjs`, to redirect cc's own fixture roots |

**Why the docker and ssh CLIs are env vars rather than store fields or launch
flags.** One argument, and it covers both.
A store field would be an **HTTP-writable executable argv** on cc's host — the
REST surface writes remote records, so a card-UI field taking an argv is remote
code execution by design, and `kinds/config.mjs` can keep a stored value from
becoming an *option* but not from becoming an *executable*. A launch flag would
have to get its value from somewhere anyway and changing it would force
re-registration, because `src/registration.mjs` makes the launch argv a function
of **(install path, kind) only** — which is what holds cc's connection cache
while remotes come and go.

### The startup pass

`src/migrate.mjs` runs once at backend start, before anything serves, and has
**two jobs, in this order**: **upgrade** a record at the immediately previous
schema in place, then **quarantine** a record the current readers still cannot
understand — moved aside, never deleted. Its "already applied" self-check is the
store's own contents, so it needs no marker file.

**Schema 1 → 2** (card 2026-0017) added `mirror` as a top-level field. A
schema-1 record advertised nothing, so `upgradeToSchema2` rewrites it as
`{...raw, schema: 2, mirror: null}` — the same "I advertise nothing" it already
had, and every other field deep-equal. It is **exact-version** (`raw.schema !== 1`
falls straight through), which is what makes a second run rewrite no bytes with
no marker file. Unparsable JSON, a non-object, or a record whose `remoteId` does
not match its filename all answer `'skip'` and fall into the quarantine branch.
That last one matters — `writeRemote` addresses the file *by* the record's
`remoteId`, so rewriting a mismatched record would write the wrong file.

**No single record may take the pass down**, because `server.mjs` awaits it
before `listen` and the backend is the operator's only repair tool. The upgrade
**write** and the quarantine **move** are each caught: the failure is logged
naming the record, and the loop continues. A write that failed answers `'failed'`
and **skips the rest of that record's iteration** — it is still at schema 1,
which `readRemote` refuses with a quarantine reason, so falling through would
move aside a healthy record over a transient disk error, and the upgrader only
ever scans `remotes/`. Deliberately **not** guarded: creating the remotes
directory itself, at the top of `migrate`. That is not one record's problem, and
a backend that cannot make its own store should fail loudly.

**The upgrade runs BEFORE the quarantine branch and reads the raw JSON itself**,
and this stays the standing constraint for schema 3: `readRemote` refuses an
unrecognised schema with reason `'schema'`, and `'schema'` is in
`QUARANTINE_REASONS`, so an upgrade ordered after it would move every existing
remote aside instead of upgrading it.

Application code still assumes the **current schema only** — no read-time
dual-shape parsing, no legacy key aliases, no back-compat defaults. A record at a
schema this version does not recognise is from the future or is corrupt, and
quarantining it is the honest answer rather than a guess.

**Known transient:** a launcher spawned against a schema-1 record *before* the
backend's first run refuses that remote with `ENOREMOTE`, whose message already
names the repair. The window is "plugin updated, backend not yet started".

A launcher that meets a record at another schema refuses **that remote** with
`ENOREMOTE`, quoting the schema it found and naming the backend as the repair.
It does not attempt a read-time upgrade and it does not fail the connection — a
launcher can legitimately be spawned before the backend has ever run.

## The held-open channel (`docker` only)

Every frame used to cost one `docker exec`. Measured through the shipped
launcher against a live container with `node tests/bench-channel.mjs`
(15 samples/op after 6 warm-up frames, Docker Engine 29.7.2, `node:24-slim`):

| op | per-op spawn | held-open channel | speed-up |
|---|---|---|---|
| `stat` | 94.2 ms median (min 65.6, p90 100.2) | 5.9 ms (min 4.9, p90 7.0) | 16.1x |
| `lstat` | 91.6 ms (min 73.3, p90 99.5) | 5.0 ms (min 4.6, p90 5.6) | 18.2x |
| `readDir` | 94.6 ms (min 74.2, p90 100.7) | 5.8 ms (min 5.1, p90 6.7) | 16.4x |
| `realpath` | 86.1 ms (min 67.5, p90 102.6) | 4.2 ms (min 2.7, p90 4.8) | 20.4x |
| liveness probe | 84.3 ms (min 66.6, p90 97.7) | 2.0 ms (min 1.4, p90 3.2) | 43.0x |
| `readFile` | 89.0 ms (min 73.0, p90 101.1) | 6.8 ms (min 5.4, p90 8.1) | 13.0x |

**The cost removed is the SPAWN, not the command** — `docker exec … true` costs
the same as `docker exec … stat`. Nothing is deployed into the target: the
channel execs a POSIX shell the container already provides, the same dependency
every derived file operation already has.

**Two modules, one responsibility each.** `src/launcher/admission.mjs` decides
*which frames* may ride it; `src/launcher/channel.mjs` owns the pool, the
framing and the op state machine. The kind contributes only the pure
`channelPlan`. The argv itself, the op framing and the admission table are
specified in `docs/protocol.md` → "The held-open channel".

**What rides it.** Admitted `exec` frames — cc's own derivations, by exact
command vector — plus the launcher's own `readFile`/`writeFile` scripts, which
reach it through `makeRunner` and are admitted by **provenance**: `fileops.mjs`
authors them, nothing frame-supplied reaches them except as a quoted operand, and
they background nothing. The backend's baseline probe passes no pool: it is a
one-off call with no shutdown path to close a channel on.

**Never queue, and a lazily-grown pool.** A single `sh` is strictly sequential.
An op that finds no idle channel is refused **synchronously** and takes today's
per-op spawn, so the worst case is exactly today's latency and the pool can never
become a bottleneck; a new channel is opened in the background, one at a time, up
to `MAX_CHANNELS_PER_TARGET` per (container, identity, remote). A channel is
offered only after a handshake op has proved it alive — without that, a channel
against a stopped container would be handed an op that failed `ETRANSPORT`,
losing `classifyFailure`'s operator-facing `ENOREMOTE` message.

**A channel whose payload op FAILED is retired, not returned to the pool.** The
ready marker guarantees the payload is *in* the pipe; nothing guarantees the op
*consumes* it. Every refusal `buildWriteScript` can produce — the
documented-common `EEXIST` pre-check, the `set -C` noclobber failure,
`ENOTDIR`/`ENOENT`/`EISDIR`/`EACCES`, and `ENOSPC` mid-decode — happens before or
inside `base64 -d`, and `head` then dies of EPIPE with the remainder still
unread. Those bytes sit in the **channel's** stdin, where the shell reads them as
script text and fuses them with the next op's command: the op that caused it
reports correctly, and an unrelated op dies later. A *successful* payload op
provably drained (`base64 -d` reads to EOF), so **exit 0 is the whole condition**
— how much `head` had pumped before its EPIPE is not knowable from this side, so
no threshold is involved. Retiring costs one lazy reopen, which is already the
status quo for a channel death. See `.wiki/gotchas/docker-channel.md`.

**Failure asymmetry.** A channel that is dead or absent *before* an op starts is
simply not offered, and the op takes the unchanged spawn path — including all of
`classifyFailure`. A channel that dies *with an op in flight* fails that op with
`ETRANSPORT` and it is **never retried, for any op kind**: cc's `#derive` reads
that code through `spawnErrorCode` and keeps it out of the errno classifier,
which is what stops a retried exclusive create's `EEXIST` being reported as a
failure that actually succeeded. There is no second restart/backoff layer —
`ProviderConnection` owns restart-on-demand; a dead channel is just not offered
and the next op that finds the pool short reopens one.

### The idle watchdog

Every dispatched channel op arms **one** timer, reset on **every byte received on
either of its streams**. After `CHANNEL_IDLE_MS` of silence the channel is
declared dead and torn down, and the op fails `ETRANSPORT`.

**Idle, not total elapsed**, because that is the property that distinguishes the
two cases: a framing desync is silent for ever, while a legitimately slow op is
making progress the whole time. A total-elapsed deadline would have to clear the
worst pathological `readDir`.

**Progress is not the same as output, and `writeFile` is the one op where they
come apart.** Most admitted ops are either fast and silent (`mkdir`, `chmod`,
`rm -d`, `unlink`, `ln`) or slow and progressively noisy (`find` over a very
large directory, a large `readFile`'s base64). A `writeFile` is neither: between
the ready marker and the sentinel it emits **zero bytes on either stream by
construction**, because the whole transfer is on stdin. An output-only timer is
therefore structurally blind to exactly the phase that takes longest, and on a
daemon slower than the localhost this constant was measured against it would kill
a healthy, progressing write. So the payload goes out one pipe buffer at a time
and **each chunk's write callback re-arms the timer** — the callback, not
`drain`, which for a payload node has already accepted whole fires once near the
end.

**What a kill mid-transfer would leave behind**, since that is what sets the
severity: an **atomic** write decodes into `<path>.<pid>.<n>.tmp` and renames, so
a kill leaves a stray temp file and the target **intact**; a **plain or
exclusive** write decodes straight into the target through a truncating
redirect, so a kill leaves it **truncated**. The `rm -f` cleanups in
`buildWriteScript` run on a non-zero exit, not on a SIGKILL.

**The residual silent window is bounded and does not grow with the payload.**
After the host writes its last byte there is genuinely no signal left but the
sentinel, and the far side still has whatever the kernel pipes hold — at most two
pipe buffers — to decode. That tail is the same for a 1 KiB write and a 32 MiB
one, which is why bounding the *transfer* is the whole of what this needs.

**`CHANNEL_IDLE_MS` is anchored at both ends.** The measured medians are 2–7 ms,
and the largest payload the protocol permits (`MAX_FILE_BYTES`) transfers in well
under a second — measured over a real channel, 1 MiB in 18 ms and 16 MiB in
40 ms, the per-MiB cost falling with size as the fixed overhead amortises. So the
constant is an order of magnitude above anything real; and it is a sixth of cc's
`DEFAULT_OP_TIMEOUT_MS`, so the watchdog reclaims
a wedged channel long before cc gives up and can never be the first to fail an op
that is merely slow. It is constructor-injectable, so `tests/channel.test.mjs`
sets it to milliseconds rather than sleeping.

**Why cc's own bound is not enough.** cc does reach an in-flight channel op on
both paths at `DEFAULT_OP_TIMEOUT_MS` — `ProviderSystem.#exec`'s abandon timer
and `#request`'s `done()` each send `{type:'close', id}` — but that is a minute
of a channel held by an op that will never answer, it depends on the counterparty
sending a frame, and a reap does not by itself produce a sentinel, so `close`
alone would leave the channel unusable rather than reclaimed.

### What the channel's coverage reaches, and what it does not

The bound run exercises the channel against cc's **current** battery, so every
derivation in the admission table — `lstat`, `readDir`, `readlink`, `symlink`
(`ln -sfnT`) and `removeEntry` (`rm -d`) included — runs over a real
`docker exec` channel and is compared arm-to-arm against the per-op spawn path.
The channel-invariance claim is a measurement on cc's own fixtures, not an
inference from the seam.

What it still does not reach:

- **Both conformance arms need `CC_CHECKOUT`.** Without it they skip cleanly, so
  a plain `npm test` proves the framing and the routing but not that cc's own
  battery is outcome-identical on the two arms.
- **A green row under one capability config can be luck.** The bound run drives
  both `CAPABILITY_CONFIGS`, but a row that passes in one and is not asserted in
  the other proves only the one.

### Two diagnostic lines, and why they exist

Admission failing closed is safe and **silent**, and this is a performance
change: if cc changes one flag in a derivation, that row de-admits, every op
quietly returns to ~90 ms, and every test in this repo still passes.

**BOTH LINES GO TO THE LAUNCHER'S STDERR, WHICH cc DISCARDS ON A CLEAN EXIT.**
`ProviderConnection` spawns the provider with piped stdio and drains stderr into
a bounded tail it prints **only** inside an ETRANSPORT message — so a launcher
that exits normally has its diagnostics thrown away, which is exactly the run in
which the drift alarm matters. `tests/conformance-docker.mjs` therefore launches
the provider through a shell that appends fd 2 to a per-arm file
(`exec` replaces the shell, so the pid and the process-tree position cc's kill
addresses are unchanged) and reads it back with
`tests/launcherDiagnostics.mjs`. Anything else on that stream is printed as
`launcher said — …`, which is what replaces the tail the redirect takes away.

1. **The drift line, once per session — and a RED bound run.** A frame that
   passes the envelope *and* opens `['env','LC_ALL=C',…]` is a cc derivation by
   construction, so matching no row is unambiguously drift rather than "something
   was refused". The text is `ADMISSION_DRIFT_WARNING` in
   `src/launcher/session.mjs`, which both the emitter and the reader import, and
   its presence in either arm fails `npm run conformance:docker`. A deliberate
   exclusion (`removeTree`) and an ordinary user command emit nothing.
2. **The census line, once, in `shutdown()`:**
   `channel carried <n> of <m> admitted ops on <k> channels`. `m` counts ops
   OFFERED to the pool; `k` counts channels that opened, so a target whose
   channel could never start reports 0 and every op took the spawn path. The
   bound run sums it across every launcher session of an arm and prints the
   total; it is a measurement, not a gate, and the channel-off arm correctly
   reports none at all.

## Shutdown and reaping — protocol MUST 3

`stdin` `end`/`close`, `SIGTERM` and `SIGINT` all run one path
(`Session.shutdown`):

1. for every live exec, SIGKILL the host-side child — its **process group**
   where the kind detached it;
2. then `await` each kind's `reap(config, handle)` under a **1500 ms** hard
   deadline;
3. `process.exit(0)`.

**1500 ms is chosen against cc's own number.** cc closes our stdin and SIGKILLs
us after `DEFAULT_SHUTDOWN_GRACE_MS = 2000`
(`src/systems/providerConnection.ts`, :75 at the pin). Reaping must finish inside that window
or cc kills us mid-reap and the orphans survive anyway.

`close` on one id takes the same kill-then-reap path for that id alone and emits
**no further frames** for it. It also **cancels an in-flight derived file
operation, and reaps it** — those bodies run detached so one round trip does not
serialise every other id, so dropping the bookkeeping alone would leave the far
side running. §5 is explicit that close means "kill the command (hard)", and cc's
`readFile`/`writeFile` backstop works *by* sending close, so this is the one place
its kill instruction could have been ignored.

**A derived operation is killed BY PROCESS GROUP, and that is not incidental.**
The read script's payload stage is a pipeline (`tail | head | base64 | tr`) whose
members are the shell's *grandchildren*. `child_process`'s `signal` option kills
only the direct pid, which reparents the pipeline to PID 1 still blocked — the
first version of this fix did exactly that, and a full `npm test` left two live
quartets behind. So `run.mjs` spawns `detached: true` and kills `-pid`. A test
that watches only direct children **cannot see this failure**, because killing
the shell moves its children out of a `ppid` query; `tests/launcher-shutdown.test.mjs`
therefore asserts on the whole process group.

A file operation also carries the same `(config, handle)` pair an `exec` does, so
a kind's `reap` is called for it. For docker and ssh that is the difference
between a far-side pipeline being reaped and being abandoned.

**A DETACHED exec is not reaped either, and that is MUST 3's own carve-out.**
A detached command, and anything it backgrounded, is outside the loop above *by
construction* rather than by an exception inside it. The obligation, the
citations and the mechanism that puts it outside are in `docs/protocol.md` →
"`detach` — the frame `close` cannot substitute for". Pinned by
`tests/launcher-shutdown.test.mjs` → *"a detached exec is OUT of MUST 3's exit
reap"*.

**A command that exited on its own is NOT reaped, and that is deliberate.** §5
gives `exit` as a terminal frame with no cleanup obligation attached; MUST 3
binds at *provider exit*, not at operation completion; and cc's own reference
provider behaves identically. Reaping every finished exec would cost a round
trip into the container per command, buying nothing. (Reviewed twice; do not
re-litigate. Fenced by `tests/docker-live.test.mjs` → *"five commands that exit
on their own cost exactly five docker invocations"*.)

**A command WE TERMINATED is reaped — that is the same case, at four sites.**
`reap` exists for the case where the host-side proxy was **killed** while the far
side kept running. `close` and shutdown are two such sites; a **`timeoutMs`
expiry** and a **`signal` frame** are the other two, because
`Session.#terminate` kills the host-side proxy and — measured for `docker` — the
container process keeps running. Without it the launcher emits
`{code:124, timedOut:true}`, cc's own "the provider killed it", for a command
still running in the container. `#terminate` therefore sets `state.terminated`,
and the child's `close` handler reaps when it is set.

**A CHANNEL OP IS REAPED BY ITS OWN TOKEN, AND THE CHANNEL IS NOT.** A channel
op has no host-side child at all — it is a command inside a shell that is already
running — so `#terminate` cannot signal anything and the reap relay *is* its
kill. That works because the token rides as the far-side **command's environment
prefix** (`CC_EXEC_TOKEN=<tok> /bin/sh -c …`), never on the channel's own
`docker exec -e`: measured, the channel shell's `/proc/<pid>/environ` carries
zero tokens, the unmodified `buildReapScript` answers `CCREAP ok` having killed
the op's tree alone, the channel survives, and the reaped op still emits its
sentinel (with `$? = 137`) so its pool slot is reclaimed. A channel-wide token
would instead mean reaping one op killed every other op on that channel, and the
design would be rejected. Pinned by `tests/docker-live.test.mjs` → *"an op on a
shared channel is reaped by its own token, and the channel survives"*.

**The CHANNEL itself needs no token and joins no reap set.** Measured: a shell
blocked on a `docker exec`'s stdin dies with its host client — unlike a *running*
command, which is the whole reason the per-op relay exists — and `shutdown()`
closes stdin, which ends it cleanly. `Session.shutdown()` closes the pool inside
the same 1500 ms window; in-flight channel ops are already covered above by their
own per-op tokens. Pinned by `tests/docker-live.test.mjs` → *"a launcher that
ends leaves no held-open shell in the container"*.

**How `docker` reaps: a token scan, not a pgid.** Every `docker exec` carries
`CC_EXEC_TOKEN=<per-exec nonce>` in the container process's environment; `reap`
sends one bounded `docker exec … /bin/sh -c` that SIGKILLs every process whose
`/proc/<pid>/environ` contains it. Children inherit an environment, so one pass
reaches the whole subtree with **no discovery step**, and it survives a
descendant that called `setsid` — which a group kill does not. It uses only `tr`
and shell built-ins (no `ps`: `node:24-slim` has none), and the reap exec itself
carries no token, so it cannot kill itself. Measured cost **~121 ms** per handle,
run in parallel across handles, comfortably inside the 1500 ms deadline.

**A REAP MUST PROVE IT RAN, and a failed one is REPORTED.** Without `tr`, or on a
target whose `/proc/<pid>/environ` is unreadable, every match simply fails and an
unconditional `exit 0` would report a clean shutdown while the container-side
subtree survived — the MUST-3 hazard made invisible, and `baselineRefusal` gates
exec and fileops but never `reap`. So the script counts the environs it could
read and answers `CCREAP blind` / exit 3 when that count is zero (the scanning
process can always read its own, so zero is unambiguous); `Transport.reap` throws
unless it sees a `CCREAP ok` line; and `Session.#reap` writes that to **stderr**
through the session's `warn` seam instead of swallowing it. It still does not
take the connection down — one target's leftovers are not a dead session. The one
benign failure is the container being gone or stopped, recognised through the
same `classifyFailure` the exec path uses so the two cannot drift.

## The ssh ControlMaster transport

Every measurement behind this section is in
`.wiki/gotchas/ssh-controlmaster-transport.md`; the wire contract is in
`docs/protocol.md`. What lives here is the **design**.

**One OpenSSH ControlMaster per target, and connect state lives in the socket.**
Not in a process and not in memory — which is what lets the launcher and the
backend agree with **no IPC**. It is `src/store.mjs`'s "there is no cache"
argument applied to connection state instead of config, and it has a
user-visible payoff: an `ssh -O exit` issued *outside* this plugin is reflected
on the next card render with nothing restarted, because every `reachability`
re-asks the socket.

**The ControlPath formula**, the one source of truth both processes compute
independently (`kinds/ssh.mjs`):

```
controlPathFor(config) → <os.tmpdir()>/code-system-ssh-<uid>/<sha256(user \0 host)[0..20]>
```

- **Keyed on the resolved connection identity `(user, host)`, not on
  `remoteId`.** Two remoteIds naming the same target share one master — which is
  what "one master per remote" means once the remote is understood as the
  *target* rather than the record. More importantly, editing a remote's `host`
  yields a **different** socket, so a live master is never silently reused
  against a host it was not opened to; the old one expires on `ControlPersist`.
  The separator is a NUL because it is the one byte neither field can contain:
  with a joinable one, `('ab','c')` and `('a','bc')` would collide onto one
  master.
- **A 0700 per-uid directory, not a bare `/tmp` entry.** `/tmp` is
  world-writable and the path is derivable, so another local user could
  pre-create a socket there and have a slave attach *our* commands to *their*
  master. An existing directory with the wrong owner or mode is **refused, not
  repaired** — chmod-ing it would paper over exactly that.
- **It refuses past 100 bytes rather than truncating**, naming `TMPDIR`. Linux
  caps a unix socket path at 107 usable bytes, and a truncated path is a
  *different* socket for the launcher than for the backend — the one thing the
  no-IPC agreement cannot tolerate. Never a fallback to a second formula, which
  would break it invisibly.

**Who carries which `ControlMaster`, and why it is not `auto`.** This is the
design's load-bearing detail, and it was forced by measurement:

| surface | invocation | may do I/O |
|---|---|---|
| `spawnPlan` (every `exec`, every fileops script, the probe) | `-o ControlMaster=no` | **no — pure** |
| `reachability` | `-o ControlMaster=no -O check` | yes |
| `reap` | `-o ControlMaster=no` | yes |
| `disconnect` | `-o ControlMaster=no -O exit` | yes |
| `connect` | `-o ControlMaster=no -O check`, then `-o ControlMaster=yes -N -f` **only if that says no**, then `-O check` again | yes, and it is the **only** one that creates the control directory |

`ControlMaster=no` is not "don't multiplex": it means **use a master if one
exists, never create one**. Measured, it multiplexes onto a live master at zero
further authentications and runs fine with **no directory at all** — whereas
`auto` must *bind*, and with the directory absent it exits 255. Since
`spawnPlan` must stay pure (`kinds/index.mjs`) and the handshake must do no I/O
(`.wiki/gotchas/active-registration.md`), nothing on the exec path may create
that directory — so `auto` would make a first `exec` against a fresh remote
fail. `no` makes the pure path total: it multiplexes when it can and connects
normally when it cannot.

**`connect` is IDEMPOTENT, and the pre-check is the only way it can be.** A
`ControlMaster=yes` over a **live** ControlPath does not fail: ssh prints
`ControlSocket … already exists, disabling multiplexing`, connects normally and
**exits 0**, so the far side authenticates again and the backgrounded `ssh -N`
owns no socket — while the proving `-O check` inspects the *original* master and
reports success. Since nothing after the spawn can undo it, `connect` asks first
and returns without spawning anything when a master already answers. Pressing
Connect on a connected remote therefore costs one 5 s-bounded `-O check` and no
authentication.

**A pre-check that did not COMPLETE is not a "no".** Every non-zero exit
licenses the reclaim below, so a check killed before it answered — which is
exactly how its own 5 s bound arrives, as a group SIGKILL — must be told apart
from one that answered "no master". `runSsh` collapses a signal death to
`code: 1` for its other callers, where reading it as their ordinary negative is
the safe choice; `connect` is the one caller that reads the `signal` and
refuses, leaving the ControlPath untouched.

What the proving check asks changed with it: not "does *a* master answer at this
path" — that is what let a degraded call launder the original's health — but
"did **this call** put one there", as two facts. ssh did not announce the
degrade, and a socket exists now that did not exist a moment ago. The residual
bound is a **concurrent `connect` from another process** binding between the
unlink and the spawn; nothing in `-O check`'s output identifies a master's
owner, so the loser is caught only by ssh's degrade **wording** — good enough
for stock ssh, and what the fixture measures, but not a proof: rewrite that
stderr and the loser reports an unearned success. The orphan it leaves is
**not** bounded by `ControlPersist`, which governs an idle *master*; a degraded
survivor is an ordinary client and lives until its connection drops. Its
lifetime is unmeasured. No in-process lock is taken — connect state lives in the
socket, and a lock would not cover two processes anyway.

**A stale ControlPath is RECLAIMED, not refused.** ssh unlinks its socket on
`-O exit` but not when the master dies, so a SIGKILL or a reboot leaves the file
behind. `connect` unlinks it and opens fresh, and that is the **only** path out:
`disconnect` reads every cold shape as "already disconnected" and clearing stray
files is explicitly not its job. Refusing would leave the remote permanently
unconnectable with no in-product remedy. It is safe because the path is ours and
nothing else's — inside the 0700 directory `ensureControlDir` has just created
or refused — and because the pre-check has just proved nothing is listening.
Three deliberate consequences: **any** non-zero `-O check` counts as "no master"
(the same reading `reachability` gives the same command, so the two cannot
disagree); a check that could not **run at all** is a throw, never a reclaim,
because unlinking then could orphan a healthy master; and a directory at the
ControlPath fails `unlink` with `EISDIR` and is reported with its errno. It also
makes failure self-healing — a `connect` that dies after the spawn leaves a
socket the next one reclaims.

The consequence, stated rather than hidden: **an `exec` never creates the
master.** Without a `connect` every command pays its own authentication and
still works. That is the degradation the transport is designed around, and both
directions are pinned by `tests/ssh-live.test.mjs`.

**`reachability` never connects.** It is `-O check` against the socket, bounded
at 5 s, mirroring docker's "a daemon query, never a round trip INTO the target,
because this runs on every card render". Its `fingerprint` is
`ssh:<identity-hash>:<socket ino>:<socket ctimeMs>` — the recipe already locked
in `.wiki/gotchas/baseline-probe-two-tier.md`, and a new master means a new
socket means a new inode, which is exactly what makes `needsProbe` re-probe —
qualified by the idempotence above: a connect that **reused** a master moves no
inode, so the re-probe after it is correctly a cache hit rather than a repeat of
work whose answer cannot have changed. It
is `null` on every non-connected answer, including "`-O check` said yes but the
socket cannot be stat-ed": a fingerprint keyed on nothing would cache a verdict
we cannot justify. `detail` names the ControlPath verbatim, which is what makes
an out-of-band `ssh -O exit -o ControlPath=<that>` issuable by an operator.

**The master deliberately SURVIVES launcher shutdown.** Shutdown SIGKILLs the
launcher's ssh slaves — they are OS descendants, so `Session.shutdown`'s existing
kill reaches them — and leaves the master running. That is the point of state
living in the socket: cc restarts launchers, and tearing the connection down on
every restart would make the multiplexing worthless. `ControlPersist=600` is
what stops a master orphaned by a crashed launcher living for ever. `reap` still
has work to do, because killing the local slave does **not** kill the remote
command (measured).

**How `ssh` reaps: the same token scan `docker` uses.** Extracted to
`kinds/reapscript.mjs` when this kind landed — identical mechanism, identical
reason (a far-side child is not the client's OS descendant), so it is shared
rather than copied. The relay runs `/bin/sh -c <script>` over a new slave
bounded at 1200 ms, carries **no** token in its own environment so it cannot
kill itself, and must answer `CCREAP ok` or `Transport.reap` throws. Its one
benign failure — the host being unreachable — is recognised through the same
`classifyFailure` the exec path uses, so the two cannot drift.

## Test patterns

`npm test` is deterministic and needs no docker, no ssh and no network. Every
test gets its own `fs.mkdtemp` store via `CODE_SYSTEM_STORE`; nothing shares a
global.

- **Drive the real launcher over pipes** (`tests/helpers.mjs` → `Launcher`),
  holding stdin open — cc does, and without it MUST 3 fires before an async
  operation can answer.
- **Inject a fake kind** with `--kind fake` + `CODE_SYSTEM_FAKE_TRANSPORT`
  (`tests/fakeTransport.mjs`). It reaches the local machine like `host` does;
  what makes it a fake is that it **records its `reap` calls** to a file, which
  is how MUST 3 is asserted for a kind whose children are not our OS
  descendants.
- **Barrier, not sleep.** Frames are handled in arrival order, so a short `exec`
  whose `exit` you await proves the earlier frames were processed.

  That ordering comes from a promise chain in `Session.deliver`, and its cost was
  **measured, not assumed**: only the routing-and-registration phase is
  serialised, so the chain is at most one frame deep in flight, and both file-op
  bodies run detached (MUST 4 is honoured). A review additionally failed to break
  it with 20 000 frames queued at EOF. It is needed because resolving a remote is
  an `await` and a follow-on frame — a `signal` for an id — can arrive in the
  same chunk as the `exec` that opened it; without the chain that follow-on
  frame is processed first and dropped as unknown.
- **A grandchild under test redirects its own stdout to `/dev/null`**, or it
  holds the command's pipes open after the direct child dies and the `exit`
  frame never arrives. cc's own suite does the same
  (`systems-protocol-conformance.test.mjs` → "process-group signalling").
- **Scripted fake cc** (`tests/helpers.mjs` → `fakeConductor`) for registration,
  asserted on the recorded request log, never on timing.
- **Real docker, self-skipping** (`tests/dockerFixture.mjs`,
  `tests/docker-live.test.mjs`). Every such test calls `skipUnlessDocker(t)` and
  returns, so `npm test` stays green with no daemon and each skip prints a reason
  naming both invocations tried and `CODE_SYSTEM_DOCKER`.

  **`candidates()` TRIES TWO INVOCATIONS: the `CODE_SYSTEM_DOCKER` one (default
  `["docker"]`), then `["sudo","-n","docker"]` as a fallback.** That fallback is
  deliberate — it is what lets the live suites run on a host whose docker socket
  is root-owned — but it means **a green live run does not tell you which
  invocation answered**, and in particular is not evidence that bare `docker`
  reaches the daemon. Anything asserted about a host has to name the invocation
  and show it (`resolveDockerCli()` reports the resolved argv), and a gate claim
  needs both arms by count: the roster running with the gate open, and the same
  roster skipping with `docker` and `sudo` off `PATH`.

  **The gate is a daemon probe, not a `which`**: `docker version --format '{{.Server.Version}}'`, because
  a host can have the CLI installed and the socket unreadable — measured here,
  unprivileged `docker version` prints its whole Client block to stdout and exits
  1. That distinction is itself pinned, docker-free, in
  `tests/dockerkind.test.mjs`.
- **Shared stub CLIs** (`tests/helpers.mjs` → `stubDockerCli` / `stubSshCli`) —
  a real executable on disk that logs its argv one element per line and answers
  on a branch of what it was asked, so the **real** spawn path (argv, exit code,
  stream separation) is part of what is under test. `argv()` answers `[]` when
  the stub was never run at all, which is what makes "zero invocations"
  assertable. They live in `helpers.mjs` because the kind suites and the API
  suite all drive them; a second copy would be a second place for the argv
  contract to drift.
- **The answers-file stub mode** (`answers: {...}` on either stub) models an
  **out-of-band change** deterministically: the reachability branch reads its
  stdout/stderr/exit from files a test rewrites BETWEEN two calls to the same
  server. That is the only way to model `docker stop` / `ssh -O exit` happening
  behind the plugin's back without a daemon, and it is what proves the probe
  re-asks rather than serving a cached verdict.
- **A DOM stub for the frontend** (`tests/render.test.mjs`) — about 60 lines,
  no layout and no CSS. It exists because `cardState.mjs` covers every
  *decision* but leaves `app.js` with no *execution* coverage, and a
  ReferenceError in `card()` is a blank page nothing else here would catch. It
  answers one question: does the render path run, and does what it produces
  carry both states.
- **In-container assertions read `/proc`, never `ps`** — `node:24-slim` has no
  `ps`. The marker being counted is passed to the scanning shell **in its
  environment**, so the scanner's own `/proc/<pid>/cmdline` cannot match and
  count itself.
- **A counting CLI shim** (`countingShim`) — an executable that logs its argv and
  then `exec`s the real docker CLI. It is how "a natural exit costs exactly one
  docker invocation" and "the overridden argv is really what runs" are asserted;
  no pure test can show either.
- **A NEGATIVE CONTROL for every relay test.** `tests/docker-live.test.mjs` first
  proves that SIGKILLing a `docker exec` host client leaves the container process
  running. Without it, every reap assertion would pass even if `reap` did
  nothing — a kind whose children die with their proxy needs no relay at all.
- **A real sshd, self-skipping, with the roster proved to have RUN**
  (`tests/sshFixture.mjs`, `tests/ssh-live.test.mjs`,
  `tests/fixtures/sshbox/Dockerfile`). Five things about it are deliberate:
  - **The gate is composed of two probes** — a Docker daemon (to host the sshd)
    *and* a runnable `ssh`. Either missing skips. Note `ssh -V` writes its
    banner to **stderr**: a stdout-only probe would skip on a machine with a
    perfectly good client.
  - **The roster is proved in BOTH directions by count.** Live tests are
    registered from a module-level roster, each incrementing a counter, and a
    final test (which never skips itself) asserts `ran === roster.length` when
    the gate is open and `ran === 0` with a **non-empty** roster when it is
    closed. This is the gap the docker suite states outright that it leaves: a
    live suite that silently skips everything while `npm test` stays green is
    indistinguishable from one that passes.
  - **The image is built in-tree with NO build context** (`docker build -`, the
    Dockerfile on stdin). It is `debian:13-slim`, not Alpine: busybox fails our tooling
    baseline in four capabilities, which would gate `fileops` off and make the
    live suite vacuous — so one test asserts the image *passes* the baseline.
  - **A throwaway keypair per target, and the operator's agent is walled off.**
    An agent with real keys is forwarded into this environment, so every
    generated `ssh_config` sets `IdentitiesOnly yes` and `IdentityAgent none`.
    The target's host key is read **out of band** with `docker exec` into a real
    `known_hosts`: no trust-on-first-use anywhere, in the fixture or the
    provider. The fixture also deliberately does **not** set
    `StrictHostKeyChecking`, because the provider's policy rests on OpenSSH's
    default — pinning it would test the fixture instead of the policy.
  - **Aliases are unique per target.** `controlPathFor` keys on `(user, host)`,
    so two targets sharing an alias would share one master and a test could
    silently multiplex onto the previous test's container.
- **Multiplexing is asserted on sshd's OWN authentication count**, never on "the
  command worked" — which is what an unmultiplexed run also looks like. The
  target runs `sshd -D -e`, so `docker logs` carries one `Accepted publickey`
  per real connection, and the test includes the unmultiplexed **control**
  (`ControlPath=none` → one authentication each) so the flat count is a
  measurement rather than a fixture that cannot tell the difference.
- **Real `/bin/sh` for the far-side scripts.** `tests/fileops.test.mjs` runs the
  generated scripts against a real shell on a temp dir — deterministic and
  local, and the only thing that proves the *scripts* are right rather than just
  the host-side parse.
- **A local `/bin/sh` as the CHANNEL, for the same reason.**
  `tests/channel.test.mjs` drives the real `ChannelPool` against a `channelPlan`
  of `{file:'/bin/sh', args:[]}` — which is exactly what
  `docker exec -i <container> /bin/sh` hands it, minus the container. So the
  whole framing (both sentinels, the ready marker, the byte count, the exit-code
  capture, the idle watchdog) is covered with no docker. Two fixtures do the
  work a seam would otherwise need: `kill -9 $PPID` inside an op kills the
  channel shell out from under itself, reproducing a container-side death with
  no test-only method on the pool; and a blocking op with no output reproduces a
  framing desync. `CODE_SYSTEM_FAKE_CHANNEL=1` gives `--kind fake` the same
  plan, so the launcher's wiring and its two diagnostic lines are drivable end
  to end (`tests/channel-observability.test.mjs`).

### The gated conformance run

```sh
CC_CHECKOUT=/path/to/code-conductor npm run conformance
```

Runs cc's own `tests/systems-protocol-conformance.test.mjs` against
`--kind host`, with **no test edits** — editing that suite is how a provider
fakes conformance. It skips cleanly when `CC_CHECKOUT` is unset, so `npm test`
needs nothing but Node.

**It runs `tests/protocol-constants.test.mjs` first**, with `CC_CHECKOUT` in its
environment, and aborts before launching the battery if that fails. That test's
gated half parses cc's `src/systems/protocol.ts` and catches constant drift; it
had been skipping silently since it was written, because nothing in `npm test`
sets the variable — which is how a stale `EBUSY` outlived cc removing it. The
claim itself now also lives in the file's **ungated** test as a literal
`deepEqual`, so a re-added or reordered code reds a plain `npm test` with no
checkout at all, and the gated test is pure drift detection.

```sh
CC_CHECKOUT=/path/to/code-conductor \
  CODE_SYSTEM_DOCKER='["sudo","-n","docker"]' npm run conformance:docker
```

The **bound** run: the same battery, unedited, against `--kind docker` over a
container that shares this process's filesystem.

**It runs TWICE, once per channel arm.** The script re-spawns *itself* with
`CODE_SYSTEM_CHANNEL=1` and then `=0` — a separate process per arm, which
sidesteps its module-scope singletons (`suiteRun`, `cleanups`, the memoised
`teardownRun`, `resolveDockerCli`'s memo) rather than resetting them. **Both arms
compare to the one manifest** in `tests/boundConformanceExpectations.mjs`: the
invariant is that the held-open channel changes no observable outcome, so any
divergence between the arms is a failure and the off arm is today's behaviour
unchanged. `npm run conformance` (host kind) is unaffected — `host` offers no
channel.

Four inputs, all required:
`CC_CHECKOUT` (a clone of the pin), a reachable daemon, `CODE_SYSTEM_DOCKER`
naming the invocation explicitly, and a writable `<repo>/.conformance-tmp`
inside a host bind. It skips cleanly and loudly without the first two, and it is
**never part of `npm test`**. It seeds its own store and remote and removes both.

**What it proves:** of the 63 rows, **41 reach the shipped `docker` transport and
pass** under the battery's own fixtures. (48 pass in total; 7 of those exercise no
provider of ours. Three further rows reach the transport and FAIL on its
behaviour — buckets 3 and 4 below — so 44 reach it at all.)

**And what the channel carried while doing it**, from the run's own census: 114
of 139 admitted ops on ~25 channels across 46 launcher sessions, with no
admission-drift alarm. The channel-off arm reports no census and produces the
same 63-row outcome table.

**The 15 rows that do not pass, in four buckets:**

1. **4 skips**, the `IS_REFERENCE_PROVIDER` set every third-party run skips.
2. **8 structural failures** — the two capability rows and the six flag rows
   above, whose causes are in the section that names them. These are the price of
   decisions this tree has locked.
3. **2 DEFECT failures**, and they are not a structural limit: both
   `exec NEVER rejects — a command that cannot start is a spawnError, not a
   throw` rows, which the bound run FOUND (card 2026-0016) and `host` cannot
   reach. They go away when that card lands.
4. **1 close-reach failure**: `[processGroupSignal:false] detach ends the
   operation and kills nothing; close kills as far as it reaches`. Its `detach`
   half passes; `#close`'s far-side reap is subtree-wide while the advertised
   `processGroupSignal: false` promises it is not (card 2026-0019). Measured
   unsatisfiable in both capability configurations — see
   `.wiki/gotchas/bound-conformance.md`.

All four are enforced by `tests/boundConformanceExpectations.mjs` — anything not
listed there must pass, a listed row that starts passing is red, and the run's
total is pinned absolutely so a row vanishing from the suite is red too. A
**fourth** guard reads a surface cc never shows: the launcher's own stderr, where
an admission-drift alarm reds the arm.
