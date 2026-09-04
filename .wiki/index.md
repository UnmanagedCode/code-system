# code-system wiki index

Durable knowledge about this project: gotchas, decisions, glossary. Read this file, then the 1-3 pages relevant to your task.

## Gotchas (protocol/environment constraints, verified from cc's contract docs)

- [gotchas/tooling-baseline.md](gotchas/tooling-baseline.md) — host-side execution doesn't free the target from GNU tooling requirements (Alpine/busybox/distroless break)
- [gotchas/kill-relay.md](gotchas/kill-relay.md) — provider must SIGKILL child processes itself; cc's exit-on-stdin-EOF doesn't reach them; it fires at four sites (close, shutdown, timeout, `signal`); the relay must PROVE it ran or a blind reap reads as a clean one
- [gotchas/no-remote-discovery.md](gotchas/no-remote-discovery.md) — no `listRemotes` frame; the plugin UI is the only catalog; `remoteId` is a stable hand-off contract; connect a remote before pointing a project at it (cc's binding check is asymmetric — see gate-versus-probe)
- [gotchas/gate-versus-probe.md](gotchas/gate-versus-probe.md) — a remote has TWO states that disagree routinely: the operator GATE (`record.enabled`, the only thing that decides whether an operation runs, enforced at one site) and the PROBE (`reachability`, never cached, never gated); why the gate could not just BE the ssh socket; what a kind author owes
- [gotchas/refusal-message-errno-tokens.md](gotchas/refusal-message-errno-tokens.md) — cc RE-PARSES a refusal's `message` text and ignores the structured code, so a bare `ENOENT`/`EACCES`/… token silently downgrades an administrative refusal into "git answered non-zero"; and an `error` frame's `stderr` reaches nobody
- [gotchas/active-registration.md](gotchas/active-registration.md) — registering a System row is an active handshake with its own preconditions
- [gotchas/host-environment.md](gotchas/host-environment.md) — two host-side failure modes: `BASH_RULES_NOT_ENFORCEABLE` and stale plugin state until restart
- [gotchas/host-kind-and-conformance.md](gotchas/host-kind-and-conformance.md) — why `host` is KEPT (own-filesystem fixtures + it runs the battery through the shipped launcher); the launch surface §10 obliges (and that the `--remote` root is NOT a fence the suite asks you to enforce); the four rows a third-party run skips; what the two env seams really buy
- [gotchas/file-ops-over-exec.md](gotchas/file-ops-over-exec.md) — `readFile`/`writeFile` are derived over `exec`, not `docker cp`/`scp`; our own refusals carry a per-call nonce tag (matching the `strerror` tail is spoofable by a path); `exclusive` is `set -C`
- [gotchas/no-persistent-shell.md](gotchas/no-persistent-shell.md) — the protocol has no long-lived shell at all; NOTHING carries over between commands, not even cwd; `stdin`/`stdinClose` are deleted frames and must be ignored, never refused
- [gotchas/baseline-probe-two-tier.md](gotchas/baseline-probe-two-tier.md) — the tooling probe is cached on a reachability fingerprint; check the flag not the binary; busybox `stat` succeeds and is wrong; the live busybox verdict is FOUR capabilities, not three
- [gotchas/docker-exec-transport.md](gotchas/docker-exec-transport.md) — measured `docker exec` behaviour: children survive their host client; a never-started command reports on STDOUT with exit 127/128 while daemon refusals use stderr; `processGroupSignal` could be `true` and why it is not; `env -i --` (dropping the `--` lets a frame env key hijack the cwd) and the HOME discriminator; `-i` iff `stdin:'pipe'`; no `ps` in `node:24-slim`
- [gotchas/ssh-controlmaster-transport.md](gotchas/ssh-controlmaster-transport.md) — measured `ssh` behaviour: exit 255 classifies NOTHING (a command's own 255 is indistinguishable); ssh takes a SHELL STRING so the far side's login shell re-parses it; `ControlMaster=auto` needs the control DIRECTORY and fails without it while `no` still multiplexes (which is why `spawnPlan` can stay pure); never emit `-M` (doubled it means `ask`); `-T` vs `RequestTTY force`; `-O check` speaks on stderr; the known_hosts policy is `ask` + `BatchMode`
- [gotchas/exec-env-across-a-boundary.md](gotchas/exec-env-across-a-boundary.md) — `ExecRequest.env` is the FRAME's env and `null` means the FAR SIDE's, never the launcher's `process.env`; `CC_REMOTE` overlaid last, by the kind; cc sends NO `env` on any `exec`, and keep the REPLACE branch anyway; name the interpreter absolutely

## Decisions

- [decisions/architecture-shape.md](decisions/architecture-shape.md) — the locked architecture decisions for this plugin (System-vs-remote split, ownership boundaries, v1 scope)

## Glossary

- **System** (cc concept) — a transport row in cc's config; this plugin registers one per provider KIND (`docker`, `ssh`), not one per remote.
- **remote / `remoteId`** — the actual target machine or container. Config is stored per `remoteId`. This is the real "remote system"; the cc System is just how cc reaches it.
- **provider** — this plugin's code for one KIND of transport (`docker` or `ssh`), running on cc's host.
- **kind** — one transport implementation behind the `Transport` seam (`src/launcher/kinds/`): it builds argv and nothing else. `docker`, `ssh`, and `host` (the never-registered conformance vehicle).
- **ControlMaster / ControlPath** (ssh) — the multiplexed connection and the unix socket it lives on. The socket's existence is what `ssh`'s PROBE reports; it is **not** the gate (see [gotchas/gate-versus-probe.md](gotchas/gate-versus-probe.md)) — closing the master does not stop commands, it only un-multiplexes them.
- **gate** (`record.enabled`) — the operator's on/off switch for a remote, stored per `remoteId`. The only thing that decides whether an operation runs. Distinct from the probe, and never called "connected".
- **probe** (`Transport.reachability`) — the live answer to "is the target there", re-asked on every card render and never cached or gated.
- **launcher** — the process cc spawns per System row (`src/launcher/main.mjs`). Owns the protocol for every kind.
- **baseline** — a per-remote verdict (`ok` / `unsupported` / `unknown`) on whether the target has the GNU tooling cc's derived operations need.
- **reap** — a kind's relay of the kill into the far side, for children that are not the launcher's OS descendants (`Transport.reap`). A `/proc` scan for the exec's `CC_EXEC_TOKEN`, shared by `docker` and `ssh` from `src/launcher/kinds/reapscript.mjs`.
- **`CC_EXEC_TOKEN`** — a per-exec nonce the core generates and the kind places in the far-side command's environment, so `reap` can find that exec's own processes.
