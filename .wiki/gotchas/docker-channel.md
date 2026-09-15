# The held-open `docker exec` channel: what had to be measured

**What:** the `docker` kind holds one `docker exec -i <container> /bin/sh` open
per (container, identity, remote) and writes framed commands into it, instead of
paying a fresh `docker exec` per frame. Everything below was measured against a
live container rather than reasoned about, because each item has a plausible
wrong answer that only shows up on a real target.

Cross-references: [docker-exec-transport.md](docker-exec-transport.md) (the
per-op path this replaces), [kill-relay.md](kill-relay.md) (the relay this keeps
working), [file-ops-over-exec.md](file-ops-over-exec.md) (the `readFile` /
`writeFile` scripts that now ride it),
[no-persistent-shell.md](no-persistent-shell.md) (why cc still has no
long-lived shell even though the provider holds one).

## 1. The cost is the SPAWN, not the command

`docker exec … true` costs the same as `docker exec … stat`. Measured through
the shipped launcher (`node tests/bench-channel.mjs`, Docker Engine 29.7.2,
`node:24-slim`, 15 samples per op): **84–95 ms median** per frame on the per-op
path, **2–7 ms** on the channel — 13x to 43x. That is ~95 % of the latency a
remote-backed worker pays on the file path, and no cc-side change addresses it.

## 2. Per-op reap granularity survives a shared channel — the load-bearing result

The token must ride as the far-side **command's environment prefix**
(`CC_EXEC_TOKEN=<tok> /bin/sh -c '<script>'`), never as the channel's own
`docker exec -e`. Measured at the box with an op of
`CC_EXEC_TOKEN=<tok> /bin/sh -c 'sleep 300 | cat'`:

- the channel shell's own `/proc/<pid>/environ` carries **0** tokens;
- three container processes carry the op's token (the op `sh` and both pipeline
  members);
- the **unmodified** `buildReapScript(tok)`, run exactly as `docker.mjs`'s
  `reap` runs it, answers `CCREAP ok 2 9` and leaves **0** processes carrying it;
- the channel **survives** and answers the next command;
- the reaped op still emits its sentinel, with `$?` = **137** — so a reaped op
  *settles* rather than wedging the channel, and its pool slot is reclaimed.

A channel-wide token would instead mean reaping one op killed the channel and
every other op on it. `reapscript.mjs` and `docker.mjs`'s `reap` are unmodified.

## 3. dash OVER-READS its command stream — the ready marker is load-bearing

Framing the payload by exact byte count alone does **not** work. Measured:

```sh
{ printf 'head -c 5 > /dev/null; echo AFTER\n'; printf 'ABCDE'; printf 'echo TAIL\n'; } \
  | docker exec -i <ctr> /bin/sh
```

prints `AFTER` and then `ABCDE​echo: not found`. dash read a whole buffer from
the pipe, swallowing the payload before `head` ever ran, and then parsed it as
script text. A first prototype hung on every `writeFile` for exactly this.

The fix is a **ready marker**: the command emits `\nCCRDY-<nonce>\n` first, and
the host releases the payload only when it comes back — by which point the shell
has finished parsing and its input buffer is empty, so `head -c <n>` reads
exactly the payload out of the pipe. The op is written as a **single compound
command** (`{ …; }`), which is what makes that guarantee independent of the
shell's buffer size: a shell cannot execute any part of a compound command before
it has parsed all of it.

The byte count is still the frame — no delimiter anywhere — so the criterion
"framed by exact byte count, unspoofable by content" holds; the marker is what
makes the count *reachable* on dash. Verified: 20 consecutive `writeFile` +
`readFile` round trips byte-exact with payloads containing NUL, newlines, `'`,
`$` and backticks, and 1 MiB written in 26 ms / read in 27 ms.

## 4. A missing binary is `env` failing to exec, NOT docker failing to start

This is the one place the two paths could have diverged, and it mostly does not.
cc's `#derive` prepends `env LC_ALL=C` unconditionally, so **argv[0] of every
derivation is `env`**. Measured, all four combinations:

| case | per-op spawn | channel |
|---|---|---|
| a table row's binary is missing (`env LC_ALL=C nosuchbin …`) | exit 127, **stdout empty**, stderr `env: 'nosuchbin': No such file or directory` | **byte-identical** |
| `env` itself is missing | exit 127, stdout `OCI runtime exec failed: …`, **stderr empty** | exit 127, stdout empty, stderr `/bin/sh: 1: env: not found` |

`classifyFailure`'s OCI row requires `stderr === ''` *and* an `OCI runtime exec
failed: exec failed: ` stdout prefix, so it does **not** fire on the first case
on either path: both produce an `exit` frame with 127 and cc's `classifyStderr`
answers `ENOENT` from the `No such file or directory` tail. Ten of the eleven
admitted rows therefore have **no divergence at all**.

**The one real divergence is `env` itself missing**: the spawn path reports
`ENOENT` (docker's never-started message), the channel reports `EUNKNOWN`/127.
`src/baseline.mjs` does not probe `env` — nor `readlink`, `mkdir`, `chmod`,
`unlink`, `rm` or `ln`; `PROBE_SCRIPT` covers only `find -printf`, `realpath -e`,
`stat -L -c`, `base64` and `/bin/bash`. A target with `stat`, `find`, `realpath`
and `base64` but no `env` is not reachable in practice — all four are GNU
coreutils — but that is an inference about packaging, not a probe, and it is
stated here as one.

**The liveness probe is strictly MORE robust on the channel**: `true` resolves to
the shell's builtin under `/bin/sh -c`, so it cannot produce a not-found at all,
where the spawn path execs `/usr/bin/true`.

## 5. A channel shell dies with its host client; a running command does not

SIGKILLing the **host-side** `docker exec` client, with no stdin close, left
**0** bare `/bin/sh` in the container within 2 s. That is the opposite of
[kill-relay.md](kill-relay.md)'s measurement — and both are true: a shell
*blocked on the exec's stdin* dies with its client, while a *running command*
does not. Which is why the channel needs no reap token of its own and joins no
reap set, and why each **op** still does. Closing stdin also ends it cleanly
(exit 0).

## 6. Stream separation and sentinel forgery

stdout and stderr stay separate over the channel and each carries its own
sentinel; the call settles on the **AND** of both. A script printing a
foreign-nonce `\nCCEND-deadbeefcafe 0\n` does not settle the call early — which
is the whole reason the nonce is minted per call (`fileops.mjs`'s `makeNonce`)
rather than being a fixed string.

## 7. Error semantics are unchanged over the channel

Driving the real `fileops.mjs` scripts: `ENOENT`, `EISDIR`, `EEXIST` and the
`EACCES`/`ENOENT` dirname case all classify identically to the spawn path.
`head -c N` does not over-read a pipe (GNU coreutils 9.1): `head -c 4` then `cat`
yields the exact remainder, and `head -c 100000 | wc -c` = 100000 with 200000
bytes following.

## How to apply

- **Never give the channel a `CC_EXEC_TOKEN`.** §2 is why. The token belongs on
  the op's command prefix, and `reapscript.mjs` stays untouched.
- **Never write a payload before the ready marker comes back.** §3 is why, and
  `tests/channel.test.mjs`'s payload round-trip test *hangs* if the marker is
  removed rather than failing — do not "simplify" it away.
- **Route by exact command vector, never by argv form.** `project_bash` and every
  `worktrees.ts` git call are argv-form too. The table is
  `src/launcher/admission.mjs`; `docs/protocol.md` → "The held-open channel" is
  its specification.
- **Admission failing closed is silent** — a de-admitted row costs ~90 ms again
  and reds nothing. That is what the one-shot drift line on stderr is for.
