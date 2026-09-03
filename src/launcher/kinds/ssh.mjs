// The `ssh` kind. THE TRANSPORT ITSELF IS CARD 2026-0004 — what is here is the
// handshake-complete shell it drops into. See docker.mjs for why a stub kind is
// still registration-complete.

import { asObject, operand } from './config.mjs';

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
      const o = asObject(raw);
      // Both become ARGV OPERANDS (`ssh <user>@<host>`), so a leading `-` would
      // make either an option — see kinds/config.mjs.
      const host = operand(o.host, 'host');
      if (!host.ok) return { ok: false, error: `ssh config: ${host.error}` };
      const user = operand(o.user, 'user', { required: false });
      if (!user.ok) return { ok: false, error: `ssh config: ${user.error}` };
      return { ok: true, config: { host: host.value, ...(user.value ? { user: user.value } : {}) } };
    },

    spawnPlan() { throw new Error(NOT_YET); },

    async reachability() {
      return { connected: false, detail: NOT_YET, fingerprint: null };
    },

    async reap() {},

    descriptor() { return { os: 'linux', pathSep: '/', home: '/root' }; },
  };
}
