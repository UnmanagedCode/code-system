# code-system

A code-conductor plugin that lets [Claude Code](https://claude.com/claude-code) (`cc`) reach remote development targets — Docker containers and SSH hosts — without installing anything on the target itself.

**Status: pre-implementation.** This repository currently contains only workspace scaffolding (conventions, this README, the project wiki). No provider code, launcher, config store, or UI exists yet — those land in later cards. This document describes what the project will become and the architecture decisions already locked in, so implementation work has a stable target to build toward.

## Functional description

### What it does

`code-system` ships two System providers for cc:

- **`docker`** — reaches a target container via `docker exec` (running commands) and `docker cp` (moving files), from the host machine that has Docker access.
- **`ssh`** — reaches a target host via `ssh` (running commands) and `scp` (moving files), from the host machine that has SSH access.

Both providers run entirely on cc's **host** machine. Neither installs an agent, a shell, or any other tooling on the target — they only ever reach it through the transport (`docker exec`/`ssh`) already available from the host.

Alongside the providers, the plugin ships a **card-based UI**: each card represents one configured remote (one container, or one SSH host). The UI is where a user adds, edits, and removes remotes, and where a project's cc *Remote* field gets its value from.

### Who it's for

Users running cc against development environments that live outside their local machine — a container on a dev box, a VM reached over SSH — who want cc to operate on that environment directly rather than through a locally-checked-out copy.

### How to use it (once implemented)

1. Install the plugin.
2. In the plugin's card UI, add a remote: pick `docker` or `ssh`, then supply the connection details (container name, or host/user/key).
3. Point a cc project's *Remote* field at that remote's `remoteId`.
4. cc registers the corresponding System row (`docker` or `ssh`) and spawns the provider to handshake; once connected, cc operates against the remote target for that project.

## Technical description

### Stack

Node/TypeScript plugin for code-conductor. No dependencies are pinned yet — `package.json` doesn't exist until a later card.

### Architecture decisions (locked)

These are settled ahead of implementation; see [`.wiki/decisions/architecture-shape.md`](.wiki/decisions/architecture-shape.md) for the source of truth and rationale.

- **One cc System row per provider KIND, not per remote.** Two rows total — `docker` and `ssh` — each advertising `remotes:true`. cc has no `listRemotes` frame, so this plugin's own UI is the only catalog of remotes.
- **System is a transport, not the remote system.** The cc System row is just how cc reaches a target. The real unit of identity is the remote/`remoteId`, and config is stored per `remoteId`.
- **Ownership split:** the **launcher** owns execution (spawning `docker exec`/`ssh`, relaying I/O, killing children on shutdown); the **backend** owns config storage and the UI.
- **Attach-only connect toggle.** Connecting to a remote in the UI never starts or stops a container — it only attaches to one already running.
- **No MCP surface in v1.** Functionality is exposed only through the System providers and the card UI.

### Key components (planned)

| Component | Owns | Status |
|---|---|---|
| `docker` provider | `docker exec`/`docker cp` transport, child-process lifecycle | not started |
| `ssh` provider | `ssh`/`scp` transport, child-process lifecycle | not started |
| Launcher | Spawning and killing provider child processes | not started |
| Config store | Per-`remoteId` connection config | not started |
| Card UI | Remote catalog (add/edit/remove), project hand-off via `remoteId` | not started |
| `conductor.plugin.json` | Plugin manifest registering the two System rows | not started |

### Project wiki

Durable gotchas and decisions live in [`.wiki/`](.wiki/index.md), reviewed and merged like code. Read `.wiki/index.md` before starting implementation work on any later card.

### Testing

No test suite yet — none of the code it would cover exists. When implementation starts, follow the workspace testing conventions (deterministic, fast, fakes for external systems like `docker`/`ssh`, no live network in the default suite).

## Known limitations

- **Target tooling baseline.** Running the providers on cc's host does not make the target toolless. cc derives `readDir`/`stat`/etc. by sending `exec` frames with GNU-specific argv (e.g. `find ... -printf`, `stat -L -c`). Busybox `find` (Alpine) lacks `-printf`, so Alpine targets break `readDir`; distroless/scratch targets have no shell at all and won't work. See [`.wiki/gotchas/tooling-baseline.md`](.wiki/gotchas/tooling-baseline.md).
- **`BASH_RULES_NOT_ENFORCEABLE`.** If the user's `~/.claude/settings.json` has any `Bash(...)` entry under `permissions.deny`/`permissions.ask`, every remote spawn from this plugin is refused. This is host configuration, not a provider bug. See [`.wiki/gotchas/host-environment.md`](.wiki/gotchas/host-environment.md).
- **Plugin must live on the `local` system (`PLUGIN_BACKEND_LOCAL_ONLY`).** The plugin backend itself is not relocatable to a remote System — it must run on cc's local/host system.
