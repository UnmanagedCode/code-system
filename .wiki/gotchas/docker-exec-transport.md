# What `docker exec` actually does (measured)

All of this was measured against **Docker Engine 29.7.2** on 2026-09-04, against
a `node:24-slim` container and `busybox:1.38.0` — except §7, measured against the
same engine and image on **2026-09-14**. None of it can be re-derived
from our code, and three of the facts contradict a reasonable assumption.

## 1. A `docker exec` child does not die with its host client

It is not the client's child at all: the daemon starts it inside the container on
the client's behalf, so the client is a *proxy* for its I/O and exit status, not
its parent. SIGKILL the host-side `docker exec` process and the container process
**keeps running**. This is the whole reason `Transport.reap` exists for this kind
(see [kill-relay.md](kill-relay.md)).

It is also why every reap test needs a **negative control**: without one, a test
asserting "nothing is left running" passes even when `reap` does nothing, because
a kind whose children died with their proxy would need no relay at all.
`tests/docker-live.test.mjs` runs that control first.

## 2. A never-started command reports on STDOUT; a daemon refusal on STDERR

| Situation | Exit | Stream | Text |
|---|---|---|---|
| container does not exist | 1 | **stderr** | `Error response from daemon: No such container: <name>` |
| container exists, not running | 1 | **stderr** | `Error response from daemon: container <64-hex id> is not running` |
| binary not in the container | **127** | **stdout** | `OCI runtime exec failed: exec failed: unable to start container process: exec: "<argv0>": executable file not found in $PATH` |
| `-w` names a missing directory | **127** | **stdout** | `OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("<cwd>") set in config.json failed: no such file or directory` |
| `-w` is not absolute (incl. a leading `-`) | **128** | **stdout** | `OCI runtime exec failed: exec failed: Cwd must be an absolute path` |
| socket not permitted | 1 | stderr | `permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: …` |
| daemon absent (`DOCKER_HOST` bad) | 1 | stderr | `Cannot connect to the Docker daemon at <addr>. Is the docker daemon running?` |
| the command's own exit code | verbatim | — | `sh -c 'exit 42'` → 42 |

**Rows 3–5 are the surprise.** A never-started command's diagnostic arrives
on the channel the *command's own output* uses — so a classifier reading only
stderr is blind to it, and `fileops`' header parse sees the text where it expects
`CCSTAT`. Note also that the daemon rows name the **64-hex container id**, not
the name the remote was configured with; our message says both.

Note also that the three never-started rows share only the stem
`OCI runtime exec failed: exec failed: ` — the `unable to start container
process: ` segment is **absent** from the `Cwd must be an absolute path` row, and
that row exits **128**, not 127. A classifier anchored on the longer prefix, or
on 127 alone, reports a command that never started as one that ran and exited.

The classifier that reads this table is `classifyFailure` in
`src/launcher/kinds/docker.mjs`; the guards that stop a command forging a verdict
are documented there.

## 3. `processGroupSignal` could be `true`, and is deliberately `false`

Two measurements, recorded so a later card can raise the flag from a known
position rather than re-deriving it:

- **`setsid` is unnecessary**, contradicting `systems-protocol.md` §11 item 2,
  which names it as the prerequisite. A `docker exec`'d process is **already its
  own process-group and session leader**: `/proc/<pid>/stat`'s ppid, pgrp and
  session fields all equal its own pid. (`setsid` is also not in §1's POSIX
  baseline, so requiring it would raise the bar on every target.)
- **§11's own recipe does not work on a Debian-family container.** With dash as
  `/bin/sh`:

  | form | result |
  |---|---|
  | `kill -9 -- -<pgid>` | `sh: 1: kill: Illegal number: -`, exit 2, **nothing killed** |
  | `kill -KILL -- -<pgid>` | same |
  | `kill -9 -<pgid>` | **works** — the whole group died |

Why it still ships as `false`: advertising `true` obliges **signal fidelity**
(§5: "delivers exactly that signal"), which means a new `Transport.signal` seam
relaying into the container plus a SIGTERM→SIGKILL backstop across a round trip —
for a capability whose only consumer at cc `8b7b10bf` is one call site meaning
"kill the command". `false` costs nothing: the core sets
`descendantsMaySurvive: true` on every exit it terminated, and the token reap
SIGKILLs the container-side subtree regardless. Advertising `true` falsely is,
in §11's words, "the one lie this protocol cannot detect".

## 4. `env -i` is the replacement mechanism, and HOME is the discriminator

```
docker exec -- <ctr> env -i -- PATH=/usr/bin /bin/sh -c 'echo ${HOME-UNSET}'  → UNSET
docker exec -- <ctr>                         /bin/sh -c 'echo ${HOME-UNSET}'  → /root
```

An overlay of `-e` flags **cannot produce `UNSET`** — which is exactly why
`HOME` is what the live test asserts on. An `-e`-based "replacement" passes every
other assertion in that test.

### `env -i --` — the operand boundary is not optional

Frame-supplied env **keys** are arbitrary strings, and GNU `env` reads
leading-`-` operands as **its own options** until it meets a non-option operand.
Measured in `cc-box` (coreutils 9.1) with `-w /`:

| invocation | result |
|---|---|
| `env -i    '--chdir=/tmp' PATH=/usr/bin pwd` | `/tmp` — **the cwd is hijacked** |
| `env -i -- '--chdir=/tmp' PATH=/usr/bin pwd` | `/` — the `-w` holds |
| `env -i '--argv0=EVIL' sh -c 'echo $0'` (coreutils **9.7**) | `EVIL` — `$0` spoofed |
| `env -i '--argv0=EVIL' …` (coreutils **9.1**) | `env: unrecognized option`, exit 125 — the exec dies |

So the same frame either silently relocates the command while cc believes it ran
at the `cwd` it sent, or kills the exec outright — depending on the image's
coreutils. **Emit `env -i --` unconditionally.** Validating keys would not close
the class: the option set belongs to GNU `env`, not to us. `--ignore-signal=` is
in the same family.

The **`-e` inherit path is unaffected** — measured, not assumed: `docker exec -e`
takes its value as a separate argv token, so `-e '--chdir=/tmp=x' -w /` still
runs at `/`.

Two further consequences for `spawnPlan`:

- In the replacement case, emit **no** `-e` flags: `env -i` would wipe them, so
  `CC_REMOTE`/`CC_EXEC_TOKEN` must be operands of `env -i` instead.
- Name the interpreter **absolutely** (`/bin/bash`, `/bin/sh`). Under `env -i` an
  unqualified name depends on the frame's PATH, not the container's.

Under `env -i` with a PATH that resolves nothing, `/bin/bash -lc` still works
because `/etc/profile` re-sets PATH — but it first prints
`/etc/profile: line 4: id: command not found` on **stderr**. Harmless for a
redirected shell command (cc's framing discards both streams up to its opening
sentinel), but it appears in a raw `exec`'s stderr.

## 5. `-i` iff the frame asked for a pipe

`printf 'aGVsbG8=' | docker exec -i -- <ctr> sh -c 'base64 -d'` → `hello`, exit 0:
host stdin is forwarded **and EOF propagates**. Without `-i`,
`docker exec -- <ctr> sh -c 'cat; echo ok'` returns immediately — the container
process sees an already-closed stdin. That is §5's `stdin: 'pipe' | 'ignore'`
distinction exactly.

**A dropped `-i` fails silently in the worst possible way**: `writeFile`'s
`base64 -d` sees immediate EOF and writes a **zero-byte file with exit 0**. A
test asserting only mode and success passes; only a content round-trip catches it.

## 6. Odds and ends that shape the code

- Flags after the container name are **not** eaten by docker
  (`docker exec <ctr> git --no-pager --version` works), and `docker exec -- <ctr>`
  is accepted. We use `--` anyway: it is free and makes the operand boundary
  explicit.
- `docker inspect --type container --format '…' -- <name>` is valid.
  `--type container` matters: without it an identically-named **image** can
  answer. Running → `true <image-sha> <RFC3339 StartedAt>`, exit 0.
  Created-but-never-started → `false <image> 0001-01-01T00:00:00Z`, **exit 0**.
  Missing → exit 1 with row 1's text.
- **`node:24-slim` has no `ps`.** Any in-container process assertion must read
  `/proc`. It does have `grep tr git base64 setsid find stat realpath bash`.
- **Timings** through `sudo -n docker`: `docker exec true` **106 ms**, the full
  `/proc` token-scan reap script **121 ms**, `docker inspect` **43 ms** — all
  comfortably inside `REAP_DEADLINE_MS` (`src/launcher/session.mjs`) = 1500.
- **On this host the socket is root-owned**, so unprivileged `docker` fails with
  the permission row. `sudo -n docker` works, and a uid-1000 process **can**
  SIGKILL its own `sudo -n docker exec` child.
- **A `which docker` gate is wrong here**, for the same reason: unprivileged
  `docker version` still prints its whole Client block to **stdout** and exits 1.
  Ask for the **server** version.

## 7. `-u` and the identity a remote acts as

`docker exec -u <value>` is what the card's **Run as** field
(`config.user`, docker only) becomes. Measured 2026-09-14:

| `-u` value | Result |
|---|---|
| `node`, `1000`, `node:node` | exit 0, runs as uid 1000 |
| `9999:9999` | **exit 0** — a uid with **no `/etc/passwd` entry is accepted** and runs |
| `nosuchuser` | exit **1**, stdout **empty**, stderr `Error response from daemon: unable to find user nosuchuser: no matching entries in passwd file` |
| `root:nosuchgroup` | exit **1**, stdout empty, stderr `Error response from daemon: unable to find group nosuchgroup: no matching entries in group file` |
| `no such` (a space) | the same daemon refusal — the form's shape rule only moves that refusal earlier |

**Two non-obvious consequences.**

- **There is nothing cheap to pre-validate.** Because `-u 9999:9999` succeeds, a
  connect-time probe could only catch the missing-passwd-entry case — which the
  per-operation refusal already names verbatim. Combined with
  `tests/kindmeta.test.mjs`'s "docker connect invokes docker **zero** times"
  (the attach-only decision in its strongest form) and `reachability` being a
  daemon query that never enters the container, the identity is checked **per
  operation** and nowhere else.
- **The reap script run as an unprivileged user is NOT blind.** Measured:
  `docker exec -u node … <reapscript>` answers `CCREAP ok 0 1`, not
  `CCREAP blind` — a process can always read its own `/proc/<pid>/environ`, so
  the `readable` count is never 0. It *does* leak
  `cannot open /proc/1/environ: Permission denied` lines on **stderr**, which
  `reap` ignores because it reads stdout. So `reap` can and must carry `-u`: it
  kills by uid ownership, and relaying as the image default would silently fail
  to kill a subtree owned by the configured user.

**A joined short flag parses identically.** `-unode` runs as uid 1000, and
`-u-rm` means the identity `-rm`, exactly as the separated `-u -rm` does. So
emitting `['-u', value]` as two argv elements is a convention (it matches the
`-w`/`-e` pairs and keeps the value assertable on its own) — it is **not** what
makes a leading-dash value inert, and a leading dash is refused by the kind's
`IDENTITY_RE`, not by the argv shape.

`docker inspect` deliberately gets **no** `-u`: it never enters the container and
has no such flag. See `src/launcher/kinds/docker.mjs` for all three sites.

See also: [exec-env-across-a-boundary.md](exec-env-across-a-boundary.md),
[kill-relay.md](kill-relay.md),
[baseline-probe-two-tier.md](baseline-probe-two-tier.md),
[docker-channel.md](docker-channel.md) — the held-open channel that removes the
per-frame spawn these measurements are about, and the five further measurements
it needed.
