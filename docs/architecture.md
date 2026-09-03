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

## The `host` kind

`kinds/host.mjs` execs directly on cc's own machine. It is **not** one of
`REGISTERED_KINDS` and never gets a cc System row.

**Why it exists, and why deleting it is expensive.** cc's conformance suite
*is* the definition of a valid provider, and it "builds its fixtures with node's
own `fs` and then asks the provider about them, so it verifies a provider that
reaches **the same filesystem as the test process**"
(the third-party NOTE in `tests/referenceProviderHarness.mjs`). A docker or ssh target does not
share that filesystem. **Nothing but a host kind can run cc's suite against this
code**, so removing it removes the only check on the frame loop, the routing,
`fileops.mjs` and the shutdown path. It is exercised by a real caller —
`npm run conformance` — which is the YAGNI bar.

**The guard, and a DEVIATION FROM THE PLAN.** "We never register it" is not a
fence: a row registered by hand with `--kind host` is an unfenced arbitrary-exec
provider on cc's own machine, reachable by any project pointed at it. cc gates
its own equivalent (`CC_LOCAL_SYSTEM_PROVIDER`) behind an env var for the same
reason (`CC_LOCAL_SYSTEM_PROVIDER` in `src/systems/registry.ts`).

The plan required **two** conditions: an env seam **and** at least one mandatory
`--remote <id>=<absolute root>` fence. **The mandatory fence is unimplementable
as written**, and this is the reason: cc's three core `CAPABILITY_CONFIGS` pass
no flags at all, so a `host` that refused without a fence makes **62 of the
suite's 65 tests unrunnable** — and running that suite is the only reason the
kind exists.

What ships is two seams that split along the *risk* instead:

| Launch | Needs |
|---|---|
| `--kind host --remote a=/some/root` | `CODE_SYSTEM_ALLOW_HOST_KIND=1` |
| `--kind host` (serves unfenced) | that **plus** `CODE_SYSTEM_ALLOW_HOST_KIND_UNFENCED=1` |

Only `tests/conformance.mjs` sets the second one. So a hand-registered row now
needs someone to have deliberately exported a variable **with `UNFENCED` in its
name** into the orchestrator's environment, rather than merely the general test
var — which is most of what the plan's mandatory fence was buying.

**Residual risk, stated rather than implied.** With both variables exported into
the orchestrator, a hand-registered `host` row still serves arbitrary exec on
cc's machine. Neither seam is a capability check; they are speed bumps that make
the dangerous configuration require a deliberate, self-describing act. The real
protection is that `host` is absent from `REGISTERED_KINDS`, so nothing this
plugin does ever creates such a row.

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
all. **Cards 2026-0003 and 2026-0004 must not treat it as a containment
primitive.**

**Its capabilities are DERIVED FROM ITS FLAGS, and that is load-bearing.**

| Capability | `host` |
|---|---|
| `persistentShell` | `true` unless `--no-persistent-shell` |
| `processGroupSignal` | `true` unless `--no-process-group-signal` |
| `remotes` | at least one `--remote` given |
| `remoteDescriptors` | at least one `--mirror` or `--exclude` given |

This is the shape cc's own reference provider uses (`remotes:
this.#opts.remotes.size > 0`, the hello capabilities block in
`referenceProvider.ts`), and the suite's assertion message states the intent:
*"the flags the provider was launched with are what it advertises"*. It is what makes the suite runnable at all — its three
core `CAPABILITY_CONFIGS` pass **no** flags and **deep-equal**
`{persistentShell:true, processGroupSignal:true, remotes:false,
remoteDescriptors:false}` (with two of them lowering one flag), while
`withRemotes` and the two mirror tests pass `--remote`/`--mirror` and require
the opposite. A kind that hardcoded any of these four would fail the deep-equal
and lose most of the suite.

`host` keeps `persistentShell` for exactly this reason, even though `docker` and
`ssh` drop it permanently — **do not "fix" that inconsistency.** Two of the three
core configurations deep-equal `persistentShell: true`
(`CAPABILITY_CONFIGS` in `tests/referenceProviderHarness.mjs`), and losing them would cost most of the
exec-lifecycle, fileops, derivation and error-taxonomy coverage, none of which
is about shells. It costs nothing: a host exec already holds its child's stdin
open.

### What cc's conformance suite demands beyond `systems-protocol.md`

The `PROVIDER_ARGV_ENV` note in `tests/referenceProviderHarness.mjs` says the suite appends "exactly the two
`--no-*` flags and nothing else" and that "nothing in the suite is otherwise
specific to the reference provider". Neither is true as written. A provider
being verified must also accept `--remote <id>=<abs root>` (its `withRemotes` fixture),
`--mirror` and `--exclude` (its two `describeRemote` tests), **fence** each
remote to its root with `cwd:"/"` exempt, and **inject `CC_REMOTE`** into the
remote command's environment ("a bound handle names its remote on exec,
readFile and writeFile"). Those facts are documented — in cc's
`docs/architecture.md`, Component layout → `referenceProvider.ts` — just not in the doc a provider author is told is
complete on its own. Filed as code-conductor card **2026-0313**.

### The consequence for cards 2026-0003 and 2026-0004

**`docker` and `ssh` always advertise `remotes:true`, and can therefore NEVER
pass the suite's three core configurations.** That is not a defect in them and
is not something to chase or work around. A capability derived from store
contents would flap as remotes were added, and cc memoises the handshake per
connection generation, so it would be memoised wrong.

What makes that acceptable is the seam: `protocol.mjs`, `session.mjs` and
`fileops.mjs` are kind-agnostic and `spawnPlan` is pure, so **`host` passing the
core suite proves the core for every kind.** The per-kind residue is only argv
construction and `reap` — covered by unit tests on the pure `spawnPlan` plus the
live `code-system-test` rig. docker and ssh get the `withRemotes`/mirror subset,
not the core.

**Do not add a flag to docker or ssh to fake `remotes:false`.** That would be a
test-only divergence in the one field cc negotiates on.

**Two obligations that land on those cards specifically:**

1. **Every config field that becomes an argv operand must reject a leading `-`**
   (`src/launcher/kinds/config.mjs`). `container`, `host` and `user` already do.
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
`CODE_SYSTEM_STORE` exists for test isolation and is the only env seam this
plugin adds beyond the `host` guard.

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
(`src/systems/providerConnection.ts:75`). Reaping must finish inside that window
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
provider behaves identically. `reap` exists for the case where the host-side
proxy was **killed** while the far side kept running — `close` and shutdown.
Reaping every finished exec would cost a round trip into the container per
command, buying nothing. (Reviewed twice; do not re-litigate.)

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
  an `await` and a `stdin` frame can arrive in the same chunk as the `exec` that
  opened its id — without the chain that follow-on frame is processed first and
  dropped as unknown.
- **A grandchild under test redirects its own stdout to `/dev/null`**, or it
  holds the command's pipes open after the direct child dies and the `exit`
  frame never arrives. cc's own suite does the same
  (`systems-protocol-conformance.test.mjs` → "process-group signalling").
- **Scripted fake cc** (`tests/helpers.mjs` → `fakeConductor`) for registration,
  asserted on the recorded request log, never on timing.
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
needs nothing but Node. `tests/protocol-constants.test.mjs` uses the same gate
to parse cc's `src/systems/protocol.ts` and catch constant drift.
