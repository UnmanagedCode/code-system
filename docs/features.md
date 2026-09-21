# Features

What the plugin does for a user.

## Remotes are cards

Each **remote** — one Docker container, or one SSH host — is one card. The card
UI is where a remote is added, edited and removed, and this plugin is the
**only** catalog of remotes: cc's protocol has no `listRemotes` frame, so cc
never knows what remotes exist. It only knows the `remoteId` string a project's
*Remote* field is set to.

The catalog has **two read surfaces** — the cards, and the `list_remotes` MCP
tool below — and one writer: adding, editing and removing a remote happens in
the card UI and nowhere else.

That makes `remoteId` a hand-off contract:

- it is **human-typable** (`^[a-z0-9][a-z0-9._-]{0,63}$`), because a user reads it
  off a card and pastes it into cc;
- it is **never renamed** once created — everything else on a card is editable;
- **deleting a remote warns** when cc projects still name it, listing them.
  Nothing else would tell you which projects you just stranded.

## An agent can list the remotes

The `list_remotes` MCP tool answers "what remotes exist, and can I use them" as
plain text — one line per remote:

```
connected  app-ctr  docker  container=app  "App container"
not connected  buildbox  ssh  host=my-box  "Build box"
disabled  db  docker  container=pg  "Postgres"
not readable  bad-rec
```

Each line carries the status, the `remoteId` to paste into a project's *Remote*
field, the kind, what that kind points at, and the label. Nothing else — it is a
catalog, not a card.

**The status is one word for the two facts a card keeps apart** (see below), and
the gate wins:

- **`disabled`** — the gate is off. The remote refuses every command, so its
  target is **not contacted at all** and the line says nothing about it.
- **`connected` / `not connected`** — the gate is on, and this is a fresh probe
  of the target, asked while answering.
- **`not readable`** — the stored record could not be read. The line carries the
  `remoteId` and nothing else, because nothing else about it is known.

The tool **changes nothing**: it never writes a record, and never starts, stops
or alters a target. Adding, editing, connecting and removing a remote all stay
in the card UI.

**A new or changed tool is not live until the conductor restarts.** Same
mechanism as every other stale-plugin-state surprise — see
[`.wiki/gotchas/host-environment.md`](../.wiki/gotchas/host-environment.md).

## A card shows two things, and they disagree routinely

Every card carries **two independent facts**. Reading one as the other is the
single most likely way to misdiagnose a remote, so they are two separate
elements on the card and never share a word:

| | What it is | What moves it |
|---|---|---|
| **Enabled / Disabled** | the **operator gate** — what *you* set | the Connect / Disconnect button, and a config edit |
| the dot and status line | the **probe** — what is true right now | the target itself, re-asked on every refresh |

The gate is the **only** thing that decides whether a command runs. The probe
never gates anything; it is there so a switched-off card still tells you the
truth about its target.

All four combinations happen, and each means something different:

| Gate | Probe | The card reads | What to do |
|---|---|---|---|
| Disabled | running / up | `Disabled` + the target is fine | turn it on when you want it |
| Disabled | stopped / down | `Disabled` + the target is not there | nothing — this is what you asked for |
| Enabled | running / up | `Enabled` + up | ready |
| Enabled | **stopped / down** | `Enabled` + a **warning** | see below — it differs by kind |

The last row is the one worth reading carefully:

- **Docker.** The container is not running, so nothing can reach it. code-system
  **will not start it** (see below) — start it yourself and the card clears on
  the next refresh.
- **SSH.** The shared connection is down, and **commands still work**. Each one
  just pays its own authentication instead of sharing one. Connect again to get
  the multiplexing back. This is a performance warning, not a broken remote.

## A disabled remote refuses every command

A remote you have not connected is **switched off**, and every operation against
it is refused — by code-system itself, on cc's host. **The target is not
contacted at all**, so a refusal is never evidence that anything is wrong with
it. The message says exactly that, and names the fix: connect it in this UI.

Three consequences worth knowing before they surprise you:

- **A new remote starts disabled.** Add it, then connect it. (For an SSH remote
  this is simply the truth: no shared connection exists until you connect.)
- **Connect before you set a project's *Remote*.** cc checks that the provider
  serves a target before it writes the field, and a remote it has never reached
  while switched on is refused — so the working order is: add the remote →
  connect it → then set *Remote*.

  Be precise about what that check does and does not catch, because it is
  asymmetric. cc remembers a *successful* check for the life of its connection
  to the provider, and does not re-ask. So **switching a remote back on takes
  effect immediately** (a refusal is never remembered), while **switching one
  off does not retroactively unbind it** — a project already pointed at it stays
  bound, and cc may still accept a fresh binding, until that connection is
  re-established. Nothing is unsafe about this: every command against a
  switched-off remote is still refused, by this plugin, before the target is
  contacted. Only cc's advisory "is this remote real" answer lags.
- **Changing a connection value switches it off.** A different container or host
  may be a different target entirely, so the gate and the tooling verdict both
  reset. Saving with every value unchanged — including editing only the
  **label** — does not: what counts is whether a value actually changed, not
  whether you opened the form.

## Connecting is attach-only

Connecting to a remote never starts or stops anything. This plugin never runs
`docker start`, `docker stop`, `docker run` or `docker rm` — it only attaches to
a container that is already running, or opens an ssh connection to a host that
is already up. Connecting a remote whose container is stopped **succeeds** — the
gate is your setting, not a claim about the target — and the card goes on saying
the container is not running until you start it.

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

A **Docker** target specifically needs GNU coreutils and findutils, a POSIX
`/bin/sh`, an executable **`/bin/bash`** (the `shell` exec form is a login
`bash -lc`), plus `base64`, `tr` and `env`.

Alpine (busybox) is the common surprise. Measured against a live
`busybox:1.38.0` container, the card shows **four** missing capabilities, and
only three of the four announce themselves:

| Missing | How it shows |
|---|---|
| `readDir` | `find` has no `-printf` — `find: unrecognized: -printf`, exit 1 |
| `realpath` | accepts neither `-e` nor `--` |
| `shell` | no `/bin/bash`, which the `shell` exec form needs |
| `stat` | **the dangerous one**: it *succeeds* and is wrong, silently dropping sub-second mtime precision |

The probe checks the exact commands cc sends, in their exact forms, and asserts
on the *output shape* — not the exit code — precisely because of that last row.
The card lists all four, each with the probe that caught it and the target's own
words. Distroless and scratch images have no shell at all and will not work.

A **stopped container reads as not running, and the plugin will not start it**
(see "Connecting is attach-only" above). A request routed at one answers
`ENOREMOTE` naming the container, not a plausible command failure — and that is
a different refusal from a switched-off remote's, which says so in words.

A remote marked `unsupported` is refused **whole**, with a message naming the
missing capability: half-working is worse than a clear refusal. The probe costs
one round trip **per container start or image change**, not one per card
refresh, and a target you fix clears itself on the next refresh with no restart.

## No long-lived shell — and nothing carries over between commands

There is no long-lived shell in cc's protocol at all. **Every redirected shell
command runs as its own one-shot command**, with the working directory passed
explicitly on the request.

**The headline difference: nothing persists between commands — not even the
working directory.** cc reads `$PWD` back only so it can *tell* you where a
command ended; it never feeds that value into the next one. Every command starts
at the project root, and a command that ended somewhere else gets a notice
saying its `cd` was discarded. Exports, shell functions and background jobs do
not survive either.

Three further differences the mode really has, stated rather than glossed:

1. **Each command gets a fresh login shell**, so anything your profile files
   print would land in the command's output on *every* command. cc's command
   framing brackets each one with a sentinel to stop that.
2. **A working directory deleted since the last command fails the NEXT command**
   with "no such file or directory", rather than running it somewhere.
3. **The command rides the `exec` frame's shell form**, so what it needs of the
   target is that form's login shell (`bash -lc`).

If you need a `cd`, exported variables or a background job to survive, put them
in a single command, or in a profile file on the target.

## Advanced card settings

Each card's **Advanced** group holds two kinds of setting, and they behave
differently on save:

| Member | Kind | Editing it |
|---|---|---|
| **Run as** (docker only) | a **connection config** field the kind validates and stores | **switches the remote off**, like any other config change |
| **Mirror root** / **Excluded paths** | operator policy beside the config | leaves the gate and the baseline alone |

### What a worker can see: the mirror root

By default a worker on a docker or ssh remote sees **the project directory and
nothing else**: code-conductor's session root images the project root, and that
is the whole geometry.

Each card's **Advanced** group changes that, per remote. Tick *"Advertise a
mirror root to code-conductor"* and cc is told how much of the target the session
root is the local image of.

| Field | Means |
|---|---|
| **Mirror root** | the path cc's session root becomes the image of, so a worker can read and edit anywhere under it. Defaults to `/` — the whole target |
| **Excluded paths** | prefixes cc never carries across, one absolute path per line. Defaults to the target's pseudo-filesystems (`/proc`, `/dev`, `/sys`) — the exact list is `DEFAULT_MIRROR` in `src/mirror.mjs`, served to the form over `GET /api/remotes` |

- **The group is collapsed unless the remote already advertises a mirror**, and
  a remote that has never opted in advertises nothing — exactly the behaviour
  from before this existed. **These three fields are absent entirely** until the
  card list's first fetch returns, since the defaults they prefill from are
  served by the backend and the form holds no copy of them — the Advanced group
  itself still renders, carrying **Run as**.
- **Paths must be absolute and already in normal form.** `/app/`, `/a/./b` and
  `/a/../b` are refused in the form, because code-conductor refuses to normalise
  a provider's claim about its own layout. An exclude covering the mirror root is
  refused too: no file under it could be read or written.
- **A change reaches code-conductor on the next provider connection.** cc asks
  once per connection generation, so a running session sees it after the System
  reconnects.
- **Editing it does not switch the remote off**, unlike editing a connection
  value — a mirror names the same target.

### Who the actions run as: Run as (docker)

**Run as** sets the identity every docker action on that remote runs as. It is
passed to `docker exec -u <value>` and applies to **all four** docker paths: the
`exec` itself, the derived `readFile`/`writeFile` (which ride the same `exec`),
the tooling-baseline probe, and the kill relay — the relay especially, because it
kills by uid ownership and would otherwise fail to reach a subtree owned by a
different user. It is **not** passed to `docker inspect`, which never enters the
container.

| Value | Means |
|---|---|
| *(empty)* | the image's default user. **No flag is added at all** |
| `node` | a user name in the container |
| `1000` | a uid. **A uid with no `/etc/passwd` entry is accepted by docker and runs** |
| `node:node`, `1000:1000` | a user (or uid) and a group (or gid) |

- **Docker only.** An `ssh` remote's `User` is a connection field — part of the
  destination — not this.
- **The accepted shape** is `IDENTITY_RE` in `src/launcher/kinds/docker.mjs`: it
  must begin with a letter, digit or `_`, and may then carry letters, digits,
  `.`, `_`, `-` and one optional `:group`. **Surrounding whitespace is trimmed**,
  so `" node"` is stored as `node`; an *interior* space, a leading `-`, an empty
  group and anything else are a **400** in the card — which is only moving the
  daemon's own refusal earlier, since it refuses those too.
- **The refusal text is this field's own**, not the shared "it becomes a
  command-line operand" wording the connection fields get: the identity is `-u`'s
  argument, which docker consumes whatever it begins with.
- **Editing it switches the remote off**, unlike the mirror fields beside it.
  This is required, not cautious: the reachability fingerprint is image +
  `StartedAt` and cannot see the identity, so this reset is the only thing that
  re-probes the tooling baseline **as the new user** — and that verdict is
  uid-dependent.
- **An identity the container rejects fails per operation**, not at Connect.
  There is nothing cheap to pre-check (a uid with no passwd entry succeeds), so
  the refusal is an `EUNKNOWN` error frame whose message names the container, the
  identity, and the **Run as** field under Advanced.

## Operator settings

The plugin reads its Docker and SSH access from the environment of the process
that runs it, not from a card field — a card field taking a command line would
be an HTTP-writable executable on cc's host.

**The mirror root above is not an exception to that rule.** It is a **path claim
code-conductor consumes for path arithmetic on its own side** — never argv, never
a shell string, and it reaches no far-side command line
(`tests/mirror-frames.test.mjs`).

**Nor is Run as.** It *does* become argv — `docker exec -u <value>` — which is
exactly why it is validated down to a plain identity shape (a name or uid,
optionally `:group`) before it is stored. It can never be an *invocation* the way
`CODE_SYSTEM_DOCKER` is: it is the single argument of a single flag, and the
identity shape is what the store's front door enforces.

| Variable | For |
|---|---|
| `CODE_SYSTEM_DOCKER` | a host where the docker CLI needs a prefix. It is the **whole invocation** as a JSON array: `CODE_SYSTEM_DOCKER='["sudo","-n","docker"]'`. Default: `["docker"]` — the shipped default never uses `sudo`. A malformed value makes the provider refuse to start and say so, rather than silently falling back |
| `CODE_SYSTEM_SSH` | a host where the ssh invocation must differ (a pinned config file, a wrapper). Also the **whole invocation** as a JSON array: `CODE_SYSTEM_SSH='["ssh","-F","/etc/code-system/ssh_config"]'`. Default: `["ssh"]` — your own `~/.ssh/config` and agent. Malformed values refuse the same way |
| `CODE_SYSTEM_STORE` | where remote records live. Default `<home>/.code-system` |

## An SSH remote is a Host alias from your own ssh config

An SSH card's **host** field is a `Host` alias out of the `~/.ssh/config`
belonging to whoever runs the plugin — not a hostname the plugin resolves
itself. Everything about *how* to reach the machine lives there: `HostName`,
`Port`, `User`, `IdentityFile`, `ProxyJump`, `IdentityAgent`. The plugin adds
only its own connection options and never turns a card field into an ssh
option.

**Host keys are never accepted for you.** The plugin does not set
`StrictHostKeyChecking` and does not point ssh at a `known_hosts` of its own, so
ssh's own default applies — and because the plugin also never allows a prompt,
an **unknown or changed host key fails** rather than being trusted on first use.
The card shows the refusal and names the fix. Adding the key is your own action,
in your own `known_hosts` (`ssh-keyscan`, or verifying the fingerprint by hand).

**Connecting shares one authenticated connection.** The first connect opens an
SSH ControlMaster and later commands ride it, so five commands cost one
authentication instead of five. **Pressing Connect again costs no
authentication** — a remote that is already connected is already in the
requested state, so nothing is opened; the button just checks the existing
connection is still up. If the shared connection died without being
closed (the machine rebooted, or the master was killed), Connect notices and
opens a fresh one.

**What closing that connection does, and what it does not.** Closing the
ControlMaster does not lock the remote out: at the transport level commands
still work afterwards, each paying its own authentication. So when a master
drops **out of band** — someone else runs `ssh -O exit`, or the connection times
out — an enabled remote keeps working, just unmultiplexed, and the card says so
as a warning rather than a failure.

What *does* stop commands is **the gate**, not the connection. Pressing
Disconnect does both: it switches the remote off (which is what refuses
commands) and closes the shared connection (which is only about multiplexing).
Keeping those apart is why the card shows them as two separate things.

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
