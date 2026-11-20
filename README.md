# code-system

A code-conductor plugin that lets [Claude Code](https://claude.com/claude-code) (`cc`) reach remote development targets — Docker containers and SSH hosts without installing anything on the target itself, and any Linux machine that runs a one-file dial-in agent.

All three transports are live, and so is the card UI. `docker`: `exec` over `docker exec`, reachability over `docker inspect`. `ssh`: `exec` over a multiplexed OpenSSH ControlMaster slave, reachability over the ControlPath socket. `agent`: `exec` over a stdlib-only Python agent on the target that dials code-system's listener, reachability over the listener's own socket. All three inherit `readFile`/`writeFile` and the kill relay a far-side process needs. Each remote is one card, carrying **two** independent states — an operator **gate** you set, and a **probe** of what is actually true — and only the gate decides whether a command runs.

## Functional description

### What it does

`code-system` ships three System providers for cc:

- **`docker`** — reaches a target container via `docker exec`, from the host machine that has Docker access.
- **`ssh`** — reaches a target host via `ssh`, from the host machine that has SSH access.
- **`agent`** — the other direction: a single-file, standard-library-only Python agent on a Linux target **dials code-system**, proves it knows the remote's secret, and runs the commands cc sends. For cc in a container working on its Docker host, or any machine cc's host cannot reach but which can reach cc's host.

`docker` and `ssh` run entirely on cc's **host** machine and install nothing on the target — they only ever reach it through the transport (`docker exec`/`ssh`) already available from the host. **`agent` is the exception by design**: the agent runs on the target (one file, fetched from code-system's own listener with one `curl`), and nothing on cc's side needs ssh or docker access to it.

**File transfer rides the same `exec` channel**, rather than `docker cp` / `scp`: the target must satisfy cc's POSIX/GNU tooling baseline anyway (cc's own derived operations are `exec` commands against that toolchain), so `base64` is already required on every supported target and a copy primitive would buy no capability — only a second code path with its own semantics to keep correct. cc's own docker sanity check maps `readFile`/`writeFile` to `cat` / `cat >` with a companion `stat` for the same reason. `docker cp` / `scp` remain available as a possible later bulk-transfer optimisation, not as the primitive.

Alongside the providers, the plugin ships a **card-based UI**: each card represents one configured remote (one container, or one SSH host). The UI is where a user adds, edits, removes and **switches on** remotes, and where a project's cc *Remote* field gets its value from.

### Who it's for

Users running cc against development environments that live outside their local machine — a container on a dev box, a VM reached over SSH — who want cc to operate on that environment directly rather than through a locally-checked-out copy.

### How to use it

1. Install the plugin.
2. In the plugin's card UI, add a remote: pick `docker`, `ssh` or `agent`, then supply the connection details (container name, or host, optional user — an ssh card may also carry a port, its own password or a private key file under **Advanced**). An `agent` card needs none: Create generates its secret and shows the command that starts the agent on the target — once.
3. Press **Connect**. A new remote starts switched off, and a switched-off remote refuses every operation.
4. Point a cc project's *Remote* field at that remote's `remoteId`. (Connect first: cc will not accept a *Remote* it has never been able to reach.)
5. cc registers the corresponding System row (`docker`, `ssh` or `agent`) and spawns the provider to handshake; once connected, cc operates against the remote target for that project.

See [`docs/features.md`](docs/features.md) for what a card tells you and what the providers do and don't support.

## Technical description

### Stack

- **Backend and launcher:** plain ESM JavaScript (`.mjs`), no build step. Not TypeScript, for one hard reason: cc spawns the launcher with `spawn(argv[0], argv.slice(1))` and no shell, so running `.ts` directly would depend on the *host* node's type-stripping support — and that node is cc's, not ours. `node main.mjs` works on every Node ≥ 18 with no flags. The backend depends on `express`; **the launcher has zero dependencies** — it is spawned per System row, so a dependency tree there is startup cost on every reconnect.
- **Card UI** (`frontend/`): React + Vite + Tailwind v4 + shadcn/Radix components, cc's reference setup (`docs/plugin-ui.md` Part 3 in a code-conductor checkout). It follows cc's light/dark theme live, and the OS theme when run standalone. It is **built on install**: `npm install` runs the `prepare` script, which writes `frontend/dist` (never committed). All UI packages are `devDependencies`.
- **Node:** `>=22.12` to install, build and test (Vite 8, Vitest 5). The launcher itself still runs on any Node ≥ 18.

### Quick start

In a cc-created worktree, `.code-conductor/post-worktree-create.sh` runs automatically after
creation: it installs `node_modules` into the **parent** checkout once (if absent),
symlinks it into the worktree, and builds the worktree's UI with `npm run prepare`, so the
worktree already has its dependencies and its `frontend/dist` and you can skip the
`npm install` step below. If the parent's `node_modules` has no `vite` (installed before the
UI had a build), the hook builds nothing and says to run `npm install` in the parent. The hook also symlinks the parent's `.wiki/` into the worktree. Caution: because the worktree's `node_modules` is a
symlink, running `npm install`/`npm ci` *inside* a worktree anyway writes through into the
parent, which every other worktree shares. Kill-switch: `ORCH_DISABLE_POST_WORKTREE_HOOK=1`.

```sh
npm install               # installs, then builds the UI into frontend/dist (prepare)
npm start                 # backend on 127.0.0.1:$PORT, default 4310
npm run dev               # Vite dev server for the UI; proxies /api to $PLUGIN_BACKEND (default http://127.0.0.1:4310)
npm test                  # node suite + tsc + vitest; deterministic: no docker, no ssh, no network
CC_CHECKOUT=/path/to/code-conductor npm run conformance
CC_CHECKOUT=/path/to/code-conductor npm run conformance:agent   # cc's suite through a real broker + agent
make agent ARGS='--connect HOST:PORT --remote ID'                # run the dial-in agent from a checkout

# On a host where the docker CLI needs a prefix — this also makes the live
# docker tests run instead of skipping. (The provider itself tries bare `docker`,
# then falls back to `sudo -n docker` on a socket denial.)
CODE_SYSTEM_DOCKER='["sudo","-n","docker"]' npm test
```

### Top-level subsystems

| Component | Owns |
|---|---|
| **Launcher** (`src/launcher/`) | the System protocol: frames, ids, routing, chunking, error codes, timeouts, killing children |
| **Config store** (`src/store.mjs`) | per-`remoteId` connection config, one JSON file per remote |
| **Backend** (`server.mjs`, `src/http.mjs`, `src/api.mjs`) | the REST API, serving the built card UI, auto-registration, the tooling-baseline probe |
| **Card UI** (`frontend/`) | the React page cc embeds; its decisions are pure functions in `frontend/src/lib/cardState.mjs` |
| **MCP surface** (`src/mcp.mjs`) | one read-only tool, `list_remotes`, the remote catalog, as text or typed JSON |
| **Agent broker** (`src/agent/`, `agent/agent.py`) | the `agent` kind's detached listener process, its sessions and the agent itself; wire spec in [`docs/agent-wire.md`](docs/agent-wire.md) |
| `conductor.plugin.json` | the plugin manifest: `backend`, `frontend` and `mcp` |

The launcher and the backend share **no in-memory state**: the launcher reads the store fresh on every request frame, and the backend is the only writer.

### Architecture decisions (locked)

See [`.wiki/decisions/architecture-shape.md`](.wiki/decisions/architecture-shape.md) for the source of truth and rationale.

- **One cc System row per provider KIND, not per remote.** Three rows total — `docker`, `ssh` and `agent` — each advertising `remotes`, `remoteDescriptors` **and `remoteListing`**, always. cc enumerates the configured set through `listRemotes`; this plugin is the only place remotes are managed, and its cards list every record ([`.wiki/gotchas/remote-catalog.md`](.wiki/gotchas/remote-catalog.md)).
- **System is a transport, not the remote system.** The cc System row is just how cc reaches a target. The real unit of identity is the remote/`remoteId`, and config is stored per `remoteId`.
- **Ownership split:** the **launcher** owns execution; the **backend** owns config storage and the UI.
- **Attach-only connect toggle.** Connecting to a remote never starts or stops a container.
- **The MCP surface is read-only.** One tool, `list_remotes`; see [`.wiki/decisions/architecture-shape.md`](.wiki/decisions/architecture-shape.md) for what that forbids.

### Docs

- [`docs/features.md`](docs/features.md) — user-facing behaviour: cards, the baseline verdict, registration states.
- [`docs/agent-wire.md`](docs/agent-wire.md) — the dial-in agent's wire: handshake, frames, credit, the broker's unix socket.
- [`docs/protocol.md`](docs/protocol.md) — interface contracts: the handshake per kind, `remoteId` routing, the derived file operations, registration, the REST surface, the MCP surface.
- [`docs/architecture.md`](docs/architecture.md) — internals: the `Transport` seam and how to add a kind, the store and its startup pass, the shutdown/reap contract, test patterns.
- [`.wiki/`](.wiki/index.md) — durable gotchas and decisions. It is untracked and local: the main checkout holds it, and each worktree links it in, so links into it resolve only where it is present.

### Testing

`npm test` is deterministic and needs no docker, no ssh and no network; every test gets its own temp store. It runs three stages in order: the `node --test` suite (`tests/*.test.mjs`, which includes checks on the real `frontend/dist`, so build first), `npm run typecheck` (`tsc -p frontend`), and `npm run test:web` (vitest + happy-dom over `frontend/src/**/*.test.{ts,tsx}`). The two real-target suites — `tests/docker-live.test.mjs` against a real container and `tests/ssh-live.test.mjs` against a real sshd — **skip cleanly and loudly**, each skip naming what was tried and the `CODE_SYSTEM_DOCKER` override that would run it. The docker suite's gate is a Docker daemon; the ssh suite needs **both** a daemon (to host the sshd) *and* a runnable `ssh` client, and skips if either is missing. The ssh suite additionally **proves by count that its tests really ran** (or really all skipped), so a silently-skipping live suite cannot pass as a green run. The agent suites (`tests/agent*.test.mjs`, `tests/broker-*.test.mjs`) run a real Python agent and a real broker on loopback and need **Python 3.9+** (`python3`, or `CODE_SYSTEM_PYTHON`); without one they skip loudly, naming the variable. `npm run conformance` runs **code-conductor's own conformance suite** — the definition of a valid provider — against this launcher's `host` kind, gated on `CC_CHECKOUT` and skipping cleanly without it. It first runs `tests/protocol-constants.test.mjs` with that checkout and aborts on drift, so a conformance run also proves our mirrored protocol constants still match cc's.

## Known limitations

- **Docker falls back to `sudo -n docker` by itself.** Only when plain `docker` is denied the daemon socket (never for a daemon that is down). `sudo -n docker` is **root-equivalent on this host**, and the card's status says so when it is in use. Opt out with `CODE_SYSTEM_DOCKER='["docker"]'`, which pins bare docker.
- **A remote starts switched off.** The Connect/Disconnect toggle is an operator **gate**, not a report of transport state: while a remote is off, code-system refuses every operation against it itself and never contacts the target. Editing a remote's connection details switches it off again (a changed config may be a different target); editing only its label does not. See [`.wiki/gotchas/gate-versus-probe.md`](.wiki/gotchas/gate-versus-probe.md).

- **Target tooling baseline.** Running the providers on cc's host does not make the target toolless: cc derives `readDir`/`stat`/etc. by sending commands with GNU-specific argv. Alpine/busybox targets break `readDir` and `realpath`, and silently lose sub-second `stat` precision; distroless/scratch targets have no shell at all. The plugin probes for this and refuses such a target by name rather than half-working. See [`.wiki/gotchas/tooling-baseline.md`](.wiki/gotchas/tooling-baseline.md).
- **No long-lived shell, and no carry-over between commands.** cc's protocol has no persistent shell, so every redirected shell command runs as its own one-shot: **nothing persists — not even the working directory.** Every command starts at the project root, and cc tells the worker when its `cd` was discarded; exports, shell functions and background jobs do not survive either. See [`.wiki/gotchas/no-persistent-shell.md`](.wiki/gotchas/no-persistent-shell.md) and `docs/features.md`.
- **Registration is refused (400) when the projects root is inside a git repository.** cc will not place session roots under a `.git` ancestor, and it checks this *before* spawning the provider — so registration fails in a devcontainer whose projects root is itself a repo. The plugin surfaces cc's own message, which names the directory and the fix. See [`.wiki/gotchas/active-registration.md`](.wiki/gotchas/active-registration.md).
- **`BASH_RULES_NOT_ENFORCEABLE`.** If the user's `~/.claude/settings.json` has any `Bash(...)` entry under `permissions.deny`/`permissions.ask`, every remote spawn from this plugin is refused. This is host configuration, not a provider bug. See [`.wiki/gotchas/host-environment.md`](.wiki/gotchas/host-environment.md).
- **A mirror change is not live.** A card's **Advanced** group sets how much of the target a worker can see; cc asks for it once per provider connection, so an edit reaches an already-running session only after the System reconnects. See [`.wiki/gotchas/mirror-advertisement.md`](.wiki/gotchas/mirror-advertisement.md) and [`docs/features.md`](docs/features.md).

- **The agent's machine must be Linux** (Python 3.9 or later); **cc's host needs `/proc` to REPLACE a running agent listener** (after a changed `CODE_SYSTEM_AGENT_LISTEN` or a plugin update): that is the only way it can prove a pid is its own listener before signalling it. Without `/proc` it reports the old listener, naming why, instead of replacing it; everything else on cc's side uses only node and a unix socket.
- **The secret is briefly in the agent's environment at startup**, until the agent re-executes itself without it (`docs/agent-wire.md`, "How the secret reaches the running agent"); a same-user process watching `/proc` in that window can read it.
- **The `agent` kind's traffic is plaintext**: the agent and code-system authenticate each other by challenge-response and the secret never crosses the wire, but commands and their output do, in the clear. Keep the listener on a trusted network or loopback.
- **The agent's secret is stored unencrypted** in the remote's store file (0600), like an ssh password, and the API never returns it — so the start command is shown once, and after a reload only **Generate new secret** gets you another.
- **A containerised cc must publish the agent listener's port and set `CODE_SYSTEM_AGENT_LISTEN`** (e.g. `0.0.0.0:7420`); the default listens on loopback only. See [`docs/features.md`](docs/features.md) → Operator settings.
- **The agent listener's pre-authentication slots can be held by anyone who can reach its port**: a peer that opens `maxPendingHandshakes` connections (the `PROTOCOL` block in `agent/agent.py`) and keeps re-opening them as each times out can stop NEW agents connecting. Agents already connected are unaffected. Accepted, not fixed: keep the port on loopback or a trusted network.
- **When an agent's connection drops, it ends every command it was running for that connection**, including background jobs a detached command left (a `setsid` job survives). **An agent killed with `kill -9` cannot**, and its commands keep running.
- **An agent runs commands as its own user**, in its own environment, on its own machine.
- **An ssh password is stored unencrypted.** It lives in the remote's store file (mode 0600), so it is readable by that user, by root and by any backup of the store; the API never returns it. See [`docs/features.md`](docs/features.md).
- **Plugin must live on the `local` system (`PLUGIN_BACKEND_LOCAL_ONLY`).** The plugin backend itself is not relocatable to a remote System.
- **The UI build needs the devDependencies.** A cc started with `NODE_ENV=production` or `npm_config_omit=dev` makes the Library's `npm install` skip them, so `prepare` fails and there is no `frontend/dist`. The backend still starts, logs `UI not built: <path> is missing — run npm install`, and answers every UI path with `503 text/plain` `UI not built — run npm install`; the API keeps working.
- **The built check happens at backend start.** After building by hand (`npm run prepare`), restart the backend to stop the 503.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright (c) 2026 UnmanagedCode. See [LICENSE](LICENSE) for details.
