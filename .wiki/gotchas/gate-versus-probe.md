# A remote has TWO states, and they disagree routinely

A remote is never "connected or not". It carries two independent facts, and
collapsing them into one word is the single most likely way to misdiagnose it.

| | What it is | Where it lives | Who moves it |
|---|---|---|---|
| **gate** | what the operator SET | `record.enabled`, in the store | the connect/disconnect routes, and a config edit |
| **probe** | what is TRUE right now | nowhere — re-asked every time | the target, or someone else's `docker stop` / `ssh -O exit` |

**Only the gate decides whether an operation runs.** It is enforced at one site:
`gateRefusal` in `StoreRemoteSource.lookup()` (`src/launcher/remotes.mjs:173`),
which `src/launcher/session.mjs:118` calls for all four REQUEST frames and
nowhere else.

**The probe gates nothing.** `Transport.reachability` is never consulted before
running a command. It exists so a switched-off card still tells the truth about
its target, and so the tooling probe can key its cache on a fingerprint.

## What a kind author owes

**Say what your `reachability.connected` is a property of.** The two shipped
kinds answer differently, and the difference is not cosmetic:

- `docker` — a property of **the target**: `State.Running` from `docker inspect`.
  False means nothing can reach it.
- `ssh` — a property of **us**: whether our ControlPath socket answers `-O check`.
  False means we lost multiplexing. **Commands still work**, each paying its own
  authentication (measured — `.wiki/gotchas/ssh-controlmaster-transport.md` §4-§5).

So `connected: false` means "unusable" for one kind and "slower" for the other,
which is why the card's warning text is per kind and why neither is an error.

**Implement `connect`/`disconnect` even with nothing to open.** They are the
gate's per-kind side effect, not a multiplexing feature. `docker`'s are a
documented no-op pass — every `docker exec` is a fresh client, so there is no
channel — and a kind that omitted them would give the operator a Connect button
that silently does nothing on one kind and works on another.

## Why the gate could not just BE the socket

For `ssh` it is tempting: the ControlMaster's existence is already shared state
between the backend and the launcher with no IPC. It does not work, for two
reasons that are each sufficient.

1. **Closing the master does not stop commands.** Measured. So "no socket" would
   mean "still fully usable", and the gate would gate nothing.
2. **`docker` has no equivalent artifact at all.** There is nothing to create or
   destroy, and inventing one would be a marker file pretending to be a
   connection.

The gate is therefore a store field. That also buys the no-restart property for
free: the store has no cache (`src/store.mjs:1-16`), and `lookup` runs per
frame, so a toggle flipped in the UI reaches a launcher cc spawned minutes ago
on its very next frame. **The absence of a cache is the mechanism** — adding one
would break the gate, not merely slow it.

## Consequences that surprise people

- **A cc project cannot be pointed at a disabled remote at all.** cc's
  `assertRemoteKnown` runs at `PUT /api/projects/:name/remote`, before anything
  is written, so the operator's order of work is: add → connect → then set
  *Remote*.
- **A disabled remote is never probed either.** The tooling-baseline probe execs
  INTO the target but runs in the backend, bypassing `lookup`, so `enabled` is
  part of `refreshBaseline`'s condition (`src/baseline.mjs`).
- **`reap` is not gated**, deliberately: it does not pass through `lookup`, and
  gating it would abandon far-side processes at shutdown.

Related: `docs/features.md` owns the user-facing wording,
`docs/protocol.md` owns the `ENOREMOTE` argument and the wire shape, and
[[refusal-message-errno-tokens]] owns what the refusal's text may not contain.
