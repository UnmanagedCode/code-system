# Overview

`code-system` is a code-conductor plugin that lets cc reach remote development targets — Docker containers and SSH hosts — entirely from cc's host machine: `docker exec`/`docker cp` for containers, `ssh`/`scp` for remote hosts. No agent or helper process runs on the target itself.

## Structure

- **Providers** — one per transport KIND (`docker`, `ssh`). Each provider speaks cc's System protocol and turns it into `docker exec`/`docker cp` or `ssh`/`scp` calls against a target.
- **Launcher** — owns execution: spawning provider child processes, relaying their I/O, and killing them (and anything they spawned) on shutdown. See [gotchas/kill-relay.md](gotchas/kill-relay.md).
- **Config store** — owns per-`remoteId` connection config (container name, or host/user/key). The launcher and the UI both read it fresh rather than sharing in-memory state.
- **Backend + card UI** — owns config storage and the remote catalog: a card-based UI where each card is one configured remote. Since cc has no way to enumerate remotes on its own, this catalog is the only place remotes are known. See [gotchas/no-remote-discovery.md](gotchas/no-remote-discovery.md).
- **`conductor.plugin.json`** — the plugin manifest that registers the `docker` and `ssh` System rows with cc.

## Standing rule: where things live

Execution lives in the launcher; config and UI live in the backend. The two communicate only through the config store, not shared in-memory state — anything that needs to survive a provider restart or be visible to the UI belongs in the store, not in a provider or launcher process.

See [index.md](index.md) for the gotchas and locked decisions that constrain how this shape is built.
