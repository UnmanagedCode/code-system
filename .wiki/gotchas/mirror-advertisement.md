# The mirror advertisement: what cc believes, and when it asks

**What:** a provider tells cc, per target, how much of that target's filesystem
the session root is the local image of (`mirrorRoot`) and which prefixes cc must
not carry across (`exclude`). cc asks with `describeRemote` and reads a
`remoteDescriptor` back (`systems-protocol.md` §2.1). Ours comes from
`record.mirror` in the store, set in a card's **Advanced** group.

cc's own module is the authority for every rule below:
`$CC_CHECKOUT/src/systems/mirror.ts`.

## The five things you cannot re-derive from our code

**1. cc MEMOISES the descriptor per connection generation.** Two consequences,
and both shape the design:

- the `remoteDescriptors` **capability must be constant per kind**, never derived
  from store contents — a capability that flapped as a remote gained or lost a
  mirror would be memoised wrong (`src/launcher/kinds/docker.mjs`);
- **an edit is not live.** Changing a mirror reaches an already-running session
  only after the System reconnects. The form says so, and so does `README.md`.

**2. `mirrorRoot: null` is a VALID descriptor, not a missing one.** cc's
`NO_ADVERTISEMENT` → `noMirror(systemPath)` is the same path a provider that
never heard of the frame takes: `mirrorRoot = systemPath`, `offset = ''`, empty
exclude. So an opted-out remote answers a `remoteDescriptor` carrying **neither**
field — never an error frame, and never a session failure.

**3. cc REFUSES TO NORMALISE a provider's path claim, deliberately.** A
normalised-away `..` is exactly how a hostile root would be smuggled past a
containment test, and `/app/` vs `/app` are two spellings of one place that
compare unequal in a manifest. `normalAbsolute` (`mirror.ts`) therefore requires
absolute **and** already-normal, refuses a NUL (inert downstream, so a `/proc\0`
exclude would silently match nothing while reading as `/proc`), and treats `/` as
its own normal form despite the trailing separator. `src/mirror.mjs` mirrors this
rule so the operator hears it in the form.

**4. The two project-relative refusals fire AT SPAWN, not at project
resolution.** `MIRROR_ROOT_EXCLUDES_PROJECT` and `MIRROR_EXCLUDE_COVERS_PROJECT`
are **501**s from `resolveMirrorScope`. cc's own comment at
`$CC_CHECKOUT/src/systems/mirror.ts:149-154` states the blast radius — *"a bad
advertisement breaks worker sessions and nothing else, since git, status, diff,
worktrees and every `project_*` tool run at `systemPath` over `exec`/`readFile`
and never touch the mirror"* — and that is cc's claim about cc's own tools, not
one anything in this repo verifies. A shape refusal is different:
`MIRROR_ADVERTISEMENT_INVALID` is a **502** — the far side answered, and answered
badly.

**5. Containment is `path.posix.relative`, NEVER a string prefix.** `/app-backup`
is not inside `/app`, and `/app` is not inside `/a`. On cc's side one predicate
(`withinPosix`, `mirror.ts:49-54`) serves its exclude test and its validation
alike. **We share no code with it**: `src/mirror.mjs:61-64` has its own
`coversRoot`, because the mirror lives in the **far side's** path space whatever
the backend runs on, so the platform-path `withinRoot`
(`src/launcher/remotes.mjs:27-30`) is the wrong tool.

**Its argument order is the REVERSE of cc's.** `withinPosix(inner, outer)` asks
"is inner under outer"; `coversRoot(entry, root)` asks "does entry contain root".
Do not assume parity when reading one against the other.

## Ours, and where the line is

- An exclude **outside** the mirror root is **inert, not an error** — cc's own
  word. A provider that mirrors `/app` and also lists `/proc` is sane
  configuration, and `validateMirror` must not refuse it.
- An exclude **covering** the root is refused by us at the form, beyond cc's
  shape check: cc accepts the shape and then 501s every session on that remote,
  so refusing it early rejects nothing usable.
- The **defaults** (`/`, and `/proc` `/dev` `/sys`) come from §11's
  `remoteDescriptors` row, not from us. They live once in `DEFAULT_MIRROR`
  (`src/mirror.mjs`) and are served to the form over REST.
- A mirror root is a **path claim cc consumes for path arithmetic**, never argv
  and never a shell string — which is why it does not fall under the "no command
  line in a card field" rule in `docs/features.md` → *Operator settings*.
