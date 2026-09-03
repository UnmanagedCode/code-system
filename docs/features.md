# Features

What the plugin does for a user.

## Remotes are cards

Each **remote** — one Docker container, or one SSH host — is one card. The card
UI is where a remote is added, edited and removed, and it is the **only** catalog
of remotes: cc's protocol has no `listRemotes` frame, so cc never knows what
remotes exist. It only knows the `remoteId` string a project's *Remote* field is
set to.

That makes `remoteId` a hand-off contract:

- it is **human-typable** (`^[a-z0-9][a-z0-9._-]{0,63}$`), because a user reads it
  off a card and pastes it into cc;
- it is **never renamed** once created — everything else on a card is editable;
- **deleting a remote warns** when cc projects still name it, listing them.
  Nothing else would tell you which projects you just stranded.

*(The card UI itself lands in card 2026-0005; the backend every card renders is
already in place — see `docs/protocol.md` → Backend REST.)*

## Connecting is attach-only

Connecting to a remote never starts or stops anything. This plugin never runs
`docker start`, `docker stop`, `docker run` or `docker rm` — it only attaches to
a container that is already running, or opens an ssh connection to a host that
is already up. A card that shows disconnected means "not reachable right now",
never "press here to boot it".

## A card tells you when a target cannot work

A remote is **never shown as healthy on a target that will fail cc's first
`readDir`.** Beyond "is it reachable", each card carries a **tooling-baseline**
verdict:

| Verdict | Meaning |
|---|---|
| `ok` | the target has what cc's derived operations need |
| `unsupported` | it does not — the card lists each missing capability, the probe that caught it, and **the target's own error text** |
| `unknown` | not probed yet |

Running the provider on cc's host does not free the *target* from cc's tooling
requirements: cc derives `stat`, `readDir`, `realpath`, `mkdir`, `removeTree`,
`unlink` and `chmod` by sending commands with GNU-specific arguments. So a
target needs **GNU coreutils, GNU findutils and a POSIX shell**.

Alpine (busybox) is the common surprise, and it fails in three ways of which
only two announce themselves: `find` has no `-printf` (so `readDir` breaks
outright), `realpath` accepts neither `-e` nor `--`, and — the dangerous one —
`stat` **succeeds** while silently dropping sub-second mtime precision. The
probe checks the exact commands cc sends, in their exact forms, and asserts on
the *output shape* for that last one. Distroless and scratch images have no
shell at all and will not work.

A remote marked `unsupported` is refused **whole**, with a message naming the
missing capability: half-working is worse than a clear refusal. The probe costs
one round trip **per container start or image change**, not one per card
refresh, and a target you fix clears itself on the next refresh with no restart.

## No long-lived shell (`persistentShell: false`)

`docker` and `ssh` do not offer a persistent shell. cc takes its documented
fallback: **every redirected shell command runs as its own one-shot command**,
with the working directory passed explicitly and read back afterwards.

**The headline difference: `cd` persists across commands, but exports, shell
functions and background jobs do not.** That matches the local Claude Code
experience, whose `Bash` tool also carries only the working directory.

Three further differences the mode really has, stated rather than glossed:

1. **Each command gets a fresh login shell**, so anything your profile files
   print would land in the command's output. cc's command framing brackets each
   command with a sentinel to stop that — load-bearing here in a way it is not
   for a persistent shell.
2. **A working directory deleted since the last command fails the NEXT command**
   with "no such file or directory", rather than running it somewhere. A
   persistent shell would have kept running in the deleted directory.
3. **The command rides the shell exec form**, so what it needs of the target is
   *that form's* login shell (`bash -lc`) — not the shell a persistent session
   would have been opened with.

If you need exported variables or a background job to survive between commands,
put them in a single command, or in a profile file on the target.

## Registration is automatic, and says why when it fails

The plugin registers its two cc System rows — `docker` and `ssh` — on startup,
creating only what is missing. It never blocks startup and never retries in a
loop; when it fails, the state and cc's **own message** are shown, with a single
retry button.

| State | Means |
|---|---|
| `ok` | the row is live |
| `blocked` | cc refused it (400). Most often: the projects root sits inside a git repository, which cc will not place session roots under. cc's message names the directory and the fix |
| `unreachable` | cc spawned the launcher and the handshake failed — a bug in this plugin, not your configuration |
| `unsupported` | this code-conductor predates Systems support |
| `skipped` | no `CONDUCTOR_URL` — the plugin is running standalone |
| `error` | anything else, with the status and body shown verbatim |
