// The `ssh` kind. THE TRANSPORT ITSELF IS CARD 2026-0004 — what is here is the
// handshake-complete shell it drops into. See docker.mjs for why a stub kind is
// still registration-complete.

const NOT_YET = 'the ssh transport lands in card 2026-0004';

export function createSshTransport() {
  return {
    kind: 'ssh',

    defaultShell: '/bin/bash',

    // FALSE, PERMANENTLY — see the note in docker.mjs. No long-lived shell for
    // this kind; cc takes its documented one-shot-exec fallback.
    persistentShell: false,

    // FALSE until the transport does real process-group reach on the far side.
    processGroupSignal: false,

    // ALWAYS TRUE — see the note in docker.mjs. One row serves every host.
    remotes: true,

    remoteDescriptors: false,

    validateConfig(raw) {
      const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const host = typeof o.host === 'string' ? o.host.trim() : '';
      if (!host) return { ok: false, error: "ssh config needs a non-empty 'host'" };
      const user = typeof o.user === 'string' ? o.user.trim() : '';
      return { ok: true, config: { host, ...(user ? { user } : {}) } };
    },

    spawnPlan() { throw new Error(NOT_YET); },

    async reachability() {
      return { connected: false, detail: NOT_YET, fingerprint: null };
    },

    async reap() {},

    descriptor() { return { os: 'linux', pathSep: '/', home: '/root' }; },
  };
}
