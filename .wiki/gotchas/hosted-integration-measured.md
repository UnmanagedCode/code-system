# What a real cc hosting this plugin obliges you to do (measured)

Card 2026-0006 ran the plugin end to end with **cc hosting it** — not the
standalone `server.mjs` shortcut — against a real container (`docker`) and a
real sshd (`ssh`), at cc `0ec638aa` and this plugin's `e2753b2a`. The headline
claim held: a worker's `Bash` ran inside a target with no node, no cc files, no
Anthropic credential and no route home.

**The evidence is not here.** It is the recorded run:
`code-system-test/rig/RESULTS-code-system-integration.md`, with the setup in
that project's `README.md` §9. This page carries only the rules that survive
the run — the things you would do differently knowing them.

## 1. cc has no plugin search path, so hosting a second instance means a scratch `PROJECTS_ROOT`

cc does not scan a directory for plugins. It **iterates adopted projects and
reads `conductor.plugin.json` out of each** (cc's `src/plugins/registry.ts`,
`rescanInternal`), and a direct child of the projects root is a project with no
adopt call (cc's `src/projects.ts`, `listProjects`). We ship
`conductor.plugin.json` at the repo root, so **placing a clone under a scratch
`PROJECTS_ROOT` is how cc loads it** — `POST /api/plugins/rescan` then finds it
with `state=discovered`, `hasBackend=true`, `errors=[]`.

**Never adopt the working checkout to do this.** Every mutating cc plugin route
calls `regenerateAllProjectConventions()`, which writes `CONVENTIONS.md` into
every adopted project — so adopting the real tree means the act of testing edits
the tree under test. Clone it, at a recorded sha, and adopt the clone.

## 2. Restarting the plugin cannot kill a live worker, and the reason is structural

Measured twice on the docker arm, each with a 300-tick far-side command live
across two Settings → Plugins restarts: the plugin **backend**'s pid and
allocated port both changed, the **launcher**'s pid did not, and the tick stream
had no gaps and ticks on both sides of each restart instant.

**Because the launcher is cc's child, not the plugin's.** cc spawns the provider
child itself (cc's `src/systems/providerConnection.ts`) into cc's module-level
`HANDLES` map (cc's `src/systems/registry.ts`), while
`POST /api/plugins/:id/restart` reaches `supervisor.stop`, which SIGTERMs only
the **backend's** process group (cc's `src/plugins/supervisor.ts`). No plugin
exit path calls `disposeSystemHandle`. The two lifecycles are not connected.
The "launcher owns execution, the backend owns config and UI" split in
[../decisions/architecture-shape.md](../decisions/architecture-shape.md) is
therefore enforced by process parentage, not just by discipline — measured
rather than argued.

Three consequences to act on:

- **One env block on the cc server configures both plugin processes, and there
  is nowhere else to set them.** The backend is spawned by cc's supervisor with
  `{...process.env, …}` and the launcher by cc's systems layer with
  `env: this.#launch.env ?? process.env` — so anything the cc server inherits,
  both inherit. Set `CODE_SYSTEM_STORE` / `CODE_SYSTEM_DOCKER` /
  `CODE_SYSTEM_SSH` on the server process.
- **To reproduce it, make the plugin clone stale first.** The Restart button
  renders **only** when `row.state === 'ready' && row.stale` (cc's
  `public/pluginManager.js`), where `stale = currentHead !== record.gitHead`
  (cc's `src/plugins/row.ts`). A bare headless POST exercises a route whose
  button is not on screen. An `--allow-empty` commit makes the row stale without
  changing `HEAD^{tree}`, which is what a pin check should assert for that clone.
- **The standalone shortcut cannot cover this row.** `node server.mjs` with
  `CONDUCTOR_URL` set registers the same System rows and yields the same
  launcher, so most criteria pass under it — but cc is not *hosting* the child,
  so there is no process group for `supervisor.stop` to signal and restart
  survival is vacuous.

## 3. `/bin/bash` plus GNU coreutils/findutils is genuinely required, and it is the whole list

The four negatives were measured **inside the worker's own transcript**, not
through a side channel, on both kinds: `command -v node npm npx` → `NO-NODE`; no
`referenceProvider.ts` / `bashForwarder*` / `/opt/cc` anywhere under `find /
-xdev`; zero `anthropic|claude` env vars and no `~/.claude`, `~/.claude.json` or
`/root/.config/anthropic`; and zero connections to cc's port in
`/proc/net/tcp{,6}`.

**The positive is the part that constrains you:** the same targets answered
`/usr/bin/bash`, `find -printf` OK, and a `stat -L -c %.3Y` value *carrying a
sub-second component*. "No node on the target" is not "no tooling on the
target" — see [tooling-baseline.md](tooling-baseline.md) for what cc derives and
why.

**State the ssh arm's isolation in its weaker form.** The docker fixture ran
`--network none`, so its no-route-home claim depends on nothing. An ssh target
must be reachable *by* cc, so it has an interface: its claim rests on bridge
isolation plus a TCP probe and a connection census. Both were measured and both
held, but they are not the same claim and must not be written as one.

## 4. An unsupported target is refused at **adopt**, and busybox `stat` is why the probe asserts on shape

**The refusal fires earlier than "the first Bash call fails".** Adopting a
project on the remote is itself refused, because cc must `realpath` the path and
`realpath` is one of the derived operations the gate covers
(`src/launcher/remotes.mjs:200`). Measured against `alpine:3.22`:

```
code:   SYSTEM_UNREACHABLE
reason: could not resolve '/work' on system 'docker': realpath '/work': remote 'alp'
        does not meet the tooling baseline … readDir, realpath, stat, shell.
```

One refusal, naming all four missing capabilities, and **no project is
created** — so no worker can ever be spawned on such a target. Wherever the gate
is described, say it this way: an Alpine target is not "a system whose commands
fail", it is **a system you cannot adopt a project on**. The half-working state
is never reachable.

Alpine fails four of the five `PROBE_CAPABILITIES` (`src/baseline.mjs:34`);
`base64` **passes**, because busybox provides it as an applet and `command -v`
finds it.

**And the honest half, which is the actual design rule:** busybox `stat`
implements `-c`, ignores the `.3`, **exits 0** and emits no warning —

```
busybox : 41ed 4096 1788562038        <- exit 0, no sub-second component
GNU     : 41ed 4096 1788562002.533
```

so the probe catches it **only** because `PROBE_SCRIPT` asserts on output
*shape*, `case "$3" in *.*)` (`src/baseline.mjs:59`), rather than on exit code.
"busybox fails four probes" and "busybox fails four probes, one of which
succeeds and is wrong" are different claims, and only the second explains why
the probe is written the way it is. Keep them together — the detail is in
[baseline-probe-two-tier.md](baseline-probe-two-tier.md).

## 5. cc's per-command ceiling is 605 s, and the Bash tool's own `timeout` never reaches cc

There are **two** deadlines and neither is the 120 s that older prose
(`rig/RESULTS-bash-parity.md` D1, at cc `24345f69`) recorded as the kill point:

| Deadline | Whose | Value | What it does |
|---|---|---|---|
| tool timeout | the CLI's | 120 s default, `timeout` param up to 600 s | **detaches** the call and hands back a background id. Never reaches cc. |
| per-command ceiling | cc's | `BASH_TOOL_MAX_TIMEOUT_MS (600_000) + SHELL_TIMEOUT_SLACK_MS (5_000)` = **605 000 ms** | provider-enforced as the `exec` frame's `timeoutMs` (cc's `src/systems/providerShell.ts`); the only thing that stops the far side |

**So an explicit `timeout` lifts nothing on the cc side, in either direction.**
The redirect rewrite carries only the forwarder URL and the command (cc's
`src/systems/toolRedirect.ts`, `#redirectBash`), so there is nothing for it to
lift. Measured: a 300-tick command completed 300/300 with no gaps *both* with
`timeout: 600000` and with no `timeout` at all (306 s vs 307 s, otherwise
indistinguishable); a 200 s foreground call was **detached** at 120.1 s with a
pointer to a background id and then ran to `[exited with code 0]`; and a 620 s
command carrying `timeout: 600000` was killed at tick 603 by cc's own message,
`the command was still running after 605000ms, cc's per-command ceiling`.

Two limits on the claim: this was measured through **our** launcher, and the
reference-provider arm that produced the superseded 120 s table was not re-run
(the constant is cc-side and provider-independent). Nothing in this repo ever
stated the 120 s figure, so there was nothing here to correct.

## 6. `connect` is not idempotent — card 2026-0013

Three redirected `Bash` calls over ssh cost **zero** authentications (measured as
a delta out of the sshd's log), which is `ControlMaster=no` reusing the master
exactly as [ssh-controlmaster-transport.md](ssh-controlmaster-transport.md)
describes. `connect` is the opposite: it spawns a master **unconditionally**
(`src/launcher/kinds/ssh.mjs:552`), so on an already-connected remote it
authenticates again, leaks a background `ssh -N` that owns no socket, and
**reports success** — its `-O check` inspects the *original* master's healthy
socket. Several orphans were observed live at once. Filed as **card 2026-0013**;
do not patch it here.

## 7. Re-measuring this

```sh
make integ-all          # in the code-system-test rig
```

Every `integ-*` target asserts its own falsifier, so a green run *is* the
evidence; the written form is
`code-system-test/rig/RESULTS-code-system-integration.md`.

**If you write a scenario that drives a worker, read cc's artefact, not the
worker's answer.** A worker is a reliable instrument for what a tool *returns*
and an unreliable one for what a tool is still *doing*: asked to drain a
background shell, it answered from the launch `tool_result` and made no
`BashOutput` call at all — which left one claim unmeasured and produced one
confidently wrong verdict, twice. Background state has to be read from the file
cc writes the far side's bytes to.
