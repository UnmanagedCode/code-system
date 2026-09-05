# The bound conformance run: what it measures, and what it structurally cannot

**What:** `npm run conformance:docker` (`tests/conformance-docker.mjs`) runs cc's
conformance battery with `CC_CONFORMANCE_REMOTE_ID` bound to a real container
served by the **shipped `docker` kind**. `npm run conformance` runs the same
battery on `host`; that it carries every other kind is a *seam* argument
(`protocol.mjs`, `session.mjs` and `fileops.mjs` are kind-agnostic and
`spawnPlan` is pure). This run **measures the per-kind residue** instead of
generalising to it. Design in `docs/architecture.md` → "The consequence for a
bound conformance run"; every number below was measured on **2026-09-05**,
against cc `8b7b10bf`, daemon `dell-work` server 29.7.2, `sudo -n docker`.

## The outcome, and the coverage it buys

The battery is **51 test executions** (17 in-loop × 2 `CAPABILITY_CONFIGS` + 17
out-of-loop). A bound `docker` run:

| | count |
|---|---|
| pass | **37** |
| fail | **10** — 2 capability, 6 flag, 2 a real defect (below) |
| skip | **4** — exactly the `IS_REFERENCE_PROVIDER` set in [host-kind-and-conformance.md](host-kind-and-conformance.md) |

Of the 37 passes, **5 exercise no provider of ours** (`parseFindLines …`, `an
unrecognised field on a remoteDescriptor …` — which drives cc's own
`mirrorFixtureProvider.mjs` — and the three pure `CC_CONFORMANCE_REMOTE_ID` /
capability-assertion rows). So **32 rows exercise the shipped `docker`
transport**, where before this gate the number was zero. `host` exercises 42 by
the same subtraction.

Wall clock **~17 s**, against cc's 90 000 ms per-file hang guard and its 60 s
per-test `--test-timeout` — a **5.3x** margin, printed on every run.
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
and `:186` kills the process it names. The runner uses it, and falls back with a
**loud** warning naming the hazard if the daemon refuses it.

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

Related: §10 says *"`CC_CONFORMANCE_REMOTE_ID` presupposes `--remote`"*. Our
bound run passes **no `--remote` at all** and clears the harness's bound-run
precondition only because `StoreRemoteSource.hasRemotes()` is **constant `true`**
(`src/launcher/remotes.mjs`). A legitimate but off-spec shape — and the constant
is the reason it is legitimate.

## The defect the run found — which is the point of the run

The two `exec NEVER rejects — a command that cannot start is a spawnError, not a
throw` rows fail, in **both** configurations. This is **not** structural; it is
**card 2026-0016**, and `host` cannot reach it.

Measured: `docker exec` of a missing binary writes the whole **151-byte OCI
diagnostic to STDOUT**, ending `\r\n`, with **stderr empty** and exit **127**.
`src/launcher/session.mjs` streams that stdout to cc as `stdout` frames as it
arrives — it cannot yet know the command never started — and only on `close` does
`classifyFailure` recognise the shape and emit the `error` frame with a trimmed
message. cc's `ExecOutputCollector.result` then fills *"whichever buffers are
still empty"*, its comment adding *"in practice all of them, since the error fires
before any data"*. `stderr` **is** empty, so `r.stderr === r.spawnError` passes;
`output` already holds the 151 streamed bytes, so `r.output === r.spawnError`
fails. A command that never ran is reported to cc as having produced output —
and that output is the **transport's** diagnostic, not the command's.

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

`docs/` cites cc `8b7b10bf`. Measured: `tests/systems-protocol-conformance.test.mjs`
(sha256 `5ec8d055…`) and `tests/referenceProviderHarness.mjs` (sha256
`50b5b2e1…`) are **byte-identical** from `8b7b10bf` through the systems branch's
HEAD at the time, `346d1a1d`. Run against `8b7b10bf` — one pin in the tree — and
it is that byte-identity, not the pin, that says the result still holds.

**Clone the pin; never point `CC_CHECKOUT` at a live cc worktree** — the recipe
and the before/after `git status` check are in
[host-kind-and-conformance.md](host-kind-and-conformance.md).
