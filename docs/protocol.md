# Interface contracts

What this plugin puts on the wire: the `hello` each kind sends, the `remoteId`
routing rules, the derived file-operation scripts, the auto-registration
exchange, and the backend REST surface.

The wire contract itself is code-conductor's `docs/systems-protocol.md`; this
page records only **our** side of it.

**That file is not in this repo.** Every `systems-protocol.md §N` citation in
`src/`, `docs/`, `tests/` and `.wiki/` points at
`$CC_CHECKOUT/docs/systems-protocol.md` in a code-conductor checkout —
`CC_CHECKOUT` being the same variable `npm run conformance` is gated on.

## The handshake

Sent once, before any other frame, in answer to cc's `hello`.

```json
{"type":"hello","protocol":1,"provider":"code-system-docker/0.1.0",
 "capabilities":{"processGroupSignal":false,"remotes":true,"remoteDescriptors":true}}
```

| Capability | `docker` | `ssh` | `host` |
|---|---|---|---|
| `processGroupSignal` | **`false`, final** — see below | **`false`, final** — same reason | `true` unless `--no-process-group-signal` |
| `remotes` | `true` always | `true` always | at least one `--remote` |
| `remoteDescriptors` | `true` always | `true` always | at least one `--mirror`/`--exclude` |

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

**`ssh`'s `false` is the same decision, for the same reason** — `true` obliges
signal fidelity, i.e. a `Transport.signal` seam relaying into the far host — and
it is not restated here. `reap` SIGKILLs the far-side subtree either way.

`docker` and `ssh` advertise `remotes:true` **and `remoteDescriptors:true`
always**, never derived from what is in the store — cc memoises the handshake per
connection generation, so a capability that flapped as remotes were added, or as
one gained or lost a mirror, would be memoised wrong. See
`docs/architecture.md` for what that costs and why it is accepted.

### The mirror advertisement (`describeRemote` → `remoteDescriptor`)

The **capability** is constant per kind; the **per-remote** answer is the frame.
Both come out of `src/launcher/session.mjs`'s single descriptor-shaping site,
fed by `StoreRemoteSource.mirrorFor` (`src/launcher/remotes.mjs`), which reads
`record.mirror` fresh off the store.

| Remote | Answer |
|---|---|
| enabled, `record.mirror` set | `{"type":"remoteDescriptor","id":…,"mirrorRoot":<mirror.root>,"exclude":[…]}` — the stored entries, in the stored order |
| enabled, `record.mirror` null | `{"type":"remoteDescriptor","id":…}` — **neither field**, §2.1's valid "I advertise nothing"; cc takes the `NO_ADVERTISEMENT` → `noMirror(systemPath)` path, identical geometry to before this existed |
| switched **off**, or unknown id | id-addressed `ENOREMOTE` — `lookup` runs before the frame's own handler, for all four request frames |

**Cost of the always-`true` capability:** one extra request/response pair per
target per connection generation for a remote that advertises nothing. Nothing
downstream of the answer changes.

**A mirror edit is not live.** cc re-asks only on a new connection generation, so
a change reaches an already-running session after the System reconnects. The
card's Advanced group says so.

**Validated at the store's front door, never here.** `src/mirror.mjs`
(`validateMirror`, bounded by `MIRROR_EXCLUDE_MAX` / `MIRROR_PATH_MAX` from
`src/launcher/protocol.mjs`) refuses a bad advertisement with a **400** on
`POST`/`PATCH`, where the operator can see it. The launcher passes what is stored
through unvalidated, exactly as it does `config`, so cc's
`MIRROR_ADVERTISEMENT_INVALID` (502) is reachable only by hand-editing a store
file.

## `remoteId` routing

Carried by the four **request** frames only — `exec`, `readFile`, `writeFile`,
`describeRemote` — and by nothing else. An id is bound to one remote for its
whole lifetime; `signal`, `close`, `detach`, `data` and `end` are addressed by
`id` alone and we never look for a `remoteId` on them
(`systems-protocol.md:329-333` enumerates exactly those five).

**The gate is therefore checked when an id is BOUND, not per chunk.** A
`writeFile` whose opening frame was already routed completes and lands the file
**whole**, even if the operator disables the remote before its `end` arrives;
the next *request* frame is refused. Pinned by `tests/gate.test.mjs`, with a
barrier proving the write really was routed first.

That is structural rather than a gap: `data` and `end` carry **no `remoteId`**,
so there is no second routing point at which a gate could be consulted. And
nothing is left half-written either way — `session.mjs` buffers every chunk
**host-side** and hands the far side the whole payload in **one** script
invocation at `end` (`src/launcher/fileops.mjs`), so the target is either
untouched or written whole, and refusing mid-stream would simply leave it
untouched. That property is this launcher's buffering, **not** a protocol
atomicity promise: a non-`atomic` write truncates the target directly
(`base64 -d > "$p"`), and `systems-protocol.md` §6 reserves "a reader never sees
a torn write" for `atomic: true`.

| Situation | Answer |
|---|---|
| no `remoteId`, on a kind advertising `remotes` | `ENOREMOTE`, **id-addressed** — we have no default |
| unknown / absent / unreadable record | `ENOREMOTE`, id-addressed |
| record at another schema | `ENOREMOTE`, quoting the schema found, naming the backend as the repair |
| record whose `kind` is not this launcher's | `ENOREMOTE`, naming the kind it actually is |
| record whose `enabled` is not `true` | **`ENOREMOTE`**, id-addressed — the operator gate. Checked BEFORE the baseline gate. See below |
| record whose `baseline.state` is `unsupported` | `EUNKNOWN`, id-addressed, naming the missing capability. The detail rides `message`; a `stderr` field is also set but **no cc reader consumes it** (see the note below the table) |
| record whose `baseline.state` is `unknown` | **served** — absence of evidence is not evidence |
| `docker` record whose container is **stopped** | `ENOREMOTE`, id-addressed, naming the container and that this provider is attach-only |
| `docker` record whose container **does not exist** | `ENOREMOTE`, id-addressed, naming the **configured** container |
| path or non-placeholder `cwd` outside a fenced remote's root | `EACCES`, id-addressed |
| `describeRemote` without `remoteDescriptors` | `EUNSUPPORTED`, id-addressed |
| `detach` for a live **`exec`** id | the operation ENDS: deadline cancelled, **no further frames** for it (`exit` included), the command and anything it backgrounded **left running**, and **nothing reaped** — here or at shutdown |
| `detach` for a `readFile`/`writeFile` id, or an unknown one | **dropped** — `exec` ids only |
| a frame for an unknown or already-settled id | **dropped**, not an error |
| an unknown frame **type** | **ignored** — the contract's extension point |
| a malformed line, or one past `MAX_LINE_BYTES` | `EPROTO`, **id-less**, then exit non-zero |

### `detach` — the frame `close` cannot substitute for

`close` is normatively *abandon and kill hard*, plus the far-side reap
(`docs/architecture.md` → "Shutdown and reaping"). `detach` is the opposite and
`close` cannot say it: **the operation is over and nothing is to be killed**
(`systems-protocol.md` §5, `:374-388`). We answer it in `Session.#detach`.

- **Where it comes from.** cc settles a **redirected shell command** on its own
  closing sentinel, not on our `exit` frame, and sends `detach` then (§5
  `:437-456`). **The `exit` may arrive later, or never** — which is why we report
  `exit` on the child's `'close'`, and why moving that to process-exit would be a
  regression, not a promptness win (§5 measured up to 64 KB of stdout lost that
  way).
- **The MUST 3 carve-out, and its mechanism.** MUST 3's exit reap covers
  operations still **open**; a detached exec is closed and is deliberately
  outside it (§1 `:40-57`, §11 `:859-866`). Our implementation of that carve-out
  is the `#execs.delete(id)` in `#detach`, because `Session.shutdown()` iterates
  `#execs` — the deletion is the carve-out, not bookkeeping.
- **Streams stay attached**, reading and discarding: §5 measured that pausing
  them blocks a survivor still writing and destroying them kills it with SIGPIPE.
  `state.closed` is what silences the frames.
- **`detach` is not a capability.** It is absent from §2's classification table
  (`:186-198`), no launch flag gates it, and no `capabilities` key toggles it —
  every `exec` provider owes it.
- **It is MUST 5 (`:59-64`) and it is unenforceable at runtime**: §5 `:386-388`
  says a provider that ignores it leaves the operation open with its deadline
  armed and reaps the command when that fires, and **cc cannot detect that**.
  cc's conformance battery *can* — which is the only reason the omission ever
  surfaced. It is implemented, not tolerated.

**Id-addressing is a MUST, not a nicety.** An id-less `error` frame is
connection-level and would fail every *other* target's in-flight work
(`systems-protocol.md §9`).

**Everything a user will read must ride `message`.** Measured at the pin: cc
drops the `error` frame's `stderr` on the exec path (`src/systems/providerSystem.ts:326-334`
keeps the frame's `code` and does not carry its `stderr` at all) and
nothing reads `SystemError.stderr` on the request path. So `stderr` is carried
and unread — a refusal that put its reason there would reach nobody. (Whether
`baselineRefusal` should move the target's own words into `message` is a
behaviour change on a path this card does not otherwise touch, and is filed
rather than made here.)

**Why the gate's code is `ENOREMOTE`, which is not the literal one.** Nothing
503-shaped exists in the taxonomy (`src/launcher/protocol.mjs`), and the choice is
**forced rather than preferred**: cc's `assertRemoteKnown`
(`src/systems/providerSystem.ts` at the pin) sends one probe `exec` and treats **`ENOREMOTE`
as its sole failure** — every other code is a PASS, because "each of them is the
provider answering ABOUT that remote, which is itself proof it serves it". So
`EUNKNOWN`, `EACCES` or an invented code would make cc resolve the project as
**healthy**, and the gate would surface only as unexplained per-operation
failures with no system-level signal. `EUNSUPPORTED` is worse than useless: it
maps to `501 SYSTEM_NO_REMOTES`, whose advice sends the operator to entirely the
wrong repair. `ETRANSPORT` would be a lie — the gate is explicitly not a
transport failure — and `EACCES` already means "a path outside a remote's root".

`ENOREMOTE` maps to `502 REMOTE_NOT_FOUND` and our message is interpolated
verbatim and untruncated, twice nested, into the sidebar system pill's tooltip
and into a session's redirected `Bash`.

**cc's memo of that check is asymmetric, and nothing on our side can flush it.**
`assertRemoteKnown` short-circuits on `#probedAgainst === hs`
(`src/systems/providerSystem.ts:178`) and assigns the memo at `:183`, *after* the
throw — so a refusal is never remembered (**off→on takes effect on the next
resolution**) while a success is (**on→off stays stale** until the handshake
generation changes). Only cc's advisory resolution signal lags; every operation
against a switched-off remote is still refused here, before the target is
contacted.

**Two hard constraints on the gate's message**, both measured, both pinned by
`tests/gate.test.mjs`:

1. It carries **no `stderr`** — see above.
2. It contains **no standalone FS errno token** (`ENOENT`, `EACCES`, `EEXIST`,
   `ENOTDIR`, `EISDIR`, `ENOSPC`). cc's `runGit` and `ProviderShell` ignore the
   structured code and re-derive one from the prose with `\b<CODE>\b` matching,
   which silently downgrades an administrative refusal into "git answered
   non-zero". This applies to **every** kind's `classifyFailure` message too —
   see `.wiki/gotchas/refusal-message-errno-tokens.md`.

The gate is checked **before** the baseline gate, deliberately: a switched-off
remote must say *switched off*, not *fails the tooling baseline*. The operator's
own action is the more actionable answer, and a disabled remote's stale baseline
verdict is not what they need to hear.

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
own `process.env`: for `docker` the inherit path is the difference between `git`
resolving in the container and `env: 'git': No such file or directory`, exit 127.
At cc `8b7b10bf`, **no `exec` cc issues carries an `env` frame field** — cc's own
plumbing and a caller's command alike (§7) — so every command runs in the
provider's own environment: the far side's PATH and toolchain, not cc's. A
variable a command needs travels in **argv**, through `env(1)`, which ADDS to
that environment rather than replacing it; that is how the derivations ship
`LC_ALL=C`.

**A frame `env` is still REPLACE, and every kind still implements it.** §5's
`env` row is unchanged at the new pin — an object replaces the environment
exactly as `posix_spawn` does — and cc's `ExecOptions.env` still exists. cc
sending none today is not licence to drop the branch: without it a provider
would silently *overlay* where the contract says *replace*. `docker` satisfies it
with `env -i --` (below); pinned by `tests/dockerkind.test.mjs` and, against a
real container, by `tests/docker-live.test.mjs` L7.

## `docker` — what goes on the wire

```
<docker-cli> exec [-i] -w <cwd> [-e CC_REMOTE=<id> -e CC_EXEC_TOKEN=<tok>]
            -- <container> [env -i -- NAME=VALUE…] <command…>
```

**The `--` after `env -i` is load-bearing, not tidiness.** Frame-supplied env
KEYS are arbitrary and GNU `env` reads leading-`-` operands as its own options.
Measured with `-w /`: `env -i '--chdir=/tmp' PATH=/usr/bin pwd` answers `/tmp` —
the command runs somewhere cc did not ask for — while `env -i -- …` answers `/`.
On coreutils 9.7 `--argv0=` spoofs `$0`; on 9.1 it refuses the exec outright.
Validating keys would not close the class, because the option set is GNU's. The
`-e` inherit path is unaffected: `docker exec -e` takes its value as a separate
argv token (measured).

| Element | Rule |
|---|---|
| `<docker-cli>` | `["docker"]`, or the whole argv named by **`CODE_SYSTEM_DOCKER`** (JSON array of non-empty strings). The shipped default hardcodes no `sudo`; a malformed value throws at transport construction → launcher exit 2 before any frame |
| subcommand | `exec` only. `reachability` uses `inspect`. **Nothing else, ever** — attach-only is enforced in code (`ALLOWED_SUBCOMMANDS`), never `start`/`stop`/`run`/`rm` |
| `-i` | iff the frame's `stdin` is `pipe`. This is how `writeFile`'s base64 payload reaches the container, and EOF propagates through it |
| `-w <cwd>` | the frame's `cwd`, verbatim, **including `/`** — the plan leaves the host client's own `cwd` unset |
| `--` | always, so the container name is unambiguously an operand |
| `<command…>` | `argv` form: the argv verbatim. `shell` form: `/bin/bash -lc <shell>` — **absolute**, so it resolves under `env -i` regardless of the frame's PATH, and it is the same interpreter the baseline probe requires |
| `env` absent (`null`) | no `env -i`: the container keeps its own PATH/HOME/toolchain. The two plumbing variables ride as `-e` flags |
| `env` supplied | `env -i -- NAME=VALUE…` prefixed to the command — a **replacement**, which `-e` flags cannot express — and **no** `-e` flags, which `env -i` would wipe. `CC_REMOTE` and `CC_EXEC_TOKEN` are the last entries |
| `detached` | never. The container process is not an OS descendant of the host client, so a group kill does not reach it — claiming otherwise would make every terminated exec falsely omit `descendantsMaySurvive` |

`CC_EXEC_TOKEN` is the per-exec nonce `reap` finds this exec's container-side
processes by (`docs/architecture.md` → Shutdown and reaping).

### How a docker failure becomes a code

Measured against Docker Engine 29.7.2. **Note the channel**: a daemon-level
refusal is on **stderr** with exit 1, but a command that never started is on
**stdout** with exit 127 or 128 — so a stderr-only classifier is blind to it, and
`fileops`' header parse sees the text as file content.

| Exit | Stream | Text | Verdict |
|---|---|---|---|
| 1 | stderr | `Error response from daemon: No such container: <name>` | `ENOREMOTE` |
| 1 | stderr | `Error response from daemon: container <64-hex> is not running` | `ENOREMOTE`, saying the provider is attach-only |
| 1 | stderr | `permission denied while trying to connect…` / `Cannot connect to the Docker daemon…` | `EUNKNOWN` naming `CODE_SYSTEM_DOCKER` — **never `ENOREMOTE`**: our access failing is not the remote being absent |
| 127 | **stdout** | `OCI runtime exec failed: exec failed: unable to start container process: …` (missing binary, or a `-w` that does not exist) | `ENOENT` — §5's "a command that never started is an `error` frame, not an `exit` frame" |
| **128** | **stdout** | `OCI runtime exec failed: exec failed: Cwd must be an absolute path` (a non-absolute `-w`) | `ENOENT`, same reason. Note the different exit code, and that this message lacks the `unable to start container process: ` segment the other two share |
| anything else | — | — | **not a transport failure**: the command's own `exit` frame |

Every row is guarded so a command cannot forge a verdict: the daemon rows
additionally require an **empty stdout** (docker writes none there), and the
never-started rows require an **empty stderr** plus
`OCI runtime exec failed: exec failed: ` as the very first bytes of stdout — the
longest stem all three share. On that path stdout would be the *command's* own
output had a command run, so the stderr guard is a bound on plausibility rather
than a proof; forging it yields a named refusal, never a wrong answer. This runs on two paths —
`session.mjs`'s exec close handler and `run.mjs`'s single funnel for `fileops`
and the baseline probe — through one optional `Transport.classifyFailure` member.

## `ssh` — what goes on the wire

```
<ssh-cli> -T -o BatchMode=yes -o ConnectTimeout=5 -o ControlPath=<path>
          -o ControlMaster=no -o ControlPersist=600
          -- <user>@<host> "<ONE quoted remote command>"
```

The remote command is a **single argv element**: every token below quoted once
with `shellQuote` and joined with spaces.

```
/usr/bin/env --chdir=<cwd> [-i] -- [CC_REMOTE=<id>] CC_EXEC_TOKEN=<tok> <command…>
```

**`ssh` takes a SHELL STRING, not an argv, and this is the contract sentence a
reader must not have to derive.** Everything after the destination is joined by
ssh and **tokenized by the target's login shell**, which must therefore be
POSIX-compatible in its handling of single quotes. That is the *only* layer of
resolution in play, and everything past it is named **absolutely**:
`/usr/bin/env` composes the environment and the working directory, and the
`shell` form's interpreter is `/bin/bash -lc`. **Neither side's `PATH` resolves
anything.** The measurement behind the rule — a command split across argv
elements losing its quoting and running as two commands — is in
`.wiki/gotchas/ssh-controlmaster-transport.md` §2.

**There are TWO `--` terminators, and each closes a measured hijack.**

| # | Terminator | Ends | Without it |
|---|---|---|---|
| 1 | before `<user>@<host>` | ssh's option section | a leading-dash host is read as an **option** and the *command* slides into the hostname position |
| 2 | after `env [-i]` | GNU `env`'s option section | a frame env **key** like `--chdir=/` or `--argv0=EVIL` hijacks the cwd or spoofs `$0` |

Terminator 2 is emitted in **both** env branches, not just `REPLACE`: on the
inherit branch the assignments are ours, but `<command…>[0]` is the frame's own
`argv[0]` and may start with `-`.

| Element | Rule |
|---|---|
| `<ssh-cli>` | `["ssh"]`, or the whole argv named by **`CODE_SYSTEM_SSH`** (JSON array of non-empty strings). The shipped default is bare `ssh` — **the operator's own `~/.ssh/config` and agent**, which is what makes a remote's `host` a Host *alias*. A malformed value throws at transport construction → launcher exit 2 before any frame |
| `-T` | always. The operator's config may say `RequestTTY force`, and a pty applies CR translation that corrupts `fileops`' `CCSTAT` header parse (measured) |
| `-o BatchMode=yes` | always. Nothing may wait on a human — for a passphrase or a host key |
| `-o ConnectTimeout=5` | always. With `BatchMode`, this is what makes an unreachable host answer in seconds rather than hang past cc's deadline |
| `-o ControlPath=<path>` | provider-computed, never configurable — formula in `docs/architecture.md` |
| `-o ControlMaster` | **`no` on every operation**; `yes` only in `connect`, and only after its own `no` pre-check found no master. `no` means "use a master if one exists, never create one", so the exec path needs no directory and `spawnPlan` stays pure. **`-M` is never emitted**: doubled with `-o ControlMaster=yes` it means `ask`, which `BatchMode` cannot answer (measured) |
| `-o ControlPersist=600` | finite, so a master orphaned by a crashed launcher reaps itself |
| `StrictHostKeyChecking` / `UserKnownHostsFile` | **never set** — that is the policy, not an omission. See below |
| `--chdir=<cwd>` | the frame's `cwd`, verbatim, **including `/`**. Replaces docker's `-w`, which has no ssh equivalent; a bad cwd then fails inside `env` with a wording we classify |
| `env` absent (`null`) | no `-i`: the target keeps its own PATH/HOME/toolchain. The two plumbing variables ride as `env` operands |
| `env` supplied | `-i` — a **replacement**, as §5 requires. `CC_REMOTE` and `CC_EXEC_TOKEN` are the last entries, so the provider's binding beats a frame-supplied one |
| `<command…>` | `argv` form: the argv verbatim. `shell` form: `/bin/bash -lc <shell>` — the same interpreter the baseline probe requires |
| stdin | nothing in argv. `stdin:'ignore'` already gives ssh a closed stdin, and `'pipe'` is how `writeFile`'s payload arrives and EOF propagates |
| `detached` | never. The remote command is not an OS descendant of the client, so a group kill does not reach it |

**`connect` is four steps, in this order, and it is idempotent.** Steps 1, 3 and
4 each spawn ssh — **three spawns**, in two invocation shapes (`-O check` twice,
`-N -f` once); steps 2 and 4 each also do one filesystem operation.

| # | step | on what it finds |
|---|---|---|
| 1 | ssh `-o ControlMaster=no -O check -- <dest>` | **exit 0** → return `{controlPath, detail}` at once; nothing is spawned and nothing authenticates. **Did not complete** — spawn failed, no exit status, or **killed by a signal before answering** (which is how its own 5 s bound arrives) → throw naming `CODE_SYSTEM_SSH`, touching nothing. **Any other non-zero** → no master; continue |
| 2 | `unlink(<ControlPath>)` | `ENOENT` is fine. Any other errno is a throw naming the path, and it does not continue. A socket whose master is dead is **reclaimed**, because `disconnect` never clears one |
| 3 | ssh `-o ControlMaster=yes -N -f -- <dest>` | non-zero → throw. **Exit 0 is not sufficient**: a whole stderr LINE reading `ControlSocket <p> already exists, disabling multiplexing` is a throw, because ssh degrades to an unmultiplexed connection and exits 0, leaving a background `ssh -N` that owns no socket. The line is CRLF-terminated (measured); the match is line-anchored, which is CRLF-safe in JS |
| 4 | `lstat`, then step 1's invocation again | no file, or a check that answered non-zero or did not answer → throw. Together with step 2 leaving the path absent on every route that reaches step 3, this proves the master **this call** opened, not merely that one answers |

Step 1's non-zero reading is deliberately the same one `reachability` gives the
same command — the wording is never consulted — so the probe and the connect
path cannot disagree about one master. The **did-not-complete** case is where
they part: `reachability` reads it as "not connected" (a card must always
answer), while `connect` refuses, because a non-answer there would license
step 2's unlink against a master that may well be alive.



**No config value ever becomes an `-o`.** Every `-o` value is a provider-owned
constant or the provider-computed ControlPath.

### The `known_hosts` policy

**Stated explicitly, because "we set no option" is not by itself a policy.** The
provider sets neither `StrictHostKeyChecking` nor `UserKnownHostsFile`, and
relies on an interaction: OpenSSH's default is `StrictHostKeyChecking=ask`, and
combined with the `BatchMode=yes` the provider *does* set, an unknown or changed
host key **fails — it never prompts, and never trusts on first use**.

Adding or repairing a key is the **operator's own out-of-band action** against
their own `known_hosts` (`ssh-keyscan`, or a manual verification). The refusal is
an id-addressed `EUNKNOWN` whose message says so. Pinned against a live target
whose key has been removed by `tests/ssh-live.test.mjs` → *"an unknown host key
FAILS — never a prompt, never trust-on-first-use"*.

### How an ssh failure becomes a code

**Exit 255 on its own classifies nothing**, so every row below is guarded on
ssh's own wording **plus an empty stdout**. The measured collision — including
the remote command's own exit status, which ssh forwards verbatim — is tabulated
once, in `.wiki/gotchas/ssh-controlmaster-transport.md` §1.

| Exit | Stream | Text | Verdict |
|---|---|---|---|
| 255 | stderr | `ssh: connect to host …` / `ssh: Could not resolve hostname …` | `ENOREMOTE`, naming the **configured** host |
| 255 | stderr | `hostname contains invalid characters` | `ENOREMOTE`, naming the configured host |
| 255 | stderr | `Permission denied (publickey…` on a line of ssh's own **opening**; ssh prefixes it on that line with `<user>@<host>: ` | `EUNKNOWN` naming `~/.ssh/config`, the agent and `CODE_SYSTEM_SSH` — **never `ENOREMOTE`**: our access failing is not the remote being absent |
| 255 | stderr | `Host key verification failed` on a line of ssh's own **opening** — either the first line, or the second when ssh prefixes it (with CRLF) with `No <type> host key is known for … strict checking.` | `EUNKNOWN` naming the `known_hosts` policy, same reason |
| **127** | stderr | `env: '<argv0>': No such file or directory` | `ENOENT` — §5's "a command that never started is an `error` frame, not an `exit` frame" |
| **125** | stderr | `env: cannot change directory to '<cwd>': …` | `ENOENT`, same reason. **Note the different exit code** — anchoring on 127 alone reports a bad cwd as a command that ran and exited |
| anything else | — | — | **not a transport failure**: the command's own `exit` frame |

**Two anchors are in use, and the difference is measured rather than stylistic.**
The rows whose wording *opens the stream* are matched with `startsWith` on the
stream — the strictest available. The auth and host-key rows cannot be: neither
wording opens the stream (ssh prefixes the first on its line and the second with
a whole line). They are matched **per line, within ssh's own opening**: the walk
takes the first line that matches, and stops as soon as a line is neither a
match nor that one measured preamble. Forging either therefore requires exiting
exactly 255 (or `env`'s 127/125), writing **nothing** to stdout, and putting
ssh's exact bytes at the *start* of stderr. These rows report the **whole**
normalised diagnostic as `stderr` and quote the **matched line** in the message,
because ssh's host-key refusal spans two lines and the first is the less useful
half.

**A KNOWN LIMITATION, stated rather than claimed away.** The bound above is a
bound on plausibility, not a proof, and there is one case where it is *not*
implausible: a caller's own command that runs `ssh`, `scp` or git-over-ssh and
whose **first** action fails — a submodule fetch, a jump host — prints these
exact bytes at position zero with an empty stdout and exit 255. That is reported
as **our** transport failing. The observable consequence: the command's own exit
status is swallowed into an `EUNKNOWN` that points the operator at *their*
`~/.ssh/config` or `known_hosts` to fix somebody else's failure.

**It is ineliminable from the signals this classifier receives** — which is
`(code, stdout, stderr)` and nothing else. It is *not* a universal
impossibility, and the difference matters, so the candidates are recorded rather
than asserted away:

| Candidate signal | Why it does not separate the two arms |
|---|---|
| **stdout** | empty in both. Our ssh writes nothing there on these failures, and a command whose first action is a failing ssh has produced no stdout yet |
| **exit code** | 255 in both. `ssh` itself exits 255 on an auth failure, and ssh forwards the remote command's status verbatim, so a nested client's 255 arrives as ours |
| **the bytes** | byte-identical. ssh puts no marker on its own diagnostics to distinguish them from a child's |
| **position in stderr** | **adopted** — it separates a *chatty* command (`sshOwnLine`), which was the reachable half. It cannot separate a nested client that fails first with no prior output |
| **the `<dest>: ` prefix** on the auth row | rejected on a measurement: ssh names the **resolved** host (`root@172.17.0.5: …`) while the provider knows only the operator's Host **alias**, so this anchor would reject our own genuine refusal on every alias-based remote — the shipped default shape. It is also auth-only |
| **connection state** (`reachability()`) | consistent with both arms, so it separates nothing: under `ControlMaster=no` an exec against a never-connected remote runs unmultiplexed, so *our own* auth failure also reports `connected: false`. It is also unavailable — this classifier is synchronous and takes no config beyond the record |
| **`ssh -E <log_file>`** | **it WORKS, and is deferred rather than rejected.** Measured: with `-E`, our own auth failure leaves stderr **empty** and the wording in the log, while a nested client's failure leaves the wording **on stderr** and nothing in the log. Adopting it is a `Transport`-seam and core change this card does not make — a per-exec log path plumbed through `ExecRequest`/`SpawnPlan`, created and unlinked outside a **pure** `spawnPlan`, and read back so cc still sees ssh's own text on stderr (MUST 1), which `-E` otherwise removes. Filed as card **2026-0011** |

So the residual is a **bounded, understood cost of not yet paying for `-E`**, not a wall. What the per-line anchor buys today is the reachable half: a chatty command, a mid-line occurrence and a mid-stream occurrence are all refused.

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
- **The residual exposure is a RACE, not a routine truncation — now scoped, and
  accepted rather than hardened.** The script's `[ -e "$p" ]` pre-check is a
  plain `test` that **no shell can ignore**, so a file that already exists when
  the write starts is refused whatever the target shell does about `noclobber`.
  That is pinned on the bytes themselves by `tests/ssh-live.test.mjs` →
  *"an exclusive write … leaves the bytes intact"*, which reads the file back
  **out of band** rather than trusting the refusal — asserting only the code
  would pass a build that truncated first and then refused.
  What `set -C` uniquely buys is the **check-then-act window**: a file created
  *between* the pre-check and the redirect. On a target shell that silently
  ignored `noclobber`, that window — and only that window — degrades to a
  truncating write, and nothing this plugin ships can detect it.
  Both kinds that reach a shell which is not ours now exercise `exclusive`
  against a real target (`node:24-slim`'s dash, `debian:13-slim`'s dash) and get
  `EEXIST`; that is two images, not a guarantee. Hardening `fileops.mjs`
  further was rejected: it is shared by every kind, and no measurement here
  calls its write primitive wrong. The tooling-baseline probe is where a
  per-target check would belong.

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

**Every refusal body is unwrapped from cc's `{"error":"<message>"}` envelope**
before it is shown. cc's shared router-tail handler answers every
`/api/settings/systems` failure in that shape and strips the `code` its internal
errors carry, so showing the body raw would put a JSON envelope where the rows
above promise cc's own words. The unwrap **falls back to the raw text** in both
directions that matter: a body that is not JSON at all (a proxy, a crash page)
and a JSON body with no `error` key. Pinned by `tests/registration.test.mjs`.

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
| `GET /api/kinds` | `{kinds:[{kind,label,configFields}], mirrorDefaults:{root,exclude}}` — the card UI's form definition, per registered kind, plus the Advanced group's prefill from `src/mirror.mjs`'s `DEFAULT_MIRROR`. `GET /api/health` keeps a **plain** kind-name list: a liveness probe has no use for descriptors or defaults |
| `GET /api/remotes` | every stored remote, each with a live `reachability`, a `baseline` and its `mirror`; an unreadable record appears as `{remoteId, broken:{reason,message}}` rather than being hidden. Its `kinds` field is the **descriptor array**, the same shape `GET /api/kinds` serves, and it carries the same `mirrorDefaults` |
| `POST /api/remotes` | create — validates the `remoteId` charset, delegates `config` to the kind, and validates `mirror` with `src/mirror.mjs` (**400**, message quoting the offending value and an exclude entry's index). An absent `mirror` stores `null`. Created **`enabled: false`**. 400 / 409 |
| `PATCH /api/remotes/:id` | edit everything **except** `remoteId`; a changed `config` resets `baseline` to `unknown` **and `enabled` to `false`**; a label-only edit preserves both. **A `mirror` change resets neither** — it names the same target — and an omitted `mirror` preserves the stored one. An invalid `mirror` is a 400 and writes nothing |
| `POST /api/remotes/:id/connect` | 200 `{remote}` — the kind's `connect` **first**, then the gate. 404 absent / 409 unreadable / **502** `{error, remote}` on a transport refusal |
| `POST /api/remotes/:id/disconnect` | 200 `{remote, warning?}` — the gate **first**, then the kind's `disconnect`. 404 / 409 as above |
| `DELETE /api/remotes/:id` | delete, **warning** when any cc project still names this `remoteId` |
| *(router tail)* | every response is JSON, including express's own body-parser refusals — the client reads `{error}` off every status |

**The two gate routes are deliberately asymmetric**, because enabling and
disabling carry different risks:

- **connect** runs the transport first and writes `enabled: true` only if it
  succeeded. On a throw the gate stays **off**: "enabled" must never mean
  "enabled but we could not".
- **disconnect** writes `enabled: false` first and then attempts the transport;
  a failure there is a `warning` on an otherwise-**200**. Disabling is a safety
  action and must not be blockable.

Both answer with a card from a **real re-probe**, so the response *is* the probe
rather than a claim. `refreshBaseline` is additionally gated on `enabled`: the
tooling probe is the one backend path that execs into a target and it bypasses
the launcher's gate entirely, so a disabled remote is never probed.

### Config values that become argv

A kind's `validateConfig` owns the shape of its `config`, and **every field that
ends up as an argv operand must reject a leading `-`** — `container`, `host`,
`user` today (`src/launcher/kinds/config.mjs`, shared by both kinds). A value
like `container: "-v /:/host"` or `host: "-oProxyCommand=..."` is read by the
far-side binary as an **option**, not an operand, turning a stored remote into
argument injection against `docker` or `ssh`.

**This is refused at the store's front door, not defended against in
`spawnPlan`** — `docker`'s `spawnPlan` builds argv from `container` and `ssh`'s
from `host`/`user`, and the rule had to hold before either existed. A validator
that accepts an
option-shaped value is a latent hole even while `spawnPlan` throws. Any new
config field a kind adds gets the same treatment.

(It is not a general escaping scheme, and it is precise about where a shell is
in play. For `host` and `docker` nothing validated here reaches a shell at all —
the core spawns argv directly and `fileops.mjs` quotes what it interpolates. For
`ssh` the remote command **is** tokenized by the target's login shell, which is
why `kinds/ssh.mjs` quotes every token it interpolates and hands ssh one argv
element. Either way this rule is about the **argv/option boundary**: a leading
`-` in a stored `host`/`user` is an option to the *local* ssh client, before any
remote shell exists.)

### `remoteId`

`remoteId` charset: `^[a-z0-9][a-z0-9._-]{0,63}$`, never `.` or `..`. It is both
a filename stem and the entire hand-off contract to a cc project's *Remote*
field, so it must be human-typable and is **never renamed** once created — which
is why the delete route warns: cc has no `listRemotes` frame, so nothing else
would tell the user which projects they just stranded.
