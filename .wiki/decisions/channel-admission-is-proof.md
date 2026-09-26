# Channel admission is a proof, not an attestation

**What:** `src/launcher/admission.mjs` answers one question: *is this frame
provably one of cc's own bounded fs derivations?* It answers from a structural
fact cc cannot misstate — the byte-exact argv (`ROWS`), which no user-facing cc
code path produces, plus an envelope (`envelopeOk`) that refuses a non-placeholder
`cwd`, any `env`, any `shell`, a `timeoutMs`, a `killGraceMs`, a `stdin` other
than `'ignore'` and an empty `argv`.

Any proposal to identify ops by a marker cc stamps — an env var, a frame field,
an argv token — replaces that proof with cc's own attestation. Judge it on that
trade, not on convenience.

Cross-references: [docker-channel.md](../gotchas/docker-channel.md) (the channel
this admits to), [provider-family-per-op-cost.md](provider-family-per-op-cost.md)
(why the channel exists at all), `docs/protocol.md` → "Which frames ride it" (the
table's specification).

## What a marker does and does not buy

- **It retires no boundedness guard.** `removeTree` is refused for being
  *unbounded*, not unidentifiable — it has its own exact-argv row in `EXCLUDED`,
  so the refusal is visible. The idle watchdog, the host-side stdin
  write-progress feed, exit-code retirement and `ETRANSPORT` never-retry all act
  on ops **already admitted**, and are indifferent to who built the frame.
- **The dominant blocking risk is a genuine fs op**, not a foreign command: a
  large `writeFile` payload, a `mkdir -p` on a cold mount, `removeTree` on a big
  tree. A truthful marker reclassifies none of them.
- **A generic marker (`CC_OP=fs-op`) cannot retire the row table**, because
  `ROWS` is also the per-op boundedness catalogue — it decides *which* op, and
  therefore whether it is short. Only a per-op marker could, and that asks the
  launcher to run an argv it no longer verifies: the forgeability risk at full
  strength.
- **Its one clean win is exact identification where the code guesses.** The
  one-shot drift warning uses `derivationShaped` (an argv-prefix sniff) to decide
  whether a row miss is worth reporting. That heuristic is all a marker would
  replace, and it is small.

## cc-side facts that constrain any carrier

§N is a section of cc's `docs/systems-protocol.md` (see the glossary in
[index.md](../index.md)).

- **A frame `env` REPLACES the target environment, never overlays it** (§5), and
  cc sends none on any `exec` — see
  [exec-env-across-a-boundary.md](../gotchas/exec-env-across-a-boundary.md); cc
  pins it in its own `tests/systems-exec-env.test.mjs`. A marker in `env` would
  strip PATH/HOME from every derived command, and the envelope refuses
  env-bearing frames anyway, so that carrier excludes exactly the ops it means to
  admit.
- **The sanctioned carrier for a variable is argv via `env(1)`** (ADD semantics),
  the way `LC_ALL=C` already rides.
- **A new frame FIELD needs no version bump**: §2 makes unknown fields on known
  frames the extension point.
- **cc already signs its derivations.** `ProviderSystem`'s `#derive` prepends
  `env LC_ALL=C` to every derived argv and sends the placeholder `cwd: '/'`,
  through one chokepoint (`#derive`/`#deriveOk` → `#exec` → `execFrame`). But a
  prefix is forgeable by any caller that writes it, so it is a cheap heuristic
  (which is exactly how `derivationShaped` uses it), not proof.
- **A provider cannot opt out of derivation.** §2's MUST set is `exec`,
  `readFile`, `writeFile`; there is no capability for advertising native
  `stat`/`mkdir`/… and no typed frame for them. Every "just send typed frames"
  proposal stops here.

## How to apply

- **Ask what a mechanism guards before asking whether a marker helps it.**
  Identification-driven guards are a small minority of the channel's code;
  boundedness and stream-integrity guards are the bulk, and survive every
  identification scheme.
- **Never let an admission rule become self-attested without naming the new
  trust.** The launcher would have to trust that no frame-building path ever
  echoes the marker onto a user command, and a misroute has no fail-closed
  backstop equivalent to row-miss-and-fall-back. The launcher's other trust
  boundaries — `TOKEN_VAR` (`CC_EXEC_TOKEN`, `src/launcher/kinds/reapscript.mjs`)
  and `CC_REMOTE` — are launcher-generated or launcher-verified, never
  cc-asserted content flags.
