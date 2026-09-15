# cc RE-PARSES a refusal's message text, so the prose is part of the contract

A provider's `error` frame carries a structured `code`. On two cc paths **that
code is ignored** and a new one is derived from the `message` **text**:

- `runGit` — `src/worktrees.ts:226` at the pin
- `ProviderShell` — `src/systems/providerShell.ts:229` at the pin

Both drop `spawnErrorCode` and call `classifySpawnError`, which is
`new RegExp('\\b' + code + '\\b').test(message)` over cc's `FS_ERROR_CODES`
(`classifySpawnError`, `src/systems/protocol.ts`).

## The failure mode

A refusal whose message contains a standalone FS errno token —

    ENOENT  EACCES  EEXIST  ENOTDIR  EISDIR  ENOSPC  ENOTEMPTY  EINVAL

— is **silently reclassified as the command's own failure**. An administrative
refusal ("this remote is switched off", "this target fails the tooling
baseline") renders as *git answered non-zero*, shown as git's own stderr, with
**no system-level signal at all**. Nothing logs it. The operator sees a git
error for a git command that never ran.

It is a `\b` word-boundary match on the whole message, so it fires anywhere in
the sentence, including inside a quoted error you are helpfully passing through
from the target.

## What to do

**Any message a kind or the launcher puts on an `error` frame must not contain a
bare FS errno token.** That includes:

- `gateRefusal` and `baselineRefusal` (`src/launcher/remotes.mjs`)
- every kind's `classifyFailure` message
- anything quoting a target's own stderr into `message`

If you need to convey one, spell it in prose ("no such file") or keep it inside
a longer token the word boundary will not isolate.

`tests/gate.test.mjs` pins this for the gate refusal, and builds its list from
the shipped `FS_ERROR_CODES` rather than a hand-copied one, so a new FS code
cannot slip past.

## The companion fact

**`stderr` on an `error` frame reaches nobody.** cc drops it on the exec path
(`src/systems/providerSystem.ts:326-334` — the frame's `code` is kept as `spawnErrorCode`, its `stderr` is not carried at all) and `git grep` finds no reader of
`SystemError.stderr` on the request path. So the two rules combine into one:
everything a user must read has to be in `message`, and `message` is re-parsed.

Related: [[gate-versus-probe]] for what the gate's refusal is saying;
`docs/protocol.md` → `remoteId` routing for the wire shapes and why the gate's
code is `ENOREMOTE`.
