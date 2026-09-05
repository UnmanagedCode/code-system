# code-system

A code-conductor plugin that lets [Claude Code](https://claude.com/claude-code) (`cc`) reach remote development targets — Docker containers and SSH hosts — without installing anything on the target itself.

Both transports are live, and so is the card UI. `docker`: `exec` over `docker exec`, reachability over `docker inspect`. `ssh`: `exec` over a multiplexed OpenSSH ControlMaster slave, reachability over the ControlPath socket. Both inherit `readFile`/`writeFile` and the kill relay a far-side process needs. Each remote is one card, carrying **two** independent states — an operator **gate** you set, and a **probe** of what is actually true — and only the gate decides whether a command runs.

## Functional description

### What it does

`code-system` ships two System providers for cc:

- **`docker`** — reaches a target container via `docker exec`, from the host machine that has Docker access.
- **`ssh`** — reaches a target host via `ssh`, from the host machine that has SSH access.

Both providers run entirely on cc's **host** machine. Neither installs an agent, a shell, or any other tooling on the target — they only ever reach it through the transport (`docker exec`/`ssh`) already available from the host.

**File transfer rides the same `exec` channel**, rather than `docker cp` / `scp`: the target must satisfy cc's POSIX/GNU tooling baseline anyway (cc's own derived operations are `exec` commands against that toolchain), so `base64` is already required on every supported target and a copy primitive would buy no capability — only a second code path with its own semantics to keep correct. cc's own docker sanity check maps `readFile`/`writeFile` to `cat` / `cat >` with a companion `stat` for the same reason. `docker cp` / `scp` remain available as a possible later bulk-transfer optimisation, not as the primitive.

Alongside the providers, the plugin ships a **card-based UI**: each card represents one configured remote (one container, or one SSH host). The UI is where a user adds, edits, removes and **switches on** remotes, and where a project's cc *Remote* field gets its value from.

### Who it's for

Users running cc against development environments that live outside their local machine — a container on a dev box, a VM reached over SSH — who want cc to operate on that environment directly rather than through a locally-checked-out copy.

### How to use it

1. Install the plugin.
2. In the plugin's card UI, add a remote: pick `docker` or `ssh`, then supply the connection details (container name, or host/user).
3. Press **Connect**. A new remote starts switched off, and a switched-off remote refuses every operation.
4. Point a cc project's *Remote* field at that remote's `remoteId`. (Connect first: cc will not accept a *Remote* it has never been able to reach.)
5. cc registers the corresponding System row (`docker` or `ssh`) and spawns the provider to handshake; once connected, cc operates against the remote target for that project.

See [`docs/features.md`](docs/features.md) for what a card tells you and what the providers do and don't support.

## Technical description

### Stack

Plain ESM JavaScript (`.mjs`), Node ≥ 20, no build step. Not TypeScript, for one hard reason: cc spawns the launcher with `spawn(argv[0], argv.slice(1))` and no shell, so running `.ts` directly would depend on the *host* node's type-stripping support — and that node is cc's, not ours. `node main.mjs` works on every Node ≥ 18 with no flags. The backend depends on `express`; **the launcher has zero dependencies** — it is spawned per System row, so a dependency tree there is startup cost on every reconnect.

### Quick start

In a cc-created worktree, `.code-conductor/post-worktree-create.sh` runs automatically after
creation: it installs `node_modules` into the **parent** checkout once (if absent) and
symlinks it into the worktree, so the worktree already has its dependencies and you can
skip the `npm install` step below. Caution: because the worktree's `node_modules` is a
symlink, running `npm install`/`npm ci` *inside* a worktree anyway writes through into the
parent, which every other worktree shares. Kill-switch: `ORCH_DISABLE_POST_WORKTREE_HOOK=1`.

```sh
npm install
npm start                 # backend on $PORT, default 4310
npm test                  # deterministic: no docker, no ssh, no network
CC_CHECKOUT=/path/to/code-conductor npm run conformance

# On a host where the docker CLI needs a prefix — this also makes the live
# docker tests run instead of skipping. The shipped default is bare `docker`.
CODE_SYSTEM_DOCKER='["sudo","-n","docker"]' npm test
```

### Top-level subsystems

| Component | Owns |
|---|---|
| **Launcher** (`src/launcher/`) | the System protocol: frames, ids, routing, chunking, error codes, timeouts, killing children |
| **Config store** (`src/store.mjs`) | per-`remoteId` connection config, one JSON file per remote |
| **Backend** (`server.mjs`, `src/api.mjs`) | the REST API, the card UI, auto-registration, the tooling-baseline probe |
| `conductor.plugin.json` | the plugin manifest (`backend` + `frontend`, deliberately no `mcp` block) |

The launcher and the backend share **no in-memory state**: the launcher reads the store fresh on every request frame, and the backend is the only writer.

### Architecture decisions (locked)

See [`.wiki/decisions/architecture-shape.md`](.wiki/decisions/architecture-shape.md) for the source of truth and rationale.

- **One cc System row per provider KIND, not per remote.** Two rows total — `docker` and `ssh` — each advertising `remotes:true` **and `remoteDescriptors:true`**, always. cc has no `listRemotes` frame, so this plugin's own UI is the only catalog of remotes.
- **System is a transport, not the remote system.** The cc System row is just how cc reaches a target. The real unit of identity is the remote/`remoteId`, and config is stored per `remoteId`.
- **Ownership split:** the **launcher** owns execution; the **backend** owns config storage and the UI.
- **Attach-only connect toggle.** Connecting to a remote never starts or stops a container.
- **No MCP surface in v1.**

### Docs

- [`docs/features.md`](docs/features.md) — user-facing behaviour: cards, the baseline verdict, registration states.
- [`docs/protocol.md`](docs/protocol.md) — interface contracts: the handshake per kind, `remoteId` routing, the derived file operations, registration, the REST surface.
- [`docs/architecture.md`](docs/architecture.md) — internals: the `Transport` seam and how to add a kind, the store and its startup pass, the shutdown/reap contract, test patterns.
- [`.wiki/`](.wiki/index.md) — durable gotchas and decisions, reviewed and merged like code.

### Testing

`npm test` is deterministic and needs no docker, no ssh and no network; every test gets its own temp store. The two real-target suites — `tests/docker-live.test.mjs` against a real container and `tests/ssh-live.test.mjs` against a real sshd — **skip cleanly and loudly**, each skip naming what was tried and the `CODE_SYSTEM_DOCKER` override that would run it. The docker suite's gate is a Docker daemon; the ssh suite needs **both** a daemon (to host the sshd) *and* a runnable `ssh` client, and skips if either is missing. The ssh suite additionally **proves by count that its tests really ran** (or really all skipped), so a silently-skipping live suite cannot pass as a green run. `npm run conformance` runs **code-conductor's own conformance suite** — the definition of a valid provider — against this launcher's `host` kind, gated on `CC_CHECKOUT` and skipping cleanly without it. It first runs `tests/protocol-constants.test.mjs` with that checkout and aborts on drift, so a conformance run also proves our mirrored protocol constants still match cc's.

## Known limitations

- **A remote starts switched off.** The Connect/Disconnect toggle is an operator **gate**, not a report of transport state: while a remote is off, code-system refuses every operation against it itself and never contacts the target. Editing a remote's connection details switches it off again (a changed config may be a different target); editing only its label does not. See [`.wiki/gotchas/gate-versus-probe.md`](.wiki/gotchas/gate-versus-probe.md).

- **Target tooling baseline.** Running the providers on cc's host does not make the target toolless: cc derives `readDir`/`stat`/etc. by sending commands with GNU-specific argv. Alpine/busybox targets break `readDir` and `realpath`, and silently lose sub-second `stat` precision; distroless/scratch targets have no shell at all. The plugin probes for this and refuses such a target by name rather than half-working. See [`.wiki/gotchas/tooling-baseline.md`](.wiki/gotchas/tooling-baseline.md).
- **No long-lived shell, and no carry-over between commands.** cc's protocol has no persistent shell, so every redirected shell command runs as its own one-shot: **nothing persists — not even the working directory.** Every command starts at the project root, and cc tells the worker when its `cd` was discarded; exports, shell functions and background jobs do not survive either. See [`.wiki/gotchas/no-persistent-shell.md`](.wiki/gotchas/no-persistent-shell.md) and `docs/features.md`.
- **Registration is refused (400) when the projects root is inside a git repository.** cc will not place session roots under a `.git` ancestor, and it checks this *before* spawning the provider — so registration fails in a devcontainer whose projects root is itself a repo. The plugin surfaces cc's own message, which names the directory and the fix. See [`.wiki/gotchas/active-registration.md`](.wiki/gotchas/active-registration.md).
- **`BASH_RULES_NOT_ENFORCEABLE`.** If the user's `~/.claude/settings.json` has any `Bash(...)` entry under `permissions.deny`/`permissions.ask`, every remote spawn from this plugin is refused. This is host configuration, not a provider bug. See [`.wiki/gotchas/host-environment.md`](.wiki/gotchas/host-environment.md).
- **A mirror change is not live.** A card's **Advanced** group sets how much of the target a worker can see; cc asks for it once per provider connection, so an edit reaches an already-running session only after the System reconnects. See [`.wiki/gotchas/mirror-advertisement.md`](.wiki/gotchas/mirror-advertisement.md) and [`docs/features.md`](docs/features.md).

- **Plugin must live on the `local` system (`PLUGIN_BACKEND_LOCAL_ONLY`).** The plugin backend itself is not relocatable to a remote System.
