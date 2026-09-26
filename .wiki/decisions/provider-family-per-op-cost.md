# The provider family sets the per-op cost model

**What:** which family of provider serves a System decides whether fine-grained
file ops are affordable. The two families sit on opposite sides of the remote
boundary, and trade remote dependencies against per-op cost.

Cross-references: [docker-channel.md](../gotchas/docker-channel.md) and
`docs/architecture.md` → "The held-open channel" (the measured spawn cost and the
channel that removes it for `docker`),
[channel-admission-is-proof.md](channel-admission-is-proof.md) (what may ride
it), [file-ops-over-exec.md](../gotchas/file-ops-over-exec.md),
[no-persistent-shell.md](../gotchas/no-persistent-shell.md).

## The two families

| family | runs | target needs | per-op cost |
|---|---|---|---|
| cc's reference provider (cc's `src/systems/referenceProvider.ts`, NDJSON over stdin/stdout) | **inside** the remote | node, `/bin/bash`, git, GNU coreutils/findutils | one message on a persistent stream |
| this plugin's `docker` / `ssh` kinds | **outside** the remote | nothing installed | one process spawn per op, unless the kind holds a channel |

`docker` holds a channel; `ssh` and `host` still spawn on every op. Where a
config row can be pinned to one container, the in-container reference provider is
the config-only way to get a persistent stream.

## Bounded by op COUNT, not per-op RTT

A per-op spawn's cost is set by **how many ops a turn issues**, not by the RTT
alone. Bash forwarding tolerates one spawn per command because commands are
coarse. File ops are finer, but when only the project tree and the files a
session's Read/Write/Edit calls name reach the remote, that is tens of ops per
turn against a turn dominated by model and network time — affordable, which keeps
the outside-running families (and their zero remote dependencies) in play.

What breaks that: **anything that enumerates.** `Glob`/`Grep`, an `LS`-style
lister or a directory walk turns a per-file cost into a per-ENTRY cost. And any
file transport must move a whole file per round trip — fragmenting a large file
into fixed-size chunk ops brings the spawn cost back.

## A per-op spawn is the provider's choice, not a protocol tax

cc sends one frame per op down one persistent pipe, and §4 of cc's
`docs/systems-protocol.md` says a provider must interleave ids rather than
serialise cc behind one slow command. A kind that spawns per frame is declining
an affordance the protocol already gives it.

Corollary for any "expose file ops as a typed capability" proposal: cc's typed
`readFile`/`writeFile` frames already exist, and this plugin derives both over
`exec` anyway ([file-ops-over-exec.md](../gotchas/file-ops-over-exec.md)), so
typed frames inherit the spawn cost. Of the latency, **~96 % is transport**
(83 ms → ~3 ms, spawn vs channel) and **~3 % is frame typing** (~3 ms → ~0.3 ms).
The typing figure was measured locally, n=200: the `find`-based `lstat`
derivation costs 4.2 ms, of which 2.5 ms is bare fork+exec, against 0.005 ms for
the `lstat` syscall. Fix the transport; the frame shape is the last 3 %.

## How to apply

- **Measure ops-per-turn before per-op RTT.** An RTT is only a verdict once paired
  with the count; a design rejected on RTT alone skipped the question that
  decides it.
- **Ask per family, not once.** `ssh` has a real fine-grained file protocol that
  needs nothing installed remotely (SFTP, what sshfs is built on); `docker`'s
  archive API is tar-granular, so a `docker` target realistically needs an
  in-container agent (possibly far smaller than the reference provider) or a
  held channel, or it pays the spawn.
- **Treat "no remote dependencies" as a claim about the exec path only.** It is
  what the outside-running families are for, and a new channel added beside them
  does not inherit it automatically — the `docker` channel keeps it only because
  it execs a `/bin/sh` the container already has.
