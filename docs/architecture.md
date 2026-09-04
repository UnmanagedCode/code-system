# Architecture

Internals: the two processes, the seam a provider kind plugs into, the on-disk
store and its migration, the shutdown contract, and the test patterns.

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
| `src/launcher/kinds/` | one file per kind, plus the registry |

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
all. **`docker` does not, and card 2026-0004 must not, treat it as a containment
primitive.**

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
no root fencing, and card 2026-0004 must not either.** Our
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

### The consequence for cards 2026-0003 and 2026-0004

`docker` and `ssh` always advertise `remotes:true`. Since cc `8b7b10bf` that no
longer bars them from the battery: `CC_CONFORMANCE_REMOTE_ID` binds every
fixture handle to one named target, and the third-party capability assertion
tolerates `remotes`/`remoteDescriptors` as a **superset**. **A bound run against
the real `docker` kind is therefore supported and worth doing** — it measures
the shipped kind rather than a generalisation from `host`. What it needs is a
container that shares the test process's filesystem (a bind mount), which is rig
territory and **stays with card 2026-0006**: card 2026-0003 landed the transport,
not the bound conformance rig.

Until then, the seam is what carries the argument: `protocol.mjs`, `session.mjs`
and `fileops.mjs` are kind-agnostic and `spawnPlan` is pure, so **`host` passing
the core suite proves the core for every kind.** The per-kind residue is argv
construction, `reap` and `classifyFailure` — covered for `docker` by unit tests
on the pure `spawnPlan` plus `tests/docker-live.test.mjs` against a real
container.

**Run cc's suite against a CLONE of the pin, never against a live cc worktree.**
`tests/conformance.mjs` runs cc's own test runner with `cwd: <checkout>`, so
`CC_CHECKOUT` must not point at a checkout somebody else is working in:

```sh
git clone --no-hardlinks <cc-checkout> /tmp/cc-pin && git -C /tmp/cc-pin checkout <pin>
ln -s <cc-checkout>/node_modules /tmp/cc-pin/node_modules   # or: npm ci in the clone
CC_CHECKOUT=/tmp/cc-pin npm run conformance
```

**Do not add a flag to docker or ssh to fake `remotes:false`.** That would be a
test-only divergence in the one field cc negotiates on, and cc's own harness
says so (`referenceProviderHarness.mjs`, the `assertNegotiatedCapabilities`
note). It is also unnecessary — a bound run needs no such lie.

**Two obligations that land on those cards specifically:**

1. **Every config field that becomes an argv operand must reject a leading `-`**
   (`src/launcher/kinds/config.mjs`). `container`, `host` and `user` already do,
   and `docker`'s `spawnPlan` now really does place `container` after `--`.
   A leading dash turns an operand into an option — `container: "-v /:/host"` is
   argument injection against `docker` — and the refusal belongs in
   `validateConfig`, not in `spawnPlan`, so a bad value never reaches the store.
2. **`exclusive`'s atomicity depends on the TARGET's shell honouring `set -C`.**
   Our canary only measures cc's own `/bin/sh`. A target whose shell ignores
   noclobber silently converts an exclusive write into a truncating one, and
   nothing shipped today detects it — see `docs/protocol.md` →
   "What `exclusive` does and does not guarantee".

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

**"Read fresh per operation" is achieved by having no cache at all.**
`readRemote` is `readFile` + `JSON.parse` on every call, with no memoisation and
no `fs.watch`. That absence is the mechanism: the launcher holds no remote state
between frames, so there is nothing for the backend to invalidate. Pinned by
`tests/store.test.mjs` → *"there is no cache"*.

**Writes are backend-only and atomic**: a unique temp beside the target
(`<id>.json.<pid>.<seq>.tmp`), `fsync`, `rename` over, unlink on any failure.

### The environment seams

Every variable this plugin reads, in one place. All are **operator-set**: cc
spawns the launcher with the *orchestrator's* environment, and the backend reads
the same names in-process, so one function serves both surfaces.

| Variable | Read by | Effect |
|---|---|---|
| `CODE_SYSTEM_STORE` | `src/paths.mjs` | store root; else `<homedir>/.code-system`. Test isolation |
| `CODE_SYSTEM_DOCKER` | `kinds/docker.mjs` → `dockerCliArgv` | the **whole docker invocation** as a JSON array, e.g. `["sudo","-n","docker"]`. Default `["docker"]` — no `sudo` in the shipped default. Malformed → throws → launcher exit 2 before any frame |
| `CODE_SYSTEM_ALLOW_HOST_KIND` | `kinds/host.mjs` | permits `--kind host` at all |
| `CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED` | `kinds/host.mjs` | permits `--kind host` with no `--remote` fence. **No shipped path sets it** |
| `CODE_SYSTEM_FAKE_TRANSPORT` | `main.mjs` | module path for `--kind fake`. Tests only |
| `CC_CHECKOUT` | `tests/conformance.mjs` | gates the conformance run |

**Why the docker CLI is an env var rather than a store field or a launch flag.**
A store field would be an **HTTP-writable executable argv** on cc's host — the
REST surface writes remote records, so a card-UI field taking an argv is remote
code execution by design, and `kinds/config.mjs` can keep a stored value from
becoming an *option* but not from becoming an *executable*. A launch flag would
have to get its value from somewhere anyway and changing it would force
re-registration, because `src/registration.mjs` makes the launch argv a function
of **(install path, kind) only** — which is what holds cc's connection cache
while remotes come and go.

### Migration

`src/migrate.mjs` runs once at backend start, before anything serves. Schema 1
is the first schema, so its only job today is to **quarantine** a record the
current readers cannot understand — moved aside, never deleted. Its
"already applied" self-check is the store's own contents, so it needs no marker
file. When schema 2 arrives, its upgrade goes here and nowhere else:
application code assumes the current format only.

A launcher that meets a record at another schema refuses **that remote** with
`ENOREMOTE`, quoting the schema it found and naming the backend as the repair.
It does not attempt a read-time upgrade and it does not fail the connection — a
launcher can legitimately be spawned before the backend has ever run.

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
  naming both invocations tried and `CODE_SYSTEM_DOCKER`. **The gate is a daemon
  probe, not a `which`**: `docker version --format '{{.Server.Version}}'`, because
  a host can have the CLI installed and the socket unreadable — measured here,
  unprivileged `docker version` prints its whole Client block to stdout and exits
  1. That distinction is itself pinned, docker-free, in
  `tests/dockerkind.test.mjs`.
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
- **Real `/bin/sh` for the far-side scripts.** `tests/fileops.test.mjs` runs the
  generated scripts against a real shell on a temp dir — deterministic and
  local, and the only thing that proves the *scripts* are right rather than just
  the host-side parse.

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
