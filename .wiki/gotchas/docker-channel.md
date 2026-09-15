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

## 3b. The marker guarantees the payload ARRIVES, not that the op READS it

This is the hazard §3's fix does not close, and it bites on the refusal path
`docs/protocol.md` calls the common one.

Every refusal `buildWriteScript` can produce runs **before or inside**
`base64 -d`: the `exclusive` `EEXIST` pre-check, the `set -C` noclobber failure,
`ENOTDIR`/`ENOENT`/`EISDIR`/`EACCES` on the target or its dirname, and `ENOSPC`
mid-decode. When the op exits there, `head -c <n>` dies of EPIPE with the
remainder **still unread** — and that remainder is sitting in the *channel's*
stdin, where the shell reads it as script text and fuses it with the next op's
command.

**The shape of the damage is the worst one there is: the op that causes it
reports correctly.** Reproduced through the production path — a 256 KiB
`writeFileOp({exclusive: true})` against an existing file answered `EEXIST`
exactly as it should, and the **next `readFile` on that launcher** died
`ETRANSPORT: the channel ended`.

**Do not reason in thresholds.** Measured, 64 KiB poisoned the channel in one run
and 65 KiB did not: it depends on how much `head` had pumped into its downstream
pipe before the EPIPE, which is not knowable from the host side. A *small*
payload is safe only incidentally — it fits a pipe buffer, so `head` drains the
channel before the op exits. That is why every existing round-trip test passed:
they are all successes, and the live `EEXIST` row uses a 34-byte payload.

**The fix is exit 0, not a size.** A successful payload op provably drained —
`base64 -d` reads to EOF — so any payload op that settles non-zero retires its
channel. Lazy reopen is already the status quo for a channel death, so it costs
one open.

A `cat > /dev/null` drain inside the compound command is **not** the cheap
alternative: with the channel's stdin as its source it blocks until the channel
closes.

## 3c. A `writeFile` is slow AND silent, which no output-only watchdog can see

Between the ready marker and the sentinel a `writeFile` emits **zero bytes on
either stream by construction** — the whole transfer is on stdin. So the general
claim "a legitimately slow op is a progressively noisy op" has exactly one
exception, and it is the op that takes longest. An output-only idle timer would
kill a healthy, progressing write; the timer therefore also counts host-side
stdin write progress, one pipe buffer at a time, using each chunk's **write
callback** (`drain` fires once near the end, not per chunk).

Severity, because it sets how much this matters: a kill mid-`base64 -d` leaves an
**atomic** write's target intact with a stray `<path>.<pid>.<n>.tmp` beside it,
and a **plain or exclusive** write's target **truncated** — the redirect is
straight into the target. The `rm -f` cleanups in `buildWriteScript` run on a
non-zero exit, not on a SIGKILL.

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

## 8. cc DISCARDS a cleanly-exiting provider's stderr, so the drift alarm needs a seam

The two diagnostics `src/launcher/session.mjs` emits — the one-shot
admission-drift warning and the shutdown census — go to the launcher's **stderr**,
and nothing else observes that stream. cc's `ProviderConnection`
(`src/systems/providerConnection.ts`) spawns the provider with
`stdio: ['pipe','pipe','pipe']` and drains stderr into a **bounded tail** it
prints **only inside an ETRANSPORT message**, i.e. only when the provider dies or
fails to start. A launcher that exits 0 has everything it said thrown away —
which is exactly the run in which the drift alarm matters, since admission fails
closed and every outcome stays correct.

So `tests/conformance-docker.mjs` launches the provider through a shell that
appends fd 2 to a per-arm file:

```
/bin/sh -c 'log=$1; shift; exec "$@" 2>>"$log"' sh <log> <node> <main.mjs> --kind docker
```

**`exec` is load-bearing**: it replaces the shell, so the launcher keeps the pid
and the position in the process tree that cc's kill and the runner's watchdogs
address. `"$@"` carries argv byte-for-byte, and the log path rides as `$1` so a
scratch path is never shell syntax. `tests/launcherDiagnostics.mjs` reads the
file back; a drift line **reds the arm**, the census is summed and printed, and
everything else is echoed as `launcher said — …` — which is what replaces cc's
tail, since the redirect means an ETRANSPORT message no longer quotes one.

The marker text lives once, in `session.mjs`'s exported
`ADMISSION_DRIFT_WARNING` / `CHANNEL_CENSUS_PREFIX`, imported by both the emitter
and the reader, so a reworded line cannot make the alarm unmatchable.

## How to apply

- **Never give the channel a `CC_EXEC_TOKEN`.** §2 is why. The token belongs on
  the op's command prefix, and `reapscript.mjs` stays untouched.
- **Never write a payload before the ready marker comes back.** §3 is why, and
  `tests/channel.test.mjs`'s payload round-trip test *hangs* if the marker is
  removed rather than failing — do not "simplify" it away.
- **Never return a channel to the pool after a payload op exits non-zero.** §3b
  is why, and the failure it causes lands on a later, unrelated op.
- **Never make the idle watchdog output-only.** §3c is why: the phase it would be
  blind to is the longest one, and killing it can truncate a target.
- **Route by exact command vector, never by argv form.** `project_bash` and every
  `worktrees.ts` git call are argv-form too. The table is
  `src/launcher/admission.mjs`; `docs/protocol.md` → "The held-open channel" is
  its specification.
- **Admission failing closed is silent** — a de-admitted row costs ~90 ms again
  and reds nothing in cc's battery. The one-shot drift line is the only signal,
  and §8 is why it needs a seam to be heard at all: never "simplify" the bound
  runner's provider argv back to a bare launcher spawn.
