# Overview

`code-system` is a code-conductor plugin, currently pre-implementation (bootstrap only — see card 2026-0001). It will ship two System providers, `docker` and `ssh`, that let cc reach remote targets entirely from cc's host machine: `docker exec`/`docker cp` for containers, `ssh`/`scp` for remote hosts. No agent or helper process runs on the target itself.

Alongside the providers, the plugin will ship a card-based UI where each card represents one configured remote.

## Structure (as of bootstrap)

The repository has no code yet. Only workspace scaffolding exists:

- `CLAUDE.md` / `CONVENTIONS.md` — generated workspace/project conventions, not hand-edited.
- `.wiki/` — this directory.
- `README.md` — functional + technical description of the planned system, written ahead of implementation.

Provider code, the launcher, the config store, the UI, and `conductor.plugin.json` are out of scope for the bootstrap card and belong to later cards (2026-0002+).

See [index.md](index.md) for the gotchas and locked decisions that constrain how those later cards must be built.
