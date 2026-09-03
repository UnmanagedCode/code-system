# Locked architecture decisions

These are decided for this plugin, ahead of implementation. Later cards should build to this shape, not re-derive it.

- **One cc System row per provider KIND, not per remote.** Two rows total: `docker` and `ssh`. Each advertises `remotes:true`. See [gotchas/no-remote-discovery.md](../gotchas/no-remote-discovery.md) for why the remote catalog lives entirely in this plugin's UI instead.
- **System is a transport, not the remote system.** The cc System row is just how cc reaches a target; the actual remote/`remoteId` is the real unit of identity, configured per `remoteId`.
- **Ownership split:** the launcher owns execution (spawning `docker exec`/`ssh`, relaying I/O, killing children — see [gotchas/kill-relay.md](../gotchas/kill-relay.md)); the backend owns config storage and the UI.
- **Attach-only connect toggle.** Connecting to a remote in the UI never starts or stops a container — it only attaches to something already running.
- **No MCP surface in v1.** The plugin exposes its functionality through the System providers and the card UI only, not an MCP server.
