# Interface contracts

What this plugin puts on the wire: the `hello` each kind sends, the `remoteId`
routing rules, the derived file-operation scripts, the auto-registration
exchange, and the backend REST surface.

The wire contract itself is code-conductor's `docs/systems-protocol.md`; this
page records only **our** side of it.

## The handshake

Sent once, before any other frame, in answer to cc's `hello`.

```json
{"type":"hello","protocol":1,"provider":"code-system-docker/0.1.0",
 "capabilities":{"processGroupSignal":false,"remotes":true,"remoteDescriptors":false}}
```

| Capability | `docker` | `ssh` | `host` |
|---|---|---|---|
| `processGroupSignal` | **`false`, final** — see below | `false` until card 2026-0004 | `true` unless `--no-process-group-signal` |
| `remotes` | `true` always | `true` always | at least one `--remote` |
| `remoteDescriptors` | `false` | `false` | at least one `--mirror`/`--exclude` |

**Those three keys and no more.** They are cc's `Capabilities` interface
verbatim (`src/systems/protocol.ts`); a missing key reads as `false` and an
unknown key is ignored, so a fourth would be a field with no reader.

**There is NO `system` descriptor**, and we send none. cc's
`HelloProviderFrame` is `{type, protocol, provider, capabilities?}`. The
descriptor the hello used to carry (`os`, `pathSep`, `shell`, `home`) is
deleted: `shell` was the only field cc ever read — it opened the long-lived
shell with it — and that shell is gone. **Do not reintroduce a per-kind
`defaultShell`, a per-remote `shell` field, or a probe for either.**

**`docker`'s `false` is a decision, not a placeholder.** It is *achievable*:
measured, a `docker exec`'d process is already its own process-group and session
leader (so §11 item 2's `setsid` prerequisite is unnecessary) and
`kill -9 -<pgid>` works inside the container, although §11's own
`kill -- -<pgid>` is refused by dash's builtin. It stays `false` because `true`
obliges **signal fidelity** — §5's `signal` row is "delivers exactly that signal"
— i.e. a whole `Transport.signal` seam relaying into the container, for a
capability whose only consumer meant "kill the command". `false` costs nothing:
the core sets `descendantsMaySurvive: true` on every exit it terminated, and the
kind's `reap` SIGKILLs the container-side subtree anyway. Both measurements are
in `.wiki/gotchas/docker-exec-transport.md` so a later card can raise it from a
known position.

`docker` and `ssh` advertise `remotes:true` **always**, never derived from what
is in the store — cc memoises the handshake per connection generation, so a
capability that flapped as remotes were added would be memoised wrong. See
`docs/architecture.md` for what that costs and why it is accepted.

## `remoteId` routing

Carried by the four **request** frames only — `exec`, `readFile`, `writeFile`,
`describeRemote` — and by nothing else. An id is bound to one remote for its
whole lifetime; `signal`, `close`, `data` and `end` are addressed by `id` alone
and we never look for a `remoteId` on them.

| Situation | Answer |
|---|---|
| no `remoteId`, on a kind advertising `remotes` | `ENOREMOTE`, **id-addressed** — we have no default |
| unknown / absent / unreadable record | `ENOREMOTE`, id-addressed |
| record at another schema | `ENOREMOTE`, quoting the schema found, naming the backend as the repair |
| record whose `kind` is not this launcher's | `ENOREMOTE`, naming the kind it actually is |
| record whose `baseline.state` is `unsupported` | `EUNKNOWN`, id-addressed, naming the missing capability, `stderr` carrying the target's own words |
| record whose `baseline.state` is `unknown` | **served** — absence of evidence is not evidence |
| `docker` record whose container is **stopped** | `ENOREMOTE`, id-addressed, naming the container and that this provider is attach-only |
| `docker` record whose container **does not exist** | `ENOREMOTE`, id-addressed, naming the **configured** container |
| path or non-placeholder `cwd` outside a fenced remote's root | `EACCES`, id-addressed |
| `describeRemote` without `remoteDescriptors` | `EUNSUPPORTED`, id-addressed |
| a frame for an unknown or already-settled id | **dropped**, not an error |
| an unknown frame **type** | **ignored** — the contract's extension point |
| a malformed line, or one past `MAX_LINE_BYTES` | `EPROTO`, **id-less**, then exit non-zero |

**Id-addressing is a MUST, not a nicety.** An id-less `error` frame is
connection-level and would fail every *other* target's in-flight work
(`systems-protocol.md §9`).

**`cwd: "/"` is accepted and never fenced.** Every derived operation cc sends
(`stat`, `readDir`, `realpath`, `mkdir`, `removeTree`, `unlink`, `chmod`)
carries `/` as a placeholder with its real target in `argv`. A kind that fenced
it would refuse every derivation while `exec` and the file primitives kept
working.

**`CC_REMOTE`** is injected into the remote command's environment whenever a
frame named a remote. It is positive routing evidence: on a host where two
targets may be the same filesystem, "the command worked" is what a misroute also
looks like. It is overlaid **after** a frame's wholesale `env` replacement
(`execEnv`, `src/launcher/kinds/config.mjs`), so the provider's binding beats a
frame-supplied value.

**An `exec` frame with no `env` means "inherit the FAR SIDE's environment"**, and
the launcher passes exactly that — `null` — to the kind. It never substitutes its
own `process.env`: cc sends no `env` on any of its seven derivations precisely
because they inherit the far side's PATH and toolchain (§7). For `docker` that is
the difference between `git` resolving in the container and `env: 'git': No such
file or directory`, exit 127.

## `docker` — what goes on the wire

```
<docker-cli> exec [-i] -w <cwd> [-e CC_REMOTE=<id> -e CC_EXEC_TOKEN=<tok>]
            -- <container> <command…>
```

| Element | Rule |
|---|---|
| `<docker-cli>` | `["docker"]`, or the whole argv named by **`CODE_SYSTEM_DOCKER`** (JSON array of non-empty strings). The shipped default hardcodes no `sudo`; a malformed value throws at transport construction → launcher exit 2 before any frame |
| subcommand | `exec` only. `reachability` uses `inspect`. **Nothing else, ever** — attach-only is enforced in code (`ALLOWED_SUBCOMMANDS`), never `start`/`stop`/`run`/`rm` |
| `-i` | iff the frame's `stdin` is `pipe`. This is how `writeFile`'s base64 payload reaches the container, and EOF propagates through it |
| `-w <cwd>` | the frame's `cwd`, verbatim, **including `/`** — the plan leaves the host client's own `cwd` unset |
| `--` | always, so the container name is unambiguously an operand |
| `<command…>` | `argv` form: the argv verbatim. `shell` form: `/bin/bash -lc <shell>` — **absolute**, so it resolves under `env -i` regardless of the frame's PATH, and it is the same interpreter the baseline probe requires |
| `env` absent (`null`) | no `env -i`: the container keeps its own PATH/HOME/toolchain. The two plumbing variables ride as `-e` flags |
| `env` supplied | `env -i NAME=VALUE…` prefixed to the command — a **replacement**, which `-e` flags cannot express — and **no** `-e` flags, which `env -i` would wipe. `CC_REMOTE` and `CC_EXEC_TOKEN` are the last entries |
| `detached` | never. The container process is not an OS descendant of the host client, so a group kill does not reach it — claiming otherwise would make every terminated exec falsely omit `descendantsMaySurvive` |

`CC_EXEC_TOKEN` is the per-exec nonce `reap` finds this exec's container-side
processes by (`docs/architecture.md` → Shutdown and reaping).

### How a docker failure becomes a code

Measured against Docker Engine 29.7.2. **Note the channel**: a daemon-level
refusal is on **stderr** with exit 1, but a command that never started is on
**stdout** with exit 127 — so a stderr-only classifier is blind to it, and
`fileops`' header parse sees the text as file content.

| Exit | Stream | Text | Verdict |
|---|---|---|---|
| 1 | stderr | `Error response from daemon: No such container: <name>` | `ENOREMOTE` |
| 1 | stderr | `Error response from daemon: container <64-hex> is not running` | `ENOREMOTE`, saying the provider is attach-only |
| 1 | stderr | `permission denied while trying to connect…` / `Cannot connect to the Docker daemon…` | `EUNKNOWN` naming `CODE_SYSTEM_DOCKER` — **never `ENOREMOTE`**: our access failing is not the remote being absent |
| 127 | **stdout** | `OCI runtime exec failed: exec failed: unable to start container process: …` (missing binary, or a `-w` that does not exist) | `ENOENT` — §5's "a command that never started is an `error` frame, not an `exit` frame" |
| anything else | — | — | **not a transport failure**: the command's own `exit` frame |

Every row is guarded so a command cannot forge a verdict: the daemon rows
additionally require an **empty stdout** (docker writes none there), and the
`127` row requires an **empty stderr** plus the full docker-internal sentence as
the very first bytes of stdout. This runs on two paths —
`session.mjs`'s exec close handler and `run.mjs`'s single funnel for `fileops`
and the baseline probe — through one optional `Transport.classifyFailure` member.

### Known limitation: `env` across the transport boundary

At cc `bf5f2afe`, cc's non-derived `exec` sends **its own host environment** as a
wholesale `env` (`providerSystem.ts`: `opts.env ?? process.env`). §5 says `env`
REPLACES, so honouring it faithfully means a container command sees cc's host
`HOME` and `PATH`. The `shell` form largely self-repairs (`/bin/bash -lc`
re-sets PATH from `/etc/profile`); the **argv** form does not, and a host PATH
without the container's binary directories yields exit 127. cc's own card
2026-0317 removes the cause upstream (unmerged, off the pin). Tracked on this
side as **code-system card 2026-0008**; see
`.wiki/gotchas/exec-env-across-a-boundary.md`.

## `readFile` / `writeFile` — derived over `exec`

Both are derived from `exec` in `src/launcher/fileops.mjs`, **once for every
kind**. The target must satisfy cc's POSIX/GNU baseline anyway (cc's own derived
operations are `exec` frames against that toolchain), so `base64` is already
required and a `docker cp` / `scp` path would buy no capability — only a second
code path to keep correct.

Each script runs under `/bin/sh -c` through the **argv** form, not the `shell`
form: `bash -lc` is a *login* shell whose profile output would arrive before the
script's own, and the reads parse the first line.

**read** — one round trip:

1. exists? (`-e`, which follows symlinks, so a broken link is `ENOENT`) → dir?
   → readable?
2. `stat -L -c '%f %s'` for the **whole file's** raw mode and size
3. compute the requested extent; above `MAX_FILE_BYTES` refuse `EFBIG`
   **before transferring a byte**
4. `CCSTAT <mode-hex> <size>` then
   `tail -c +<off+1> | head -c <want> | base64 | tr -d '\n'`

`isBinary` is a NUL within `BINARY_SNIFF_BYTES` of **the returned range**, not
of the file. The payload is then chunked at `CHUNK_BYTES` into `data` frames —
both ends MUST chunk — followed by `end`.

**write** — payload buffered from `data` frames, then one round trip on `end`,
with the base64 riding on the command's **stdin** (never argv):

| Mode | Script |
|---|---|
| `atomic` | `mkdir -p` the parent, decode to `<path>.<pid>.<seq>.tmp`, `chmod`, `mv -f` over — the rename is what makes `mode` **preserving** |
| `exclusive` | `set -C` (noclobber) around the redirect, so the create is atomic; a pre-check gives the common case a clean `EEXIST` first |
| plain | a direct truncating redirect, matching `fs.writeFile`, which **preserves** an existing file's mode |
| `atomic` + `exclusive` | **refused** — an atomic write ends in a rename, which overwrites by definition |

### How a failure becomes a code

cc's callers branch on these codes — "create the file unless it already exists"
is written as *catch `EEXIST`* — so getting them right is a MUST, not tidiness.
Two sources, and they are read differently:

| Source | Read by |
|---|---|
| **Our own script's refusals** | a **per-call nonce tag**, `CCERR-<nonce> <CODE>`, on stderr |
| Anything else the far side's tools printed | `classifyStderr`, matching the POSIX `strerror` tail |

**The tag exists because matching the tail is spoofable by a path.** The scripts
interpolate the requested path into their own failure text, so a file named
`.../Is a directory` would make a missing-file `ENOENT` classify as `EISDIR`.
Exit codes are no help either: the same noclobber failure is exit 2 on dash and
exit 1 on bash, measured on this host. The tag is matched anywhere in stderr —
so it does not depend on whether the shell printed its own message first — and
is **stripped before the stderr is reported to cc**.

It is unforgeable because of *when* the nonce is made: cc fixes the path in its
request frame, and the nonce is generated **per call, afterwards**, 48 random
bits each time. A pre-existing filename cannot contain a nonce that did not
exist when the file was named. **Reusing a nonce across calls, or hoisting it to
module scope, breaks that** — it is pinned in `tests/fileops.test.mjs`.

Each tagged line still carries the POSIX tail after it, for a human reading the
error, and the scripts still emit those tails explicitly rather than letting the
shell's wording through — shells disagree (a failed redirect says "Directory
nonexistent" on dash and "No such file or directory" on bash).

### What `exclusive` does and does not guarantee

`set -C` is the shell's `O_EXCL`, and it was measured honoured by both dash and
bash on this host. Two gaps are **stated rather than claimed away**:

- **The noclobber failure path is never executed by our suite.** The test that
  drives an existing target creates it first, so the `[ -e ]` pre-check fires
  and the `set -C` trap is not reached. A bug in that tagged-refuse trap would
  surface as `EUNKNOWN` on a bash target with nothing in the suite failing.
  What *is* covered: the generated script is structurally guarded (`set -C`
  precedes the redirect it protects, and is absent from the plain branch), and a
  canary asserts the real shell refuses the redirect and leaves the file intact.
- **The canary covers this host's `/bin/sh` only.** A docker or ssh target whose
  shell ignores noclobber silently converts `exclusive` into a **truncating
  write**, and nothing this plugin ships can detect it. Card 2026-0003 landed the
  first kind that reaches a shell which is not ours; its live suite exercises
  `exclusive` against `node:24-slim`'s dash and gets `EEXIST`, but that is one
  image, not a guarantee. **Still open for card 2026-0004 and for any target
  image**; the tooling-baseline probe is where such a check would belong.

### What an abandoned write leaves behind

`close` is a hard kill by contract, so a write cancelled mid-flight can leave
residue. All three cases are accepted, not defects:

- **An aborted `atomic` write leaves its temp file** beside the target. §6 scopes
  the no-torn-write guarantee to the target, and that holds — the rename never
  ran. The temp name is unique per call, so it cannot interfere with anything,
  and cc's own reference provider leaves the same residue. Adding a SIGTERM
  grace so a trap could clean up would weaken `close` from a hard kill to tidy a
  file. **Far-side cleanup belongs in a kind's `reap`**, which for `docker` is a
  token scan that SIGKILLs the container-side subtree — it does not remove a temp
  file the killed script had already created.
- **An aborted plain or `exclusive` write leaves a truncated target.** Inherent
  to a truncating redirect, matches the reference provider, and §6 promises
  nothing here.
- **An abort landing after the far-side `mv` completed** reports the write as
  failed although the target was fully written. cc treats `close` as *abandon*,
  so no caller reads that answer.

## Auto-registration

`src/registration.mjs`, once, after `listen`, never blocking startup.

Desired rows — the argv is a function of **(install path, kind) only**, so cc's
per-`(row.id, JSON.stringify(argv))` handle cache holds one connection while
remotes come and go:

| id | label | launch |
|---|---|---|
| `docker` | Docker containers | `[process.execPath, <abs>/src/launcher/main.mjs, "--kind", "docker"]` |
| `ssh` | SSH hosts | `[process.execPath, <abs>/src/launcher/main.mjs, "--kind", "ssh"]` |

`process.execPath` rather than a bare `"node"`: cc spawns without a shell, so a
bare name would depend on the orchestrator's PATH.

1. no `CONDUCTOR_URL` → `skipped` (standalone-runnable is a compliance
   requirement). Stop.
2. `GET {CONDUCTOR_URL}/api/settings/systems`; **404** → `unsupported` (this cc
   predates Systems support); network error or non-2xx → `error`. No retry.
3. per row: absent → `POST`; present with a matching `launch` → **send
   nothing** (a PATCH would make cc re-probe on every backend restart,
   `updateSystem` in `appSettings.ts`); present with a different `launch` → `PATCH {launch}`.

| From cc | State | Shown |
|---|---|---|
| `201` / `200` | `ok` | the row is live |
| `409` | `ok` | already exists — a race with another instance |
| `400` | `blocked` | **cc's message, verbatim** — usually the `.git`-ancestor placement refusal, whose text already names the directory and the fix |
| `502` | `unreachable` | cc's message (it embeds our stderr tail), plus that this is a bug signal in the plugin, not a user error |
| `404` on the collection | `unsupported` | this cc has no Systems support |
| anything else / network | `error` | status and body, verbatim |

Every one of these is a **recorded state** — never a throw, never an exit, never
a retry loop. "Never crash-loop" is implemented by there being no loop: the one
retry is `POST /api/registration/retry`, driven by a button. State is in memory
only and re-derived at every start.

## Backend REST

| Route | Purpose |
|---|---|
| `GET /api/health` | any response counts as alive |
| `GET /api/registration` | `{state, rows:[{id,state,httpStatus,message}], checkedAt}` — `blocked`/`unreachable` messages are rendered verbatim |
| `POST /api/registration/retry` | the only retry; user-driven |
| `GET /api/remotes` | every stored remote, each with a live `reachability` and a `baseline`; an unreadable record appears as `{remoteId, broken:{reason,message}}` rather than being hidden |
| `POST /api/remotes` | create — validates the `remoteId` charset, delegates `config` to the kind. 400 / 409 |
| `PATCH /api/remotes/:id` | edit everything **except** `remoteId`; a changed `config` resets `baseline` to `unknown` |
| `DELETE /api/remotes/:id` | delete, **warning** when any cc project still names this `remoteId` |

### Config values that become argv

A kind's `validateConfig` owns the shape of its `config`, and **every field that
ends up as an argv operand must reject a leading `-`** — `container`, `host`,
`user` today (`src/launcher/kinds/config.mjs`, shared by both kinds). A value
like `container: "-v /:/host"` or `host: "-oProxyCommand=..."` is read by the
far-side binary as an **option**, not an operand, turning a stored remote into
argument injection against `docker` or `ssh`.

**This is refused at the store's front door, not defended against in
`spawnPlan`** — `docker`'s `spawnPlan` builds argv from `container` today and
card 2026-0004's will from `host`/`user`, so the rule has to hold before either
exists. A validator that accepts an
option-shaped value is a latent hole even while `spawnPlan` throws. Any new
config field a kind adds gets the same treatment.

(It is not a general escaping scheme: nothing here reaches a shell — the core
spawns argv directly, and `fileops.mjs` quotes what it interpolates.)

### `remoteId`

`remoteId` charset: `^[a-z0-9][a-z0-9._-]{0,63}$`, never `.` or `..`. It is both
a filename stem and the entire hand-off contract to a cc project's *Remote*
field, so it must be human-typable and is **never renamed** once created — which
is why the delete route warns: cc has no `listRemotes` frame, so nothing else
would tell the user which projects they just stranded.
