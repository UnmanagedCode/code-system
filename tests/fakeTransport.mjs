// A Transport for `--kind fake`, injected via CODE_SYSTEM_FAKE_TRANSPORT.
//
// It exists so the frame loop and the shutdown path can be driven with no
// docker and no ssh. It reaches the local machine exactly as `host` does — what
// makes it a FAKE is that it RECORDS ITS REAP CALLS, which is the only way to
// assert MUST 3 for a kind whose children are not its OS descendants without
// standing up a container.
//
// The reap log is a file because reap() runs inside the launcher CHILD process;
// the test reads it from the parent.

import { appendFileSync } from 'node:fs';

export function createTransport(opts = {}) {
  const reapLog = process.env.CODE_SYSTEM_FAKE_REAP_LOG ?? null;
  const processGroupSignal = opts.processGroupSignal !== false;
  return {
    kind: 'fake',
    processGroupSignal,
    // True so the store-backed routing gate is exercised: an absent or unknown
    // remoteId must be an id-addressed ENOREMOTE.
    remotes: true,
    remoteDescriptors: false,

    validateConfig(raw) { return { ok: true, config: raw && typeof raw === 'object' ? raw : {} }; },

    spawnPlan(_config, req) {
      const [file, args] = req.shell !== null
        ? ['bash', ['-lc', req.shell]]
        : [String(req.argv?.[0]), (req.argv ?? []).slice(1)];
      return { file, args, cwd: req.cwd, env: req.env, detached: processGroupSignal };
    },

    async reachability() {
      return { connected: true, detail: 'fake transport', fingerprint: 'fake:1' };
    },

    async reap(_config, handle) {
      if (reapLog) {
        appendFileSync(reapLog, `${JSON.stringify({ pid: handle.pid, token: handle.token, remoteId: handle.remoteId })}\n`);
      }
    },
  };
}
