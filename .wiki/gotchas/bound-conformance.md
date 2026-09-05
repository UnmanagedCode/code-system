# The bound conformance run: what it measures, and what it does not

**What:** `npm run conformance:docker` (`tests/conformance-docker.mjs`) runs cc's
conformance battery with `CC_CONFORMANCE_REMOTE_ID` bound to a real container
served by the **shipped `docker` kind**. `npm run conformance` runs the same
battery on `host`; that it carries every other kind is a *seam* argument
(`protocol.mjs`, `session.mjs` and `fileops.mjs` are kind-agnostic and
`spawnPlan` is pure). This run **measures the per-kind residue** instead of
generalising to it. Design in `docs/architecture.md` → "The bound conformance
run"; every number below was **re-measured on 2026-09-05** against cc `52701bc6`
(worktree `code-conductor_worktree_systems`), daemon `dell-work` server 29.7.2,
`sudo -n docker`, after card 2026-0018 implemented the `detach` frame.

## The outcome, and the coverage it buys

The battery is **55 test executions** (19 in-loop × 2 `CAPABILITY_CONFIGS` + 17
out-of-loop). A bound `docker` run:

| | count |
|---|---|
| pass | **40** |
| fail | **11** — 2 capability, 6 flag, 2 a real defect (below), 1 close's reap reach (card 2026-0019) |
| skip | **4** — exactly the `IS_REFERENCE_PROVIDER` set in [host-kind-and-conformance.md](host-kind-and-conformance.md) |

> **THE 2026-09-05 DRIFT, AND HOW IT WAS RESOLVED (card 2026-0018).**
> The battery grew **51 → 55** in cc `c4e72feb`, which added two rows inside the
> `CAPABILITY_CONFIGS` loop (2 × 2 = 4 executions). One was then **renamed** in
> `a9d02508` — "…in every configuration" → "…in both capability configurations"
> — so a manifest pinned to the older spelling matches **zero** rows and reports
> a `row-missing`, not a failure. Check the spelling before the cause.
>
> The rows were **implemented, not listed**, for three reasons worth keeping:
> `detach` is obliged by MUST 5 (`systems-protocol.md:59-64`) and §5 (`:374-388`)
> and is deliberately absent from §2's capability table, so no flag turns it off;
> `tests/conformance.mjs` has **no manifest at all** — it exits with cc's own
> exit code — so the `host` gate could not have been rescued by one anyway; and
> the manifest requires a cause that makes an outcome *forced*, which a missing
> ~30-line frame handler in the file that already owned `close` is not.
>
> **THE PLAN'S PREMISE — "root cause is single, all four rows are the same
> missing frame handler" — WAS FALSE FOR ONE ROW, and the next reader will
> re-reach that conclusion unless they know.** Three rows were the missing
> handler and went green with it. The fourth,
> `[processGroupSignal:false] detach ends the operation and kills nothing; close
> kills as far as it reaches`, only *appeared* to be: its detach assertions come
> first, so they masked a second, unrelated failure in its **`close`** half
> (`systems-protocol-conformance.test.mjs:259`, "without group reach close cannot
> get to it either"). That one is the capability-vs-reap-reach mismatch now
> listed in the manifest and carded as **2026-0019**. Measured both ways in full
> bound runs: with `#close`'s reap `[all capabilities]` passes and this row
> fails; without it, exactly the reverse; **40/11/4 either way**. An earlier
> assertion in a row can hide a later one — a row's *name* is not its cause.
>
> **THE DURABLE GOTCHA: a green row under one capability config can be luck, and
> the bound run is what says which.** Before the fix,
> `[processGroupSignal:false] a redirected background job outlives its command`
> passed on `host` and failed on `docker`. Not a discrepancy: on `host` with
> `processGroupSignal:false` the plan is not `detached`, so the expired
> deadline's `#terminate` reached only the direct `bash` and the backgrounded job
> survived *by accident* — and `host`'s `reap` is a no-op. The same row failed on
> `docker` because `state.terminated` → `#reap`'s `CC_EXEC_TOKEN` scan does reach
> it. The green was an accident of the kind, not conformance.
>
> Pre-existing at `0e3c81c` and unrelated to the mirror work.

**"35 rows exercise the transport" means 35 rows REACH IT AND PASS**, and the
definition matters: of the 40 passes, **5 exercise no provider of ours**, leaving
40 − 5 = **35**. Those five are PASSES, and naming them beats describing them —
one of the skips is easy to mistake for a sixth:

1. `parseFindLines refuses a malformed entry rather than skipping it`
2. `an unrecognised field on a remoteDescriptor is ignored, not an error` — drives
   cc's own `mirrorFixtureProvider.mjs`
3. `an empty or blank CC_CONFORMANCE_REMOTE_ID is unbound, never bound to a nonsense target`
4. `a bound run is refused at the handshake unless the provider serves that target`
5. `the third-party capability assertion tolerates a superset but pins the toggle`

**Not among them:** `CC_CONFORMANCE_REMOTE_ID binds the fixture handle, and an
explicit remoteId still wins` is a **skip**, already counted in the skip bucket —
subtracting it here would double-count it.

Three further rows REACH the transport and fail on its BEHAVIOUR — the two
defect rows below, and the `close`-reach row (card 2026-0019) — so **38 reach it
at all**. The two `[all capabilities]` capability rows reach it too and are
deliberately NOT counted: they fail on the advertisement, not on anything the
transport did. Before this gate either number was zero. `host` reaches and passes
**46** by the same subtraction (51 pass / 0 fail / 4 skip of 55).

Wall clock **15.5 – 21.6 s** across three runs on one machine (15 529 / 21 509 /
21 569 ms), against cc's 90 000 ms per-file hang guard and its 60 s per-test
`--test-timeout` — a **4.2 – 5.8x** margin, printed on every run. **The spread is
the point: do not pin a single figure here**, and read the margin the runner
prints rather than this line.
**`CC_TEST_FILE_KILL_MS` is never set**: raising a guard pre-emptively is how a
slow run becomes invisible. The runner warns instead, above 60 000 ms.

Watch item, measured green: `concurrent execs are multiplexed by id and never mix
their output` asserts five parallel 250 ms commands finish inside 1000 ms. A
`sudo -n docker exec` round trip is **107 ms** (10 samples, 1074 ms total).

## Filesystem identity — the blocker, and how it is obtained

cc's suite **builds its fixtures with node's own `fs` and then asks the provider
about them**, so the far side must reach the test process's own filesystem at
byte-identical absolute paths. Two facts make that obtainable, and the runner
**measures both rather than assuming them** (`tests/boundConformanceFixture.mjs`).

**1. The fixture roots are `os.tmpdir()`, and `TMPDIR` redirects them.** Every
root in cc's suite is `fs.mkdtemp(path.join(os.tmpdir(), …))`
(`tests/systems-protocol-conformance.test.mjs:58, 399, 435, 561, 593, 616`, plus
`os.tmpdir()`-rooted paths at `:646, :648, :677`). `TMPDIR` is **node's own
variable**, not an invented cc seam:

```
node -e 'console.log(require("os").tmpdir())'              → /tmp
TMPDIR=/workspaces/cc-projects node -e '…'                 → /workspaces/cc-projects
```

The non-obvious part is that it survives **cc's own run isolation**:
`tests/safeStoreRoot.mjs` computes `REAL_TMP = realpathSync(os.tmpdir())` **at
import**, so `createSafeRoot()`'s `cc-testrun-XXXXXX` is minted as a direct child
of the redirected `TMPDIR` and `assertSafeTestRunRoot` passes.
`assertStoreIsolated` compares against `<checkout>/..`, which is `/tmp` for a
clone at `/tmp/cc-pin` — nowhere near the scratch.

**2. A `-v` SOURCE PATH IS RESOLVED BY THE DAEMON, ON THE HOST** — never inside
this container. This is the correction to a claim `docs/architecture.md` used to
make ("bind mounts are unavailable from this container at all"), which is
**false**: `/workspaces/cc-projects` is a host bind of
`/home/user/Desktop/cc-projects` on the same daemon and binds fine. The true
constraint is narrower and is what a reader must act on: only paths that exist
*on the host* are bindable. `/tmp` in this container is its **own overlay**,
appearing in no `docker inspect .Mounts` entry, so a sibling container cannot see
it at any path. The repo is inside a host bind, so the scratch lives at
`<repo>/.conformance-tmp` (gitignored) and the runner translates it.

The translation is **cross-checked, and a disagreement refuses the run**:

| Fact | How | Measured value |
|---|---|---|
| self container id | `/proc/self/mountinfo`'s `/docker/containers/<id>/` entry | `f02ff8929f36…b168` |
| the bind | `docker inspect <self> --format '{{json .Mounts}}'` | `Source=/home/user/Desktop/cc-projects` for `Destination=/workspaces/cc-projects` |
| the witness | `/proc/self/mountinfo` field 4 (the mount's host-side root) | `/home/user/Desktop/cc-projects`, ext4 `/dev/nvme0n1p3` — **agrees** |

`/proc/self/mountinfo` beats `/etc/hostname` for the id: hostname is only the
short id, and only until somebody passes `--hostname`.

## `--user` is LOAD-BEARING, not hygiene

The suite's `readFile reports absence, a directory, and an unreadable file` row
chmods a file to `000` and requires `EACCES`. Its own guard is
`process.getuid() !== 0` on the **test** process — uid 1000 here — so the row
**always runs**. Measured against the same file:

```
docker exec …            cat unreadable.txt  → Permission denied, rc=1   (uid 1000)
docker exec -u 0:0 …     cat unreadable.txt  → secret,           rc=0   (root)
```

A default `node:24-slim` container runs as **root**, so without
`--user <uid>:<gid>` that row fails. The runner takes the pair from
`process.getuid()/getgid()`, never the literal `1000`, and refuses the run if
`docker exec id -u` disagrees.

## Fidelity measurements the derived operations depend on

| Question | Measured |
|---|---|
| `mkdtemp` vs `realpath`, host side | identical — no symlink component under `/workspaces/cc-projects` |
| path-prefix agreement | container `realpath -e` and `docker exec -w <root> pwd` both return the byte-identical absolute path |
| byte identity host → container | token read back inside at the same absolute path, rc=0 |
| byte identity container → host | token written inside, read back here, `uid=1000 gid=1000 mode=644` |
| mode / mtime | container `stat -c '%f %s %.3Y'` → `81a4 6 1788591959.525`; host `fs.stat` → `mode=33188 (=0o100644=81a4) size=6 mtimeMs=1788591959.5253` — inside the suite's 1.5 ms tolerance |
| `readDir` derivation | `find <root>/d/. -mindepth 1 -maxdepth 1 -printf '%y\t%f\n'` → `l lnk / d sub / f "a file with spaces"` |
| `/bin/bash`, `-w`, `-e` | `bash-ok`; `docker exec -w <root> -e CC_PROBE=… /bin/bash -lc 'pwd; echo $CC_PROBE'` → the root, `from-frame` |

## The cross-namespace SIGKILL, and the one thing our side can do

cc's suite writes the grandchild's pid with `echo $!` executed **by the far
side** (`tests/systems-protocol-conformance.test.mjs:166`), reads it at `:172`,
`alive(pid)`s it at `:178`, and then in a `finally` does
`process.kill(pid, 'SIGKILL')` **host-side** at `:186`. Under `host` those are
the same namespace. Under a bound container run they are not: a
container-namespace pid interpreted as a pid in the test container. Identical at
`8b7b10bf` and `346d1a1d` (sha256 `2b61ab58…` over `:156-190`). Filed for cc's
board; **not ours to change**.

**`docker run --pid=container:<self-id>` is a real mitigation, and it was
measured to work.** It puts the fixture container in *this* container's PID
namespace, so the pid at `:166` is a real pid here. Measured end to end: a
`sleep 120` started inside reported pid `4102254`; host-side
`/proc/4102254/cmdline` read `sleep 120`, `process.kill(pid, 0)` said alive, and
`process.kill(pid,'SIGKILL')` killed it (`ESRCH` after). So `:178` becomes honest
and `:186` kills the process it names.

**Unshared is REFUSED, not warned about.** If the daemon rejects
`--pid=container:`, the runner aborts naming the hazard;
`CODE_SYSTEM_ALLOW_UNSHARED_PID=1` is the only way to take that run. "The low
pids on this box happen to be unoccupied" is luck, and a warning followed by the
full battery is accepting luck as a guard.

**The runner also PRINTS the pid, on both branches**, because it is the one
diagnostic our side can contribute: `watchFarSidePids` polls the scratch tree for
the `grandchild.pid` the far side writes and snapshots `/proc/<pid>/cmdline` at
that moment. Both outcomes measured, on the same box, minutes apart:

```
shared    far-side pid 280657 — this namespace saw sleep 30   (the same process)
unshared  far-side pid 113    — this namespace saw <no /proc/113: ENOENT>
          far-side pid 538    — this namespace saw <no /proc/538: ENOENT>
```

That is the whole hazard in three lines: shared, the kill lands on the
grandchild; unshared, cc SIGKILLed pids `113` and `538` **in this container**,
and it was only luck that nothing was there.

**The residual, and why it is safe.** A shared PID namespace means the fixture
container's `/proc` also lists *this* container's processes — measured directly:
a `docker exec … tr '\0' ' ' < /proc/<our-pid>/cmdline` inside read our own shell's
command line. So the container-side reap script scans us. It stays safe because
`buildReapScript` matches `CC_EXEC_TOKEN=<nonce>` in `/proc/<pid>/environ`
(`src/launcher/kinds/reapscript.mjs`), and our host-side `docker exec` clients
carry the token in **argv**, not in their environment: `spawnPlan` returns
`env: undefined` (`src/launcher/kinds/docker.mjs`), so the client inherits a
launcher env with no token. **That property is what makes sharing safe, and it is
already pinned** — `tests/dockerkind.test.mjs`: *"the host-side docker client gets
no env of its own"*. Do not "simplify" it into an env overlay.

## The two structural non-coverages

**1. `processGroupSignal` is a genuine FAILURE, and there is no skip path.**
`TOGGLED_CAPABILITIES` derives to `['processGroupSignal']` alone, and
`assertNegotiatedCapabilities`'s third-party branch does
`assert.equal(caps[cap], config.caps[cap])` for each. `CAPABILITY_CONFIGS[0]`
passes no flags and expects `true`; `kinds/docker.mjs` hardcodes `false`.
§10's relaxation is explicitly one axis (`remotes`/`remoteDescriptors` may be a
**superset**), a narrowness the suite pins itself in *the third-party capability
assertion tolerates a superset but pins the toggle*; and §10 names our exact
shape — accepts `--no-process-group-signal` and ignores it — as failing, *"Neither
is skipped."* Two rows, `[all capabilities]` only.

`[processGroupSignal:false]` passes both — **but only because the flag it was
given happens to agree with a value we hardcode**, not because the flag works.

> A cc-side gap: §11 item 2 *expects* a provider that cannot do process-group
> signalling to "advertise `false` and let cc take the documented fallback", but
> `CAPABILITY_CONFIGS[0]` gives such a provider no way through however truthful
> it is. That is cc's third-party contract disagreeing with itself, not a
> code-system defect. `ssh` hardcodes `false` too (`kinds/ssh.mjs`), so this
> applies to it identically.

**2. Six flag rows are unreachable, and deliberately.** `src/launcher/main.mjs`
refuses `--remote`/`--mirror`/`--exclude` for `STORE_BACKED` kinds with **exit 2
before any frame**, and six out-of-loop rows launch their own provider with them,
so `sys.connect()` fails. No design satisfies both cc's fixtures and the
`StoreRemoteSource.lookup` gate: any flag-backed target source on a shipped
store-backed kind is a **second remote path around the single `ENOREMOTE`
chokepoint**. Recorded as a consequence, not a gap to close.

Two of those six are the mirror rows, and they stay unreachable for the SAME
reason now that `docker`/`ssh` advertise `remoteDescriptors: true` (card
2026-0017): the advertisement comes from `record.mirror` in the store, not from
`--mirror`/`--exclude`. **Measured 2026-09-05, daemon 29.7.2: the flip moved no
manifest row** — the run before and after it is outcome-identical, row for row.
§10's third-party relaxation tolerates `remotes`/`remoteDescriptors` as a
superset, and the two cc-side mirror rows skip on `IS_REFERENCE_PROVIDER`
whatever the provider's shape.

Related: §10 says *"`CC_CONFORMANCE_REMOTE_ID` presupposes `--remote`"*. Our
bound run passes **no `--remote` at all** and clears the harness's bound-run
precondition only because `StoreRemoteSource.hasRemotes()` is **constant `true`**
(`src/launcher/remotes.mjs`). A legitimate but off-spec shape — and the constant
is the reason it is legitimate.

## The defect the run found — which is the point of the run

The two `exec NEVER rejects — a command that cannot start is a spawnError, not a
throw` rows fail, in **both** configurations. This is **not** structural; it is
**card 2026-0016**, and `host` cannot reach it.

Measured 2026-09-05, daemon 29.7.2: `docker exec` of a missing binary writes its
whole **OCI diagnostic to STDOUT**, with **stderr empty** and exit **127**.
`src/launcher/session.mjs` streams that stdout to cc as `stdout` frames as it
arrives — it cannot yet know the command never started — and only on `close` does
`classifyFailure` recognise the shape and emit the `error` frame carrying
`first(stdout)`, which **trims**. cc's `ExecOutputCollector.result` then fills
*"whichever buffers are still empty"*, its comment adding *"in practice all of
them, since the error fires before any data"*. `stderr` **is** empty, so
`r.stderr === r.spawnError` passes; `output` already holds the streamed bytes, so
`r.output === r.spawnError` fails. A command that never ran is reported to cc as
having produced output — and that output is the **transport's** diagnostic, not
the command's.

**Be precise about what breaks it: `raw !== trimmed`, not a size or a line
ending.** The diagnostic's length is a function of the argv it quotes (in that
run, the suite's 33-character fixture binary name), and its trailing bytes were
CRLF on that daemon — but a bare `\n` fails the assertion identically, and every
canned OCI sample in `tests/dockerkind.test.mjs` ends `\n`. Neither figure is a
property of the failure, and neither should be quoted as one.

`host`'s spawn error fires before any data, exactly as cc's collector assumes,
which is why the seam argument could never have surfaced this.

## `ssh` does NOT inherit this result

**A bound `ssh` run is its own card.** The reasoning, so nobody re-derives it:

- The bound run's whole value is the **per-kind residue** — `spawnPlan`, `reap`,
  `classifyFailure`. Everything else was already carried by `host`, so a docker
  bound run adds nothing about `ssh`.
- The two residues differ in **exactly the axis the battery stresses hardest**.
  `docker`'s `spawnPlan` hands the far side an **argv vector**; `ssh`'s hands it a
  **single shell string the far side's login shell re-parses**
  ([ssh-controlmaster-transport.md](ssh-controlmaster-transport.md)). The
  battery's `a file with spaces`, `two\nlines`, `hello — héllo` and its
  multi-chunk base64 payloads are therefore a **quoting test for `ssh`** and a
  no-op for `docker`. A green docker run says nothing about the thing most likely
  to be wrong in `ssh`.
- It is now *feasible* — the same host bind gives an sshd container the same
  filesystem at the same path — but it needs a uid-matched sshd image and its own
  identity measurement, which is `sshFixture` work.

## The pin, and why the result is not stale

**The suite file has MOVED since `8b7b10bf`; the harness has not.** Re-measured
2026-09-05 at cc `52701bc6` (worktree `code-conductor_worktree_systems`):

| file | sha256 at `52701bc6` | was |
|---|---|---|
| `tests/systems-protocol-conformance.test.mjs` | `99d766848ff851c64be81c32a5242e997b8a3ffbfaaa88adda3a3bf58db25f37` | `5ec8d055…` at `8b7b10bf` |
| `tests/referenceProviderHarness.mjs` | `50b5b2e1fd56a65951919c2b7de6a3f76553cbef0386da4c84e0ce4e38064313` | unchanged |

So the **capability matrix and the two config names did not move** — only the
battery did (51 → 55, above). It is that pair of hashes, not the commit, that
says whether a recorded result still holds; re-take them before trusting one.

**The other `8b7b10bf` citations in `docs/` are about `env`,
`IS_REFERENCE_PROVIDER` and registration** and were NOT re-measured here. Do not
re-point a pin you have not re-verified.

**Clone the pin; never point `CC_CHECKOUT` at a live cc worktree** — the recipe
and the before/after `git status` check are in
[host-kind-and-conformance.md](host-kind-and-conformance.md).
