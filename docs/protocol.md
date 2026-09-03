# Interface contracts

What this plugin puts on the wire: the `hello` each kind sends, the `remoteId`
routing rules, the derived file-operation scripts, the auto-registration
exchange, and the backend REST surface.

The wire contract itself is code-conductor's `docs/systems-protocol.md`; this
page records only **our** side of it.

## The handshake

Sent once, before any other frame, in answer to cc's `hello`.

```json
{"type":"hello","protocol":1,"provider":"code-system-docker/0.1.0",
 "capabilities":{"persistentShell":false,"processGroupSignal":false,
                 "remotes":true,"remoteDescriptors":false},
 "system":{"os":"linux","pathSep":"/","shell":"/bin/bash","home":"/root"}}
```

| Capability | `docker` | `ssh` | `host` |
|---|---|---|---|
| `persistentShell` | `false` (permanent) | `false` (permanent) | `true` unless `--no-persistent-shell` |
| `processGroupSignal` | `false` until card 2026-0003 | `false` until card 2026-0004 | `true` unless `--no-process-group-signal` |
| `remotes` | `true` always | `true` always | at least one `--remote` |
| `remoteDescriptors` | `false` | `false` | at least one `--mirror`/`--exclude` |

### `system.shell` is mandatory ceremony, and inert for us

We send the absolute constant `/bin/bash`, per kind, always. It is **required**:
`protocol.ts:225` types it `system: { shell: string } & Partial<SystemDescriptor>`,
and a hello with a missing, relative or empty value is refused `EPROTO` at the
handshake (`providerConnection.ts:242-249`), which would fail registration.

It is also **never read for `docker` or `ssh`**. cc consumes it in exactly one
place — `src/systems/providerShell.ts:360`,
`this.#host.descriptor?.shell ?? '/bin/bash'` — inside the **persistent-shell**
path, and `protocol.ts:205` says so plainly: *"cc uses `shell` to open the
long-lived shell and reports the rest."* Both kinds advertise
`persistentShell:false`, so that shell is never opened. (The field is expected to
be dropped from cc.)

So: **do not probe for it, do not make it configurable, and do not derive it from
anything.** There is no per-remote `shell` in the store — there is no consumer
and there is not going to be one. `host` is the only kind whose value is actually
used, and only incidentally: it really does open a persistent shell, which is
what keeps two of cc's three core conformance configurations runnable.

It cannot be probed anyway: cc registers by handshaking with **zero remotes
configured**, and its handshake budget is 10 s (`providerConnection.ts:64`),
which an ssh cold connect can exceed.

`docker` and `ssh` advertise `remotes:true` **always**, never derived from what
is in the store — cc memoises the handshake per connection generation, so a
capability that flapped as remotes were added would be memoised wrong. See
`docs/architecture.md` for what that costs and why it is accepted.

## `remoteId` routing

Carried by the four **request** frames only — `exec`, `readFile`, `writeFile`,
`describeRemote` — and by nothing else. An id is bound to one remote for its
whole lifetime; `stdin`, `stdinClose`, `signal`, `close`, `data` and `end` are
addressed by `id` alone and we never look for a `remoteId` on them.

| Situation | Answer |
|---|---|
| no `remoteId`, on a kind advertising `remotes` | `ENOREMOTE`, **id-addressed** — we have no default |
| unknown / absent / unreadable record | `ENOREMOTE`, id-addressed |
| record at another schema | `ENOREMOTE`, quoting the schema found, naming the backend as the repair |
| record whose `kind` is not this launcher's | `ENOREMOTE`, naming the kind it actually is |
| record whose `baseline.state` is `unsupported` | `EUNKNOWN`, id-addressed, naming the missing capability, `stderr` carrying the target's own words |
| record whose `baseline.state` is `unknown` | **served** — absence of evidence is not evidence |
| path or non-placeholder `cwd` outside a fenced remote's root | `EACCES`, id-addressed |
| `describeRemote` without `remoteDescriptors` | `EUNSUPPORTED`, id-addressed |
| a frame for an unknown or already-settled id | **dropped**, not an error |
| an unknown frame **type** | **ignored** — the contract's extension point |
| a malformed line, or one past `MAX_LINE_BYTES` | `EPROTO`, **id-less**, then exit non-zero |

**Id-addressing is a MUST, not a nicety.** An id-less `error` frame is
connection-level and would fail every *other* target's in-flight work
(`systems-protocol.md:598`).

**`cwd: "/"` is accepted and never fenced.** Every derived operation cc sends
(`stat`, `readDir`, `realpath`, `mkdir`, `removeTree`, `unlink`, `chmod`)
carries `/` as a placeholder with its real target in `argv`. A kind that fenced
it would refuse every derivation while `exec` and the file primitives kept
working.

**`CC_REMOTE`** is injected into the remote command's environment whenever a
frame named a remote. It is positive routing evidence: on a host where two
targets may be the same filesystem, "the command worked" is what a misroute also
looks like.

## `readFile` / `writeFile` — derived over `exec`

Both are derived from `exec` in `src/launcher/fileops.mjs`, **once for every
kind**. The target must satisfy cc's POSIX/GNU baseline anyway (cc's own derived
operations are `exec` frames against that toolchain), so `base64` is already
required and a `docker cp` / `scp` path would buy no capability — only a second
code path to keep correct.

Each script runs under `/bin/sh -c` through the **argv** form, not the `shell`
form: `bash -lc` is a *login* shell whose profile output would arrive before the
script's own, and the reads parse the first line.

**read** — one round trip:

1. exists? (`-e`, which follows symlinks, so a broken link is `ENOENT`) → dir?
   → readable?
2. `stat -L -c '%f %s'` for the **whole file's** raw mode and size
3. compute the requested extent; above `MAX_FILE_BYTES` refuse `EFBIG`
   **before transferring a byte**
4. `CCSTAT <mode-hex> <size>` then
   `tail -c +<off+1> | head -c <want> | base64 | tr -d '\n'`

`isBinary` is a NUL within `BINARY_SNIFF_BYTES` of **the returned range**, not
of the file. The payload is then chunked at `CHUNK_BYTES` into `data` frames —
both ends MUST chunk — followed by `end`.

**write** — payload buffered from `data` frames, then one round trip on `end`,
with the base64 riding on the command's **stdin** (never argv):

| Mode | Script |
|---|---|
| `atomic` | `mkdir -p` the parent, decode to `<path>.<pid>.<seq>.tmp`, `chmod`, `mv -f` over — the rename is what makes `mode` **preserving** |
| `exclusive` | test `-e` → `EEXIST`; otherwise a direct redirect |
| plain | a direct truncating redirect, matching `fs.writeFile`, which **preserves** an existing file's mode |
| `atomic` + `exclusive` | **refused** — an atomic write ends in a rename, which overwrites by definition |

**The far-side scripts normalise their own failure text to POSIX `strerror`
tails** — `No such file or directory`, `Permission denied`, `File exists`,
`Not a directory`, `Is a directory`, `No space left on device`. Shells disagree
here (`set -C` gives "cannot overwrite existing file" on bash and "File exists"
on dash; a failed redirect says "Directory nonexistent" on dash and
"No such file or directory" on bash) while cc's classifier matches on the tail.
cc's callers branch on the resulting codes — "create the file unless it already
exists" is written as *catch `EEXIST`* — so this is a MUST, not tidiness.

## Auto-registration

`src/registration.mjs`, once, after `listen`, never blocking startup.

Desired rows — the argv is a function of **(install path, kind) only**, so cc's
per-`(row.id, JSON.stringify(argv))` handle cache holds one connection while
remotes come and go:

| id | label | launch |
|---|---|---|
| `docker` | Docker containers | `[process.execPath, <abs>/src/launcher/main.mjs, "--kind", "docker"]` |
| `ssh` | SSH hosts | `[process.execPath, <abs>/src/launcher/main.mjs, "--kind", "ssh"]` |

`process.execPath` rather than a bare `"node"`: cc spawns without a shell, so a
bare name would depend on the orchestrator's PATH.

1. no `CONDUCTOR_URL` → `skipped` (standalone-runnable is a compliance
   requirement). Stop.
2. `GET {CONDUCTOR_URL}/api/settings/systems`; **404** → `unsupported` (this cc
   predates Systems support); network error or non-2xx → `error`. No retry.
3. per row: absent → `POST`; present with a matching `launch` → **send
   nothing** (a PATCH would make cc re-probe on every backend restart,
   `appSettings.ts:604-607`); present with a different `launch` → `PATCH {launch}`.

| From cc | State | Shown |
|---|---|---|
| `201` / `200` | `ok` | the row is live |
| `409` | `ok` | already exists — a race with another instance |
| `400` | `blocked` | **cc's message, verbatim** — usually the `.git`-ancestor placement refusal, whose text already names the directory and the fix |
| `502` | `unreachable` | cc's message (it embeds our stderr tail), plus that this is a bug signal in the plugin, not a user error |
| `404` on the collection | `unsupported` | this cc has no Systems support |
| anything else / network | `error` | status and body, verbatim |

Every one of these is a **recorded state** — never a throw, never an exit, never
a retry loop. "Never crash-loop" is implemented by there being no loop: the one
retry is `POST /api/registration/retry`, driven by a button. State is in memory
only and re-derived at every start.

## Backend REST

| Route | Purpose |
|---|---|
| `GET /api/health` | any response counts as alive |
| `GET /api/registration` | `{state, rows:[{id,state,httpStatus,message}], checkedAt}` — `blocked`/`unreachable` messages are rendered verbatim |
| `POST /api/registration/retry` | the only retry; user-driven |
| `GET /api/remotes` | every stored remote, each with a live `reachability` and a `baseline`; an unreadable record appears as `{remoteId, broken:{reason,message}}` rather than being hidden |
| `POST /api/remotes` | create — validates the `remoteId` charset, delegates `config` to the kind. 400 / 409 |
| `PATCH /api/remotes/:id` | edit everything **except** `remoteId`; a changed `config` resets `baseline` to `unknown` |
| `DELETE /api/remotes/:id` | delete, **warning** when any cc project still names this `remoteId` |

`remoteId` charset: `^[a-z0-9][a-z0-9._-]{0,63}$`, never `.` or `..`. It is both
a filename stem and the entire hand-off contract to a cc project's *Remote*
field, so it must be human-typable and is **never renamed** once created — which
is why the delete route warns: cc has no `listRemotes` frame, so nothing else
would tell the user which projects they just stranded.
