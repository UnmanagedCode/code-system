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

import { execEnv } from '../src/launcher/kinds/config.mjs';
import { TOKEN_VAR } from '../src/launcher/kinds/reapscript.mjs';

// Waits for a file, then becomes the rest of its argv: how a test holds a
// command back until it has arranged what the command must find.
const GATED = 'while [ ! -e "$1" ]; do sleep 0.01; done; shift; exec "$@"';

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

    // OPT-IN, by env var, so every existing `--kind fake` test stays
    // byte-identical: without it the launcher builds no pool at all and nothing
    // about the channel is in play. With it, the channel is this machine's own
    // `/bin/sh` — which is exactly what `docker exec -i <container> /bin/sh`
    // hands the pool, minus the container.
    ...(process.env.CODE_SYSTEM_FAKE_CHANNEL === '1' ? {
      channelPlan(_config, { remoteId = null } = {}) {
        return { file: '/bin/sh', args: [], env: execEnv(null, remoteId) };
      },
    } : {}),

    // OPT-IN, like the channel: TERMINALS on this machine, the way `host` runs
    // them — the trampoline under the helper, with the plumbing on its own
    // environment. Three test seams ride it: CODE_SYSTEM_FAKE_PTY_GATE holds the
    // trampoline back until a file exists; CODE_SYSTEM_FAKE_PTY_RELAY=1 turns on
    // the resize relay (whose `stty` then runs through `spawnPlan` below); and a
    // record's `config.ptyFail` makes the "client" exit before any marker, with
    // a head the classifier below does (`down`) or does not (`garbage`) know.
    ...(process.env.CODE_SYSTEM_FAKE_PTY === '1' ? {
      ptyMode: 'exec',
      ptyResizeRelay: process.env.CODE_SYSTEM_FAKE_PTY_RELAY === '1',
      ptyPlan(config, req) {
        if (config.ptyFail === 'down') return { file: '/bin/sh', args: ['-c', 'echo "FAKE-DOWN: no target"; exit 9'] };
        if (config.ptyFail === 'garbage') return { file: '/bin/sh', args: ['-c', 'echo "odd: ENOENT happened"; exit 9'] };
        const gate = process.env.CODE_SYSTEM_FAKE_PTY_GATE;
        const plumbing = [`${TOKEN_VAR}=${req.token}`, ...(req.remoteId ? [`CC_REMOTE=${req.remoteId}`] : [])];
        const command = gate ? ['/bin/sh', '-c', GATED, 'sh', gate, ...req.command] : req.command;
        return { file: '/usr/bin/env', args: ['--', ...plumbing, ...command] };
      },
      classifyFailure(_config, { stderr }) {
        return stderr.startsWith('FAKE-DOWN') ? { code: 'ENOREMOTE', message: 'the fake target is down' } : null;
      },
    } : {}),

    spawnPlan(_config, req) {
      const relayGate = process.env.CODE_SYSTEM_FAKE_RELAY_GATE;
      const argv = relayGate && req.argv?.[0] === '/bin/sh' && req.argv[1] === '-c'
        ? ['/bin/sh', '-c', GATED, 'sh', relayGate, ...req.argv]
        : req.argv;
      const [file, args] = req.shell !== null
        ? ['bash', ['-lc', req.shell]]
        : [String(argv?.[0]), (argv ?? []).slice(1)];
      // Same composer the real kinds use: the frame's env, CC_REMOTE last.
      return { file, args, cwd: req.cwd, env: execEnv(req.env, req.remoteId), detached: processGroupSignal };
    },

    async reachability() {
      return { connected: true, detail: 'fake transport', fingerprint: 'fake:1' };
    },

    async reap(_config, handle) {
      if (reapLog) {
        appendFileSync(reapLog, `${JSON.stringify({
          pid: handle.pid, token: handle.token, remoteId: handle.remoteId, sid: handle.sid ?? null,
        })}\n`);
      }
    },
  };
}
