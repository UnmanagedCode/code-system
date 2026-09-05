// WHERE THE LAUNCHER'S TARGETS COME FROM. Two sources, one interface, so
// session.mjs never learns which one it has:
//
//   StoreRemoteSource — production. Reads <store>/remotes/<id>.json FRESH on
//                       every request frame, with no cache (see src/store.mjs).
//   FlagRemoteSource  — `--remote id=root` on the argv, which is the shape cc's
//                       conformance suite drives a provider in.
//
// A source answers three things: which targets exist, what a named one resolves
// to, and what it advertises as a mirror.

import path from 'node:path';
import { readRemote } from '../store.mjs';

/**
 * @typedef {{remoteId:string|null, config:object, root:string|null}} ResolvedRemote
 *
 * `root` is a FENCE — a path outside it is refused EACCES — and is null for a
 * target that is not fenced. It is not the mirror advertisement, which is a
 * claim about geometry cc consumes; keeping the two apart is what lets a test
 * advertise a mirror wider than the fence.
 */

// Is `p` the root, or inside it? path.relative rather than a string prefix,
// which would claim a merely prefix-SHARING sibling (`<root>-backup`) is
// inside. Resolved first so `<root>/../elsewhere` cannot walk out.
export function withinRoot(root, p) {
  const rel = path.relative(root, path.resolve(p));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

export class FlagRemoteSource {
  #remotes;
  #mirrors;

  /**
   * @param {Map<string,string>} remotes  id → absolute fenced root
   * @param {Map<string,{mirrorRoot:string|null, exclude:string[]}>} mirrors
   *   keyed by id, or '' for the default target
   */
  constructor(remotes = new Map(), mirrors = new Map()) {
    this.#remotes = remotes;
    this.#mirrors = mirrors;
  }

  // NO GATE HERE, AND THE OMISSION IS LOAD-BEARING. The operator gate is a
  // property of a STORE RECORD; this source synthesises its targets from
  // `--remote id=root` argv and has none. That is why cc's conformance suite
  // (`--kind host`) is unaffected by the gate BY CONSTRUCTION rather than by
  // luck — pinned in tests/gate.test.mjs.
  hasRemotes() { return this.#remotes.size > 0; }
  hasMirrors() { return this.#mirrors.size > 0; }
  ids() { return [...this.#remotes.keys()]; }

  async lookup(remoteId) {
    // With no --remote flags this endpoint serves exactly ONE target and does
    // not advertise `remotes`, so cc never sends the field and there is nothing
    // to route: the default target is unfenced.
    if (!this.hasRemotes()) {
      return { ok: true, remote: { remoteId: null, config: {}, root: null } };
    }
    if (remoteId === null) {
      return {
        ok: false,
        code: 'ENOREMOTE',
        message: `this provider serves named remotes (${this.ids().join(', ')}) and the request named none`,
      };
    }
    const root = this.#remotes.get(remoteId);
    if (root === undefined) {
      return {
        ok: false,
        code: 'ENOREMOTE',
        message: `no such remote '${remoteId}' — this provider serves ${this.ids().join(', ')}`,
      };
    }
    return { ok: true, remote: { remoteId, config: {}, root } };
  }

  // `async` only so BOTH sources present the same shape and session.mjs never
  // learns which one it has. Nothing here does I/O.
  async mirrorFor(remoteId) {
    return this.#mirrors.get(remoteId ?? '') ?? { mirrorRoot: null, exclude: [] };
  }
}

export class StoreRemoteSource {
  #kind;

  constructor(kind) { this.#kind = kind; }

  // CONSTANT TRUE, never derived from what happens to be in the store: cc
  // memoises the handshake per connection generation, so a capability that
  // flapped as remotes were added would be memoised wrong, and the launch argv
  // is a function of (install path, kind) only so no re-registration happens
  // when a remote appears.
  //
  // The same holds for `hasMirrors`: the advertisement is per remote and lives
  // in the FRAME, so this is constant too. Neither method has a reader in
  // `src/` — the launcher's capabilities come from the kind (main.mjs) — they
  // are this source's stated interface, and the tests' doubles implement them.
  hasRemotes() { return true; }
  hasMirrors() { return true; }
  ids() { return []; }

  async lookup(remoteId) {
    if (remoteId === null) {
      return {
        ok: false,
        code: 'ENOREMOTE',
        message: `this provider serves named ${this.#kind} remotes and the request named none`
          + ' — set the project\'s Remote field to a remote id from the code-system UI',
      };
    }
    const r = await readRemote(remoteId);
    if (!r.ok) {
      // Every failure to resolve a target is ENOREMOTE and ID-ADDRESSED. An
      // id-less error frame is connection-level and would fail every OTHER
      // target's in-flight work (systems-protocol.md §9, "One dead remote is not a dead connection").
      return { ok: false, code: 'ENOREMOTE', message: `${r.message} (${this.#kind} launcher)` };
    }
    const rec = r.record;
    if (rec.kind !== this.#kind) {
      return {
        ok: false,
        code: 'ENOREMOTE',
        message: `remote '${remoteId}' is a '${rec.kind}' remote — this launcher serves '${this.#kind}' remotes`,
      };
    }
    // THE OPERATOR GATE FIRST. A switched-off remote must say "switched off",
    // not "fails the tooling baseline": the operator's own action is the more
    // actionable answer, and a disabled remote's stale baseline verdict is not
    // what they need to hear.
    const off = gateRefusal(rec);
    if (off) return off;
    const gate = baselineRefusal(rec);
    if (gate) return gate;
    return {
      ok: true,
      remote: { remoteId, config: rec.config ?? {}, root: null },
    };
  }

  // THE PER-REMOTE ADVERTISEMENT, read fresh off the record like everything
  // else this source answers. `record.mirror` is null for a remote the operator
  // did not opt in, and the empty advertisement is what cc reads as "I advertise
  // nothing" — the same path a provider without the capability takes.
  //
  // PASSED THROUGH UNVALIDATED, exactly as `config` is: src/mirror.mjs validates
  // at the store's front door, where the backend is the only writer. A
  // hand-edited store file gets cc's own MIRROR_ADVERTISEMENT_INVALID (502)
  // quoting the offending value, which is the authority that owns the rule.
  //
  // A SECOND READ, not a field on `lookup()`'s ResolvedRemote: the fence and the
  // advertisement are different claims (see the typedef above), and cc asks for
  // this once per connection generation.
  async mirrorFor(remoteId) {
    if (remoteId === null || remoteId === undefined) return { mirrorRoot: null, exclude: [] };
    const r = await readRemote(remoteId);
    if (!r.ok || r.record?.kind !== this.#kind) return { mirrorRoot: null, exclude: [] };
    const m = r.record.mirror;
    // `null` IS THE ONLY SHAPE WE ANSWER FOR — it is what the backend writes for
    // a remote that opted out. Everything else is forwarded as it was stored.
    if (m === null || m === undefined) return { mirrorRoot: null, exclude: [] };
    // NO COERCION, AND THE OMISSION IS THE POINT. Defaulting a hand-edited
    // `{root: 123, exclude: "x"}` to the empty advertisement would launder an
    // INVALID claim into a VALID one: cc would take the NO_ADVERTISEMENT path
    // and silently run a different, working session instead of refusing with
    // MIRROR_ADVERTISEMENT_INVALID. Same posture as `config` — the store's front
    // door validates, this passes through.
    return { mirrorRoot: m.root, exclude: m.exclude };
  }
}

// THE OPERATOR GATE, launcher side — the whole enforcement of `record.enabled`.
//
// It is checked on the RECORD, before any Transport method is reached, at the
// single site `StoreRemoteSource.lookup()`. session.mjs calls that once, for
// all four REQUEST frames, so no kind can bypass it and no operation escapes
// it. Follow-on frames (`data`, `end`, `signal`, `close`) are addressed by an
// id already bound to a remote, so they cannot slip past: a `writeFile` was
// already gated when it opened.
//
// `reap` DELIBERATELY DOES NOT PASS THROUGH HERE, and must not — gating it
// would abandon far-side processes at shutdown, which is the leak MUST 3
// exists to prevent.
//
// WHY ENOREMOTE, WHICH IS NOT THE OBVIOUS CODE. There is nothing 503-shaped in
// the taxonomy (protocol.mjs), and the choice is FORCED rather than preferred:
// cc's `assertRemoteKnown` treats ENOREMOTE as its SOLE failure and every other
// code as a PASS — "each of them is the provider answering ABOUT that remote,
// which is itself proof it serves it". So EUNKNOWN, EACCES or an invented code
// would let cc resolve the project as healthy, and the gate would surface only
// as unexplained per-operation failures with no system-level signal.
// EUNSUPPORTED is worse: it maps to 501 SYSTEM_NO_REMOTES, whose advice sends
// the operator to entirely the wrong repair. Full argument in
// docs/protocol.md's routing table.
//
// TWO CONSTRAINTS ON THE MESSAGE, both measured:
//  1. EVERYTHING READABLE RIDES `message`. cc drops the frame's `stderr` on the
//     exec path and never reads it on the request path, so this refusal sets
//     none.
//  2. NO STANDALONE FS ERRNO TOKEN. cc's runGit and ProviderShell ignore the
//     structured code and re-derive one from the prose with `\bENOENT\b`-style
//     matching, silently downgrading an administrative refusal into "git
//     answered non-zero" (.wiki/gotchas/refusal-message-errno-tokens.md).
// Both are pinned by tests/gate.test.mjs.
export function gateRefusal(rec) {
  if (rec?.enabled === true) return null;
  return {
    ok: false,
    code: 'ENOREMOTE',
    // Worded to read correctly after cc's own `…does not serve it: ` preamble,
    // which interpolates this verbatim and untruncated into the sidebar system
    // pill and into a session's redirected Bash.
    message: `remote '${rec?.remoteId}' is switched OFF in the code-system UI`
      + ' — connect it there and retry. This is an operator setting, not a fault:'
      + ' nothing is wrong with the target, and code-system did not contact it.',
  };
}

// THE TOOLING-BASELINE GATE, launcher side.
//
// `unsupported` refuses the target WHOLE. Refusing whole is deliberate: the
// busybox case is PARTLY working — four of cc's seven derivations are fine and
// `stat` succeeds while silently losing sub-second precision — and a
// half-working system is exactly what a clear refusal is worth more than.
//
// `unknown` SERVES. The launcher can be spawned before the backend has ever
// probed, and absence of evidence is not evidence: blocking on it would make a
// cold launcher useless.
//
// EUNKNOWN is the right code by the taxonomy — the catch-all that carries raw
// stderr verbatim and IS SURFACED TO THE USER (systems-protocol.md §8, "cc-side interpretation").
export function baselineRefusal(rec) {
  const b = rec?.baseline;
  if (!b || b.state !== 'unsupported') return null;
  const missing = Array.isArray(b.missing) ? b.missing : [];
  const names = missing.map(m => m.capability).join(', ') || 'the POSIX/GNU tooling baseline';
  return {
    ok: false,
    code: 'EUNKNOWN',
    message: `remote '${rec.remoteId}' does not meet the tooling baseline cc's derived operations need:`
      + ` ${names}. Fix the target's toolchain (GNU coreutils + findutils) or point this project elsewhere.`,
    stderr: missing.map(m => `${m.capability}: ${m.probe}: ${m.detail}`).join('\n'),
  };
}
