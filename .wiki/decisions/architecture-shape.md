# Locked architecture decisions

These are locked for this plugin. Implementation should conform to this shape, not re-derive it.

- **One cc System row per provider KIND, not per remote.** Two rows total: `docker` and `ssh`. Each advertises `remotes:true`. See [gotchas/no-remote-discovery.md](../gotchas/no-remote-discovery.md) for why the remote catalog lives entirely in this plugin's UI instead.
- **System is a transport, not the remote system.** The cc System row is just how cc reaches a target; the actual remote/`remoteId` is the real unit of identity, configured per `remoteId`.
- **Ownership split:** the launcher owns execution (spawning `docker exec`/`ssh`, relaying I/O, killing children — see [gotchas/kill-relay.md](../gotchas/kill-relay.md)); the backend owns config storage and the UI.
- **Attach-only connect toggle.** Connecting to a remote in the UI never starts or stops a container — it only attaches to something already running.
- **No MCP surface in v1.** The plugin exposes its functionality through the System providers and the card UI only, not an MCP server.
- **No long-lived shell, for any kind.** The protocol has none — it is not a capability and there are no `stdin`/`stdinClose` frames. Every redirected shell command is a one-shot `exec`, and **nothing carries over, not even cwd**. See [gotchas/no-persistent-shell.md](../gotchas/no-persistent-shell.md).
- **No per-remote shell, and no shell in the handshake.** cc's hello has no `system` descriptor at all, so there is nothing to answer and nothing to store. Don't probe for a shell, don't make one configurable, and **don't reintroduce a per-remote `shell` field or a per-kind `defaultShell`**.
- **File movement rides `exec`, not `docker cp`/`scp`.** See [gotchas/file-ops-over-exec.md](../gotchas/file-ops-over-exec.md).
- **Capabilities are cc's three keys and no more** — `processGroupSignal`, `remotes`, `remoteDescriptors`. Per-kind constants on `Transport` (`remotes` is `true` always for `docker`/`ssh`), except on `host`, where they are derived from launch flags. See [gotchas/host-kind-and-conformance.md](../gotchas/host-kind-and-conformance.md).
- **`docker` advertises `processGroupSignal: false`, and that is a decision, not a stub.** It is achievable; raising it would oblige a whole signal-relay seam for a capability whose only consumer means "kill the command". Both measurements that would let a later card revisit it from a known position are in [gotchas/docker-exec-transport.md](../gotchas/docker-exec-transport.md) §3.
- **`docker` is attach-only and it is ENFORCED, not remembered.** `ALLOWED_SUBCOMMANDS` (`src/launcher/kinds/docker.mjs`) is `exec` and `inspect`; every docker invocation the provider makes goes through a guard that throws otherwise. Test fixtures may `run`/`stop`/`rm`; the provider never may.
