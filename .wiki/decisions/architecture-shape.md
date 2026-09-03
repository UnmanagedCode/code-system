# Locked architecture decisions

These are locked for this plugin. Implementation should conform to this shape, not re-derive it.

- **One cc System row per provider KIND, not per remote.** Two rows total: `docker` and `ssh`. Each advertises `remotes:true`. See [gotchas/no-remote-discovery.md](../gotchas/no-remote-discovery.md) for why the remote catalog lives entirely in this plugin's UI instead.
- **System is a transport, not the remote system.** The cc System row is just how cc reaches a target; the actual remote/`remoteId` is the real unit of identity, configured per `remoteId`.
- **Ownership split:** the launcher owns execution (spawning `docker exec`/`ssh`, relaying I/O, killing children — see [gotchas/kill-relay.md](../gotchas/kill-relay.md)); the backend owns config storage and the UI.
- **Attach-only connect toggle.** Connecting to a remote in the UI never starts or stops a container — it only attaches to something already running.
- **No MCP surface in v1.** The plugin exposes its functionality through the System providers and the card UI only, not an MCP server.
- **No persistent shell on `docker` or `ssh`** — permanently, not a not-yet. Both advertise `persistentShell:false` and cc takes its documented one-shot-exec fallback. `host` keeps the capability because cc's conformance suite requires it. See [gotchas/no-persistent-shell.md](../gotchas/no-persistent-shell.md).
- **No per-remote shell, and `system.shell` is ceremony.** cc reads it in exactly one place (`src/systems/providerShell.ts:360`, the persistent-shell path it never opens for us), so we send a per-kind absolute constant and store nothing. Don't probe it, don't make it configurable, don't reintroduce a per-remote `shell` field.
- **File movement rides `exec`, not `docker cp`/`scp`.** See [gotchas/file-ops-over-exec.md](../gotchas/file-ops-over-exec.md).
- **Capabilities are per-kind constants on `Transport`** (`remotes` is `true` always for `docker`/`ssh`), except on `host`, where they are derived from launch flags because cc's conformance suite deep-equals the whole capabilities object. See [gotchas/host-kind-and-conformance.md](../gotchas/host-kind-and-conformance.md).
