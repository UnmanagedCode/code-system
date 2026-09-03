# Overview

`code-system` is a code-conductor plugin that lets cc reach remote development targets — Docker containers and SSH hosts — entirely from cc's host machine: `docker exec` for containers, `ssh` for remote hosts. No agent or helper process runs on the target itself.

**File movement rides the same `exec` channel, not `docker cp`/`scp`** — see [gotchas/file-ops-over-exec.md](gotchas/file-ops-over-exec.md).

## Structure

- **Kinds** — one per transport KIND (`docker`, `ssh`), behind the `Transport` seam (`src/launcher/kinds/`). A kind answers only "how do I reach this target from the host" and builds argv; the launcher core owns the protocol for all of them. A third kind, `host`, is the conformance vehicle and is never registered — see [gotchas/host-kind-and-conformance.md](gotchas/host-kind-and-conformance.md).
- **Launcher** — owns execution: spawning provider child processes, relaying their I/O, and killing them (and anything they spawned) on shutdown. See [gotchas/kill-relay.md](gotchas/kill-relay.md).
- **Config store** — the durable, on-disk record of per-`remoteId` connection config (container name, or host/user/key). The backend is the only writer; the launcher only reads it.
- **Backend + card UI** — owns the remote catalog: a card-based UI where each card is one configured remote, and the backend that writes the user's edits to the config store. Since cc has no way to enumerate remotes on its own, this catalog is the only place remotes are known. See [gotchas/no-remote-discovery.md](gotchas/no-remote-discovery.md).
- **`conductor.plugin.json`** — the plugin manifest declaring the plugin's capabilities to cc (`backend` + `frontend`, deliberately no `mcp` block). It does not register System rows itself.
- **Backend startup registration** — on start, the backend ensures the `docker` and `ssh` System rows exist by calling cc's REST API at `CONDUCTOR_URL` (`GET`/`POST /api/settings/systems`), creating only what's missing so restarts are idempotent. This is an active operation, not a passive record: cc placement-asserts and then spawns the row's `launch` argv for a real handshake, so a successful registration proves the target was reachable. See [gotchas/active-registration.md](gotchas/active-registration.md).

## Standing rule: where things live

Execution lives in the launcher; config storage and the UI live in the backend. The launcher and the UI never share in-memory state — the launcher reads the config store fresh, and the backend is the only thing that writes it. Anything that needs to survive a provider restart or be visible to the UI belongs in the store, not in a provider or launcher process.

See [index.md](index.md) for the gotchas and locked decisions that constrain how this shape is built.
