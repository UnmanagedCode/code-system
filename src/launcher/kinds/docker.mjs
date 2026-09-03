// The `docker` kind. THE TRANSPORT ITSELF IS CARD 2026-0003 — what is here is
// the handshake-complete shell it drops into: the constants cc negotiates on,
// and the minimum config validation the store and the card API need to hold a
// docker remote at all.
//
// It is registration-complete on purpose: registering the `docker` System row
// is card 2026-0002's deliverable, and cc registers by SPAWNING this argv for a
// real handshake against an empty store, so the handshake must be answerable
// before any container can be reached.

const NOT_YET = 'the docker transport lands in card 2026-0003';

export function createDockerTransport() {
  return {
    kind: 'docker',

    // The contract's `shell` exec form is defined as `bash -lc`
    // (docs/systems-protocol.md:329), so bash is already assumed of the far
    // side. Not probeable: cc's handshake budget is 10 s and the handshake
    // happens with zero remotes configured.
    defaultShell: '/bin/bash',

    // FALSE, PERMANENTLY — an owner decision, not a not-yet. There is no
    // long-lived shell for this kind, so cc takes its documented
    // absent-behaviour: every redirected shell command becomes a one-shot
    // `exec` of the same framing, with `cwd` passed explicitly and `$PWD` read
    // back from the sentinel to carry into the next call. cc gates `stdin` /
    // `stdinClose` on the capability (src/systems/providerSystem.ts:628) and so
    // never sends them here; session.mjs refuses one EUNSUPPORTED, id-addressed,
    // if it ever arrives. The `exec` frame's own `stdin?` field is unaffected —
    // one-shot stdin stays.
    //
    // The user-visible difference is documented in docs/features.md, the
    // README's known limitations and .wiki/gotchas/no-persistent-shell.md.
    persistentShell: false,

    // FALSE until the transport actually does setsid inside the container, pgid
    // discovery and `kill -- -<pgid>` (docs/systems-protocol.md:667). The core
    // then sets `descendantsMaySurvive: true` on every exit it terminated,
    // which is the documented fallback. Card 2026-0003 raises it, or does not.
    processGroupSignal: false,

    // ALWAYS TRUE, never derived from store contents: cc memoises the handshake
    // per connection generation, so a capability that flapped as remotes were
    // added would be memoised wrong. One row serves every container
    // (docs/systems-protocol.md:646-649).
    remotes: true,

    // v1 answers no mirror advertisement: the session root images the project
    // root and `offset === ""`. Advertising a wider `mirrorRoot` later is
    // additive with no migration.
    remoteDescriptors: false,

    // The minimum that makes a stored docker remote meaningful. Card 2026-0003
    // extends this — the `config` object is opaque to the store, so a new field
    // needs no migration.
    validateConfig(raw) {
      const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const container = typeof o.container === 'string' ? o.container.trim() : '';
      if (!container) return { ok: false, error: "docker config needs a non-empty 'container' (name or id)" };
      return { ok: true, config: { container } };
    },

    spawnPlan() { throw new Error(NOT_YET); },

    async reachability() {
      return { connected: false, detail: NOT_YET, fingerprint: null };
    },

    async reap() {},

    descriptor() { return { os: 'linux', pathSep: '/', home: '/root' }; },
  };
}
