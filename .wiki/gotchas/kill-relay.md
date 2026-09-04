# The provider must relay the kill

**What:** cc's protocol MUST 3 requires a provider to exit on stdin EOF and take everything it started down with it. A `docker exec` child is reparented inside the container's namespace, and an `ssh` slave connection similarly outlives its parent — neither dies on its own when the provider process exits.

**Why:** Without explicit action, stdin-EOF only kills the provider process itself; the `docker exec` child and any orphaned `ssh` control-master/slave connections keep running, leaking processes inside the container/on the remote host and violating MUST 3.

**MEASURED, not inferred** (Docker Engine 29.7.2, 2026-09-04): started
`docker exec <ctr> sh -c 'sleep …'` from a host process, SIGKILLed that host
process, and the `sleep` was still running in the container afterwards. See
[docker-exec-transport.md](docker-exec-transport.md) §1.

**How to apply:** The provider's shutdown path must explicitly SIGKILL every child it started (`docker exec` children, `ssh` slaves) before or as part of exiting on stdin EOF. This is not optional cleanup — it's a protocol MUST.

**It fires at FOUR sites, not two.** `close` and provider shutdown are the
obvious ones. A **`timeoutMs` expiry** and a **`signal` frame** are the same case
— `Session.#terminate` kills the host-side proxy while the far side keeps running
— so `#terminate` sets `state.terminated` and the child's `close` handler reaps
when it is set. Without that, the launcher reports `{code:124, timedOut:true}`
(cc's own "the provider killed it") for a command still running in the container.
A command that exited **on its own** is still not reaped; that rule stands.

**`docker` reaps by TOKEN, not by pgid.** Every `docker exec` carries
`CC_EXEC_TOKEN=<per-exec nonce>` in the container process's environment; `reap`
sends one bounded `docker exec … /bin/sh -c` that SIGKILLs every process whose
`/proc/<pid>/environ` contains it. Children inherit an environment, so one pass
reaches the whole subtree with **no discovery step**, and it survives a
descendant that called `setsid` — which a group kill does not. Its own failure
mode (a descendant that scrubs its environ) is narrower than the group's. Use
only `tr` and shell built-ins: `node:24-slim` has no `ps`. The reap exec carries
**no** token itself, so it cannot kill itself. ~121 ms per handle, measured.

**A test of any of this needs the negative control first** — see
[docker-exec-transport.md](docker-exec-transport.md) §1.
