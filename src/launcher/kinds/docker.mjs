// The `docker` kind. THE TRANSPORT ITSELF IS CARD 2026-0003 — what is here is
// the handshake-complete shell it drops into: the constants cc negotiates on,
// and the minimum config validation the store and the card API need to hold a
// docker remote at all.
//
// It is registration-complete on purpose: registering the `docker` System row
// is card 2026-0002's deliverable, and cc registers by SPAWNING this argv for a
// real handshake against an empty store, so the handshake must be answerable
// before any container can be reached.

import { asObject, operand } from './config.mjs';

const NOT_YET = 'the docker transport lands in card 2026-0003';

export function createDockerTransport() {
  return {
    kind: 'docker',

    // The contract's `shell` exec form is defined as `bash -lc`
    // (systems-protocol.md §5), so bash is already assumed of the far
    // side. Not probeable: cc's handshake budget is 10 s and the handshake
    // happens with zero remotes configured.
    defaultShell: '/bin/bash',

    // FALSE, PERMANENTLY — an owner decision, not a not-yet. There is no
    // long-lived shell for this kind, so cc takes its documented
    // absent-behaviour: every redirected shell command becomes a one-shot
    // `exec` of the same framing, with `cwd` passed explicitly and `$PWD` read
    // back from the sentinel to carry into the next call. cc gates `stdin` /
    // `stdinClose` on the capability (src/systems/providerSystem.ts, the persistentShell gate) and so
    // never sends them here; session.mjs refuses one EUNSUPPORTED, id-addressed,
    // if it ever arrives. The `exec` frame's own `stdin?` field is unaffected —
    // one-shot stdin stays.
    //
    // The user-visible difference is documented in docs/features.md, the
    // README's known limitations and .wiki/gotchas/no-persistent-shell.md.
    persistentShell: false,

    // FALSE until the transport actually does setsid inside the container, pgid
    // discovery and `kill -- -<pgid>` (systems-protocol.md §11, item 2). The core
    // then sets `descendantsMaySurvive: true` on every exit it terminated,
    // which is the documented fallback. Card 2026-0003 raises it, or does not.
    processGroupSignal: false,

    // ALWAYS TRUE, never derived from store contents: cc memoises the handshake
    // per connection generation, so a capability that flapped as remotes were
    // added would be memoised wrong. One row serves every container
    // (systems-protocol.md §11).
    remotes: true,

    // v1 answers no mirror advertisement: the session root images the project
    // root and `offset === ""`. Advertising a wider `mirrorRoot` later is
    // additive with no migration.
    remoteDescriptors: false,

    // The minimum that makes a stored docker remote meaningful. Card 2026-0003
    // extends this — the `config` object is opaque to the store, so a new field
    // needs no migration.
    validateConfig(raw) {
      const o = asObject(raw);
      // `container` becomes an ARGV OPERAND (`docker exec <container>`), so a
      // leading `-` would make it an option — see kinds/config.mjs.
      const container = operand(o.container, 'container');
      if (!container.ok) return { ok: false, error: `docker config: ${container.error}` };
      return { ok: true, config: { container: container.value } };
    },

    spawnPlan() { throw new Error(NOT_YET); },

    async reachability() {
      return { connected: false, detail: NOT_YET, fingerprint: null };
    },

    async reap() {},

    descriptor() { return { os: 'linux', pathSep: '/', home: '/root' }; },
  };
}
