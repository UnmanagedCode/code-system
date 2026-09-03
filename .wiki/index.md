# code-system wiki index

Durable knowledge about this project: gotchas, decisions, glossary. Read this file, then the 1-3 pages relevant to your task.

## Gotchas (protocol/environment constraints, verified from cc's contract docs)

- [gotchas/tooling-baseline.md](gotchas/tooling-baseline.md) — host-side execution doesn't free the target from GNU tooling requirements (Alpine/busybox/distroless break)
- [gotchas/kill-relay.md](gotchas/kill-relay.md) — provider must SIGKILL child processes itself; cc's exit-on-stdin-EOF doesn't reach them
- [gotchas/no-remote-discovery.md](gotchas/no-remote-discovery.md) — no `listRemotes` frame; the plugin UI is the only catalog; `remoteId` is a stable hand-off contract
- [gotchas/active-registration.md](gotchas/active-registration.md) — registering a System row is an active handshake with its own preconditions
- [gotchas/host-environment.md](gotchas/host-environment.md) — two host-side failure modes: `BASH_RULES_NOT_ENFORCEABLE` and stale plugin state until restart

## Decisions

- [decisions/architecture-shape.md](decisions/architecture-shape.md) — the locked architecture decisions for this plugin (System-vs-remote split, ownership boundaries, v1 scope)

## Glossary

- **System** (cc concept) — a transport row in cc's config; this plugin registers one per provider KIND (`docker`, `ssh`), not one per remote.
- **remote / `remoteId`** — the actual target machine or container. Config is stored per `remoteId`. This is the real "remote system"; the cc System is just how cc reaches it.
- **provider** — this plugin's code for one KIND of transport (`docker` or `ssh`), running on cc's host.
