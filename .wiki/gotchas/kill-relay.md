# The provider must relay the kill

**What:** cc's protocol MUST 3 requires a provider to exit on stdin EOF and take
everything it started down with it. **A `docker exec` child does not die with
its host-side client** — it is a process inside the container, started by the
daemon on the provider's behalf and never an OS descendant of the provider at
all, so nothing about the provider's death reaches it. An `ssh` slave connection
outlives its parent in the same spirit for its own reasons.

**MEASURED, not inferred** (Docker Engine 29.7.2, 2026-09-04): started
`docker exec <ctr> sh -c 'sleep …'` from a host process, SIGKILLed that host
process, and the `sleep` was still running in the container afterwards. See
[docker-exec-transport.md](docker-exec-transport.md) §1.

**Why it matters:** without explicit action, stdin-EOF kills only the provider
process; the container-side subtree and any orphaned `ssh` control-master/slave
connections keep running, leaking processes on the target and violating MUST 3.

**How to apply:** The provider's shutdown path must explicitly SIGKILL every child it started (`docker exec` children, `ssh` slaves) before or as part of exiting on stdin EOF. This is not optional cleanup — it's a protocol MUST.

**The held-open channel does not weaken this, and it needs no relay of its own.**
A shell *blocked on a `docker exec`'s stdin* DOES die with its host client — the
opposite of the measurement above, and both are true. Each op on that channel
still carries its own `CC_EXEC_TOKEN` and is still reaped by this relay,
unmodified. See [docker-channel.md](docker-channel.md) §2 and §5.

**It fires at FOUR sites, not two.** `close` and provider shutdown are the
obvious ones. A **`timeoutMs` expiry** and a **`signal` frame** are the same case
— `Session.#terminate` kills the host-side proxy while the far side keeps running
— so `#terminate` sets `state.terminated` and the child's `close` handler reaps
when it is set. Without that, the launcher reports `{code:124, timedOut:true}`
(cc's own "the provider killed it") for a command still running in the container.
A command that exited **on its own** is still not reaped; that rule stands.

**BOTH KINDS reap by TOKEN, from ONE script** —
`src/launcher/kinds/reapscript.mjs`, extracted when `ssh` landed because the
mechanism and the reason are identical. `ssh`'s premise is measured too: SIGKILL
the local ssh client and the remote command is still running
([ssh-controlmaster-transport.md](ssh-controlmaster-transport.md) §10), so its
live suite runs that negative control first, exactly as docker's does.

**`docker` reaps by TOKEN, not by pgid.** Every `docker exec` carries
`CC_EXEC_TOKEN=<per-exec nonce>` in the container process's environment; `reap`
sends one bounded `docker exec … /bin/sh -c` that SIGKILLs every process whose
`/proc/<pid>/environ` contains it. Children inherit an environment, so one pass
reaches the whole subtree with **no discovery step**, and it survives a
descendant that called `setsid` — which a group kill does not. Its own failure
mode (a descendant that scrubs its environ) is narrower than the group's. Use
only `tr` and shell built-ins: `node:24-slim` has no `ps`. The reap exec carries
**no** token itself, so it cannot kill itself. ~121 ms per handle, measured.

**THE RELAY MUST PROVE IT RAN.** Without `tr`, or on a target whose
`/proc/<pid>/environ` cannot be read, every `case` matches nothing and an
unconditional `exit 0` reports a successful reap while the container-side subtree
survives — the MUST-3 hazard itself, made invisible, and `baselineRefusal` does
not gate `reap` the way it gates exec and fileops. So the script counts how many
environs it could read and answers `CCREAP blind` / exit 3 when that is zero; the
scanning process is itself in `/proc` and can always read its own environ, so
zero is unambiguous. `Transport.reap` throws when it cannot see a `CCREAP ok`
line, and `session.#reap` **reports** that on stderr rather than swallowing it —
without taking the connection down, because one target's leftovers are not a
dead session. The single benign failure is the container being gone or stopped:
its processes went with it, so that is recognised (through the same
`classifyFailure` the exec path uses) and stays quiet.

**A test of any of this needs the negative control first** — see
[docker-exec-transport.md](docker-exec-transport.md) §1.
