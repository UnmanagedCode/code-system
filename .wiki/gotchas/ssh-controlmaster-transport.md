# What `ssh` actually does (measured)

All of this was measured against **OpenSSH_10.0p2 Debian-7+deb13u4 / OpenSSL
3.5.6** on 2026-09-04, from this devcontainer against a `debian:13-slim` sshd
container (`tests/fixtures/sshbox/Dockerfile`). None of it can be re-derived
from our code, and **four of the facts contradict a reasonable assumption** —
one of them contradicted the card's own plan.

This page is the sole home of the ssh MEASUREMENTS. The normative contract they
justify lives in `docs/protocol.md` → "`ssh` — what goes on the wire"; the
design they shape lives in `docs/architecture.md` → "The ssh ControlMaster
transport". Neither repeats a measurement, and this page does not repeat their
rules.

## 1. Exit 255 on its own classifies NOTHING

This is the load-bearing negative result, and every `classifyFailure` row in
`kinds/ssh.mjs` exists in the shape it does because of it.

| invocation | exit | stream | text |
|---|---|---|---|
| `-O check`, no master | **255** | stderr | `Control socket connect(/tmp/x): No such file or directory` |
| `-O exit`, no master | **255** | stderr | same |
| unreachable bridge IP | **255** | stderr | `ssh: connect to host 172.17.0.99 port 22: No route to host` |
| `-p 1 127.0.0.1` | **255** | stderr | `ssh: connect to host 127.0.0.1 port 1: Connection refused` |
| unresolvable name | **255** | stderr | `ssh: Could not resolve hostname no-such-host-xyz.invalid: Name or service not known` |
| leading-dash host, with `--` | **255** | stderr | `hostname contains invalid characters` |
| wrong key | **255** | stderr | `root@172.17.0.5: Permission denied (publickey).` |
| unknown host key | **255** | stderr | `Host key verification failed.` |
| **the remote command's own `exit 255`** | **255** | — | *(the command's own output)* |

**ssh forwards a remote command's exit status verbatim**, so the last row is
indistinguishable by code from every row above it. Hence: no row may be guarded
on the exit code alone. Every one is guarded on ssh's own wording **plus an
empty stdout**.

Two wordings do **not** open stderr, and a `startsWith` guard on either is a
bug that shipped once and was caught by the live suite:

- `Permission denied (publickey).` is prefixed with `<user>@<host>: `.
- `Host key verification failed.` is prefixed — **when the operator's config
  requests strict checking explicitly** — by `No ED25519 host key is known for
  <ip> and you have requested strict checking.`, and **both lines are written
  with CRLF**. With the default (`ask`) it is that second line alone, with LF.
  Both shapes are in `tests/sshkind.test.mjs`.

**And the auth prefix names the RESOLVED host, not the configured alias.**
Measured with `Host my-alias-not-the-ip` / `HostName 172.17.0.5`: ssh printed
`root@172.17.0.5: Permission denied (publickey).`, containing no trace of the
alias. So a provider that tried to anchor this row on its own
`<user>@<host>` — the obvious way to tell our auth failure from a nested ssh's —
would **reject its own genuine refusal on every alias-based remote**, i.e. on
the shipped default shape. `docs/protocol.md` records the resulting limitation.

**`ssh -E <log_file>` DOES separate our own diagnostics from the remote
command's.** Measured against the fixture, both arms:

| arm | stderr | the `-E` log |
|---|---|---|
| our own auth fails (wrong key) | **empty** | carries `Permission denied (publickey).` |
| a nested `ssh` inside the remote command fails | carries `root@127.0.0.1: Permission denied (publickey).` | **nothing** |

So the classifier's inability to tell them apart is a property of the three
fields it is given, not of ssh. Note the cost the measurement also shows: with
`-E`, arm A's stderr is EMPTY, so cc would surface no ssh text at all unless the
log is read back. Card 2026-0011.

`env` refusing to start the command uses **two** exit codes, measured
separately, both on stderr with an empty stdout:

| invocation | exit | text |
|---|---|---|
| `env --chdir=/tmp -- nosuchbinary-xyz` | **127** | `env: 'nosuchbinary-xyz': No such file or directory` |
| `env --chdir=/nope-xyz -- /bin/true` | **125** | `env: cannot change directory to '/nope-xyz': No such file or directory` |

A classifier anchored on 127 alone reports a bad cwd as a command that ran and
exited 125.

## 2. `ssh` takes a SHELL STRING, not an argv

The single biggest divergence from `docker exec`. Everything after the
destination is joined with spaces and **re-parsed by the remote user's login
shell**. Measured:

```
ssh … -- <dest> /bin/sh -c 'pwd; echo $CC_REMOTE'
  → /tmp
  → (empty)          # `echo $CC_REMOTE` ran in the LOGIN shell, where it is unset
```

The quoting was lost in the join: the far side received
`/bin/sh -c pwd; echo $CC_REMOTE` and ran two commands. The same command as
**one** already-quoted argv element instead:

```
ssh … -- <dest> "'/usr/bin/env' '--chdir=/tmp' '--' 'CC_REMOTE=r1' '/bin/sh' '-c' 'pwd; echo $CC_REMOTE; echo $0'"
  → /tmp
  → r1
  → /bin/sh
```

`docs/protocol.md` owns the rule and the one-tokenization-step sentence these
two measurements justify.

## 3. The `--` terminator, and the hijack without it

| invocation | exit | stderr |
|---|---|---|
| `ssh -F /dev/null -o ControlPath=none -- -badhost true` | 255 | `hostname contains invalid characters` |
| **control**, terminator removed | 255 | `ssh: Could not resolve hostname true: Name or service not known` |
| control, ordinary host: `… -- 172.17.0.99 true` | 255 | `ssh: connect to host 172.17.0.99 port 22: Connection timed out` |

Without `--`, ssh read `-b` as an option, swallowed `adhost`, and **the command
`true` became the hostname**. Both branches exit 255, which is why the pinning
test asserts the pure plan's argv and never runtime stderr. (`ssh` 10.0p2 also
rejects such a hostname itself — version-dependent, and not ours to rely on.)

## 4. THE CONTROL DIRECTORY: `auto` binds, `no` does not

**This is the measurement that contradicted the plan.** `ssh_config(5)` says a
slave "will fall back to connecting normally if the control socket does not
exist" — and that is true of a missing **socket**. It is NOT true of a missing
**directory**, because `ControlMaster=auto` must still *bind* one:

| ControlMaster | control dir | result |
|---|---|---|
| `auto` | **absent** | **exit 255**, `unix_listener: cannot bind to path /…/sock.XXXX: No such file or directory` |
| `no` | **absent** | **exit 0** — the command runs, and nothing is created |
| `auto` | present, no socket | exit 0, and the master socket is created |
| `no` | present, socket live | exit 0, multiplexed |

The plan assumed the first row degraded gracefully and therefore that
`ensureControlDir()` could be deferred to the async methods. It does not, so a
first `exec` against a fresh remote would have failed — `spawnPlan` is pure, so
nothing on the exec path may create the directory.

**Hence every operation carries `ControlMaster=no` and only `connect` carries
`yes`.** `no` is not "don't multiplex": it is "use a master if one exists, never
create one", which is exactly what a pure exec path needs.

## 5. `ControlMaster=no` really does multiplex — and the control that proves it

The only honest discriminator is **sshd's own authentication count**
(`sshd -D -e` → `docker logs`, `Accepted publickey`). "The command worked" is
what an unmultiplexed run also looks like.

| sequence | authentications |
|---|---|
| `-o ControlMaster=yes -N -f` (start the master) | **1** |
| then 5 execs at `-o ControlMaster=no` | **0 more** — socket inode unchanged |
| **control:** 5 execs at `ControlPath=none` | **5** |

## 6. NEVER EMIT `-M`: doubling it means `ask`

Effective values read out of the client itself with `ssh -G`:

| invocation | effective `controlmaster` |
|---|---|
| `-o ControlMaster=yes` | `true` |
| `-M` | `true` |
| `-M -M` | **`ask`** |
| `-M -o ControlMaster=yes` | `true` (the `-o` is ignored — first value wins) |
| **`-o ControlMaster=yes -M`** | **`ask`** |

The last row is the hazard, and it is the argv order a shared option block
followed by an appended flag produces. `ask` cannot be answered under
`BatchMode=yes`. So `kinds/ssh.mjs` emits `-o ControlMaster=…` only, from one
builder, and never `-M`.

## 7. The defaults each of our options actually changes

`ssh -G` with no options, so every `-o` in `sshBaseArgs` is doing work:

```
batchmode no          connecttimeout none      controlpersist no
controlmaster false   requesttty auto          stricthostkeychecking ask
```

`stricthostkeychecking ask` is the one the **known_hosts policy** rests on:
combined with `BatchMode=yes`, an unknown or changed key **fails** rather than
prompting or trusting on first use. That is why we set neither
`StrictHostKeyChecking` nor `UserKnownHostsFile` — the policy is that
interaction, not an omission. `docs/features.md` states the policy for a user.

## 8. `-T` is load-bearing, and only `RequestTTY force` shows it

We honour the operator's own ssh config, so a `RequestTTY` in it reaches us.
Measured with `printf 'CCSTAT 81a4 12\n'` on the far side:

| operator config | our flags | bytes back |
|---|---|---|
| `RequestTTY force` | *(none)* | `CCSTAT 81a4 12\r\n` — **CR injected** |
| `RequestTTY force` | `-T` | `CCSTAT 81a4 12\n` |
| `RequestTTY yes` | *(none)* | `…\n` — **does not reproduce** |

`RequestTTY yes` declines a pty when stdin is not a terminal (ours never is), so
a test written against `yes` proves nothing. The `\r` would corrupt
`fileops.mjs`'s `CCSTAT <mode> <size>` header parse, which reads the first line.

## 9. `-O check` / `-O exit` speak on STDERR

| invocation | exit | stdout | stderr |
|---|---|---|---|
| `-O check`, live master | **0** | *(empty)* | `Master running (pid=2065823)` |
| `-O check`, no master | 255 | *(empty)* | `Control socket connect(<path>): No such file or directory` |
| `-O exit`, live master | **0** | *(empty)* | `Exit request sent.` |
| `-O exit`, again | 255 | *(empty)* | `Control socket connect(<path>): No such file or directory` |

So the fingerprint is **not** parsed out of `Master running (pid=…)`: it is on
the wrong stream to be convenient and a pid can repeat. The socket's
inode+ctime is used instead — the recipe already locked in
[baseline-probe-two-tier.md](baseline-probe-two-tier.md).

The last row is what makes `disconnect` idempotent: "already closed" is the
requested state.

**Every cold shape shares one prefix**, which is why `disconnect`'s guard reads
only that and never the strerror tail. `-O exit` does not dial, so none of these
depend on the host being up:

| ControlPath state | exit | stderr |
|---|---|---|
| control **directory** absent | 255 | `Control socket connect(<p>): No such file or directory` |
| directory present, socket absent | 255 | the same |
| ControlPath exists as a **regular file** | 255 | `Control socket connect(<p>): Connection refused` |
| ControlPath exists as a **directory** | 255 | the same |

A regular file or a directory sitting at the ControlPath therefore reads as
"already disconnected" — correctly: there is no master there, which is the
requested state, and clearing stray files is not `disconnect`'s job.

## 10. A remote command survives its killed client

MEASURED, not inferred: started `ssh … -- <dest> 'sleep <marker>'`, SIGKILLed
the local ssh client, and the remote `sleep` was **still running** afterwards
(counted in the target's `/proc`). This is the whole reason `Transport.reap`
exists for this kind, and it is why every reap test needs the negative control
first — see [kill-relay.md](kill-relay.md).

## 11. Odds and ends that shape the code

- **`sun_path` is 108 bytes including the NUL**, so 107 are usable for a
  ControlPath. `TMPDIR` is caller-controlled, and a truncated path is a
  *different* socket for the launcher than for the backend — so
  `controlPathFor` refuses past its own limit rather than truncating or falling
  back to a second formula.
- **`ssh -V` writes its banner to STDERR** and exits 0. A gate reading stdout
  only would skip the live suite on a machine with a perfectly good client.
- **`env -i` is the replacement mechanism and `HOME` is the discriminator**,
  same as docker: inherit → `HOME=/root`, `PATH` the target's; replace →
  `HOME` **UNSET**, `PATH` exactly what was sent. An overlay cannot produce
  UNSET.
- **This shell does not word-split unquoted expansions.** An `ssh $OPTS …` in a
  hand-run measurement arrives as ONE argv element and ssh answers
  `unknown option -- ` (note the trailing space: `optopt` is a space). That is a
  measurement artifact, not an ssh behaviour — it cost one wrong conclusion
  about `--` before the control was run. Use explicit argv when measuring here.
- **`debian:13-slim` passes our tooling baseline** (`parseProbeOutput` → `ok`,
  no missing capabilities), which is why the fixture is not Alpine: busybox
  fails four capabilities and `fileops` would be gated off, making the live
  suite vacuous.

See also: [kill-relay.md](kill-relay.md),
[exec-env-across-a-boundary.md](exec-env-across-a-boundary.md),
[baseline-probe-two-tier.md](baseline-probe-two-tier.md),
[docker-exec-transport.md](docker-exec-transport.md).
