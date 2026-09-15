# There is no long-lived shell, and nothing carries over between commands

**What:** cc's protocol has no persistent shell of any kind — not as a
capability, not as a frame, not as a negotiable option. Every redirected shell
command is its own one-shot `exec`, with `cwd` passed explicitly on the request.

**The user-visible consequence, and it is the headline: NOTHING PERSISTS
BETWEEN COMMANDS — not even the working directory.** cc's
`docs/systems-protocol.md` §5 calls this **"CAPTURE, NOT CARRY"**: cc reads
`$PWD` back so it can *tell* the worker where its command ended, and never feeds
that value into the next command's `cwd`. Every command starts at the project
root, and a command that ended elsewhere gets a notice saying its `cd` was
discarded. Exports, shell functions and background jobs do not survive either.

Three further differences the mode really has:

- **Each command gets a fresh login shell**, so profile-file output would land
  in the command's output on *every* command — the framing's *opening* sentinel
  is what stops it.
- **A cwd deleted since the last command fails the NEXT command** with `ENOENT`
  rather than running it somewhere.
- **The command rides the `exec` frame's `shell` form**, so what it needs of the
  far side is that form's login shell (`bash -lc`).

**How to apply:**

- Don't implement a long-lived shell for any kind, and **don't add `stdin`
  handling of any kind.** `stdin` and `stdinClose` are deleted frame types: cc
  never sends them, and §2's rule is that an unknown type is **ignored**. Our
  frame loop has no arm for them, so they fall to the default-ignore path — that
  is correct by construction, and pinned by
  `tests/launcher-frames.test.mjs` → *"a deleted frame type is IGNORED"*.
  Answering `EUNSUPPORTED` would be a protocol violation, and killing the
  running command (which an earlier version did) would be worse.
- **The `exec` frame's own `stdin?: 'ignore' | 'pipe'` field is a different
  thing and is live.** One-shot stdin stays; we honour it.
- `persistentShell` is not a capability. cc's `Capabilities` interface is
  `processGroupSignal`, `remotes`, `remoteDescriptors` — see
  [host-kind-and-conformance.md](host-kind-and-conformance.md).

**A PROVIDER-PRIVATE shell is a different thing, and it changes none of the
above.** The `docker` kind holds one `docker exec -i … /bin/sh` open as a
TRANSPORT optimisation ([docker-channel.md](docker-channel.md)) — it is invisible
to cc, carries no state between ops (each op is its own `/bin/sh -c` with its own
environment prefix), and admits only frames whose `cwd` is cc's placeholder `/`.
Nothing about "capture, not carry", the fresh login shell for the `shell` form,
or the deleted `stdin`/`stdinClose` frames is affected.
