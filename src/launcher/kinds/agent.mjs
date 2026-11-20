// The `agent` kind: a DIAL-IN remote. A single-file Python agent on a Linux
// machine dials the broker (src/agent/broker.mjs) and authenticates with this
// remote's secret; every command reaches it through a BRIDGE process
// (src/agent/bridge.mjs) the core spawns exactly as it spawns a `docker exec`
// client. Spec: docs/agent-wire.md.
//
// It builds argv and nothing else, like every kind. The secret NEVER appears in
// a plan: a bridge carries the secret's public key id (`keyIdOf`), which is
// enough for the broker to refuse a session that authenticated with a previous
// secret, and nothing an observer of /proc/<pid>/cmdline can use.

import { spawn } from 'node:child_process';
import { BRIDGE_MAIN, agentDir, agentSocketPath } from '../../paths.mjs';
import { BrokerDown, queryBroker, readBrokerError } from '../../agent/client.mjs';
import {
  BRIDGE_EXIT_NEVER_STARTED, BRIDGE_EXIT_OWN, BRIDGE_TAGS, MARKER_PREFIX, keyIdOf,
} from '../../agent/protocol.mjs';
import { ensureBroker } from '../../agent/supervisor.mjs';
import { asObject, execEnv, operatorError } from './config.mjs';
import { REAP_TAG, TOKEN_VAR, reapScriptFor } from './reapscript.mjs';

// 32 random bytes, base64url without padding — what the card UI generates.
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const STATUS_TIMEOUT_MS = 2000;
const REAP_TIMEOUT_MS = 1200;
// The bridge's own stderr marker, read back off the head or the tail.
const MARKER_RE = new RegExp(`(?:^|\\n)${MARKER_PREFIX}(\\S+) ([^\\n]*)\\n?$`);
const ERRNO_RE = /^E[A-Z0-9]+$/;

export const KIND_META = {
  label: 'Agent (dial-in)',
  // NO IDENTIFYING FIELD, DECLARED: the target is whichever machine runs the
  // agent, and the remote's config names nothing about it. `identityFieldFor`
  // answers null for this and still throws for a kind that forgot the key.
  identityField: null,
  mirrorByDefault: true,
  configFields: [
    {
      name: 'secret',
      label: 'Secret',
      required: true,
      secret: true,
      // The card generates it; there is no text input for it.
      generated: true,
      hint: 'Generated for you. The agent proves it knows this secret, and the secret itself never crosses'
        + ' the network. It is shown once, in the command that starts the agent;'
        + ' Generate new secret replaces it and disconnects the agent that used the old one.',
    },
  ],
};

const plain = (config) => {
  const secret = String(config?.secret ?? '');
  return { secret, keyId: keyIdOf(secret) };
};

// The bridge's argv up to its `--`, shared by every plan.
function bridgeHead(config, remoteId, cwd) {
  return [BRIDGE_MAIN, '--socket', agentSocketPath(), '--remote', String(remoteId ?? ''),
    '--key', plain(config).keyId, '--cwd', cwd];
}

/** The bridge's outcome line, from the head or the tail of its stderr. */
export function readMarker(stderr = '', stderrTail = '') {
  for (const text of [stderrTail, stderr]) {
    const m = MARKER_RE.exec(String(text ?? '').replace(/\r/g, '').trimEnd());
    if (m) return { tag: m[1], message: m[2] };
  }
  return null;
}

/** One bridge, run to completion: the reap's only transport. */
function runBridge(args, { timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (e) { resolve({ code: null, stdout: '', stderr: '', error: e }); return; }
    const out = [];
    const err = [];
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: '', error: e }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), error: null });
    });
  });
}

export function createAgentTransport() {
  return {
    kind: 'agent',

    // FINAL, for docker's reason: a bridge dying kills nothing on the far side,
    // and a signal sent here reaches only the bridge. The kill is `reap`.
    processGroupSignal: false,
    remotes: true,
    remoteDescriptors: true,

    validateConfig(raw) {
      const o = asObject(raw);
      if (typeof o.secret !== 'string' || !SECRET_RE.test(o.secret)) {
        return {
          ok: false,
          error: 'agent config: \'secret\' is required and must be 32 random bytes in unpadded base64url'
            + ' (43 characters of A-Z a-z 0-9 - _) — the card generates one',
        };
      }
      return { ok: true, config: { secret: o.secret } };
    },

    spawnPlan(config, req) {
      const command = req.shell !== null
        ? ['/bin/bash', '-lc', req.shell]
        : [String(req.argv?.[0]), ...(req.argv ?? []).slice(1)];
      const args = bridgeHead(config, req.remoteId, req.cwd);
      if (req.stdinMode === 'pipe') args.push('--stdin');
      // The overlay rides the agent's own environment (an OVERLAY, never a
      // replacement); a frame env REPLACES it, so it goes through `env -i --`
      // on the far side, as on docker — the `--` stops a frame key that looks
      // like an option from reaching `env` as one.
      if (req.remoteId !== null) args.push('--env', `CC_REMOTE=${req.remoteId}`);
      args.push('--env', `${TOKEN_VAR}=${req.token}`, '--');
      if (req.env === null) args.push(...command);
      else {
        const composed = { ...execEnv(req.env, req.remoteId, {}), [TOKEN_VAR]: req.token };
        args.push('env', '-i', '--', ...Object.entries(composed).map(([k, v]) => `${k}=${v}`), ...command);
      }
      return { file: process.execPath, args, env: undefined, detached: false };
    },

    // INVARIANT per (remote, secret): no cwd, no token. A channel op carries its
    // token as its own env prefix (channel.mjs).
    channelPlan(config, { remoteId = null } = {}) {
      const args = [...bridgeHead(config, remoteId, '/'), '--stdin'];
      if (remoteId !== null) args.push('--env', `CC_REMOTE=${remoteId}`);
      args.push('--', '/bin/sh');
      return { file: process.execPath, args };
    },

    // The agent is the far parent, so the trampoline can `exec` the program:
    // it leads its own session and its exit status is exact.
    ptyMode: 'exec',
    // A resize is delivered in-band and IN ORDER by the bridge (it reads the
    // live window size before every input chunk), so no `stty -F` relay.
    ptyResizeRelay: false,

    ptyPlan(config, req) {
      const args = [...bridgeHead(config, req.remoteId, '/'), '--pty'];
      if (req.remoteId !== null) args.push('--env', `CC_REMOTE=${req.remoteId}`);
      args.push('--env', `${TOKEN_VAR}=${req.token}`, '--', ...req.command);
      return { file: process.execPath, args, env: undefined };
    },

    /**
     * Asks the broker, over its socket: a socket that answers is the only proof
     * a broker is alive. Connected only for a live session whose key id is the
     * CURRENT secret's.
     */
    async reachability(config, ctx = {}) {
      const remoteId = String(ctx?.remoteId ?? '');
      const no = detail => ({ connected: false, detail, fingerprint: null });
      if (!SECRET_RE.test(String(config?.secret ?? ''))) return no('this remote has no valid secret — generate one on its card');
      let st;
      try { st = await queryBroker(agentSocketPath(), { t: 'status', remoteId }, { timeoutMs: STATUS_TIMEOUT_MS }); }
      catch (e) {
        if (!(e instanceof BrokerDown)) return no(`the agent listener did not answer: ${e.message}`);
        const recorded = await readBrokerError(agentDir());
        return no(recorded
          ? `listener not running: ${recorded.message}`
          : 'listener not running — the plugin backend starts it while an agent card exists');
      }
      const replaced = st.replacements > 0
        ? `; the session was replaced ${st.replacements} time(s) — two agents may be using this secret` : '';
      const refusal = st.lastRefusal
        ? `; last refused: ${st.lastRefusal.reason} from ${st.lastRefusal.peer} at ${st.lastRefusal.at}` : '';
      if (!st.connected) return no(`no agent connected${refusal}${replaced}`);
      if (st.keyId !== plain(config).keyId) {
        return no(`the connected agent used a previous secret — restart it with the current one${replaced}`);
      }
      return {
        connected: true,
        detail: `agent on ${st.host ? `'${st.host}'` : 'an unnamed host'}`
          + `${st.agentPid ? ` (pid ${st.agentPid}${st.python ? `, Python ${st.python}` : ''})` : ''}`
          + ` connected from ${st.peer} since ${st.since}${replaced}`,
        fingerprint: `agent:${remoteId}:${st.session}`,
      };
    },

    // The card comes FIRST: an agent does not have to be connected for the
    // gate to open. What has to be true is that the broker can run.
    async connect() {
      const r = await ensureBroker();
      if (!r.running) throw operatorError(`the agent listener cannot run: ${r.error}`);
      return {};
    },

    // A documented no-op pass, like docker's: the gate-off refusal happens in
    // the launcher's lookup, and the agent's session stays — the gate and the
    // probe are independent.
    async disconnect() {},

    async reap(config, handle) {
      if (!handle?.token) return;
      const args = [...bridgeHead(config, handle.remoteId, '/')];
      if (handle.remoteId) args.push('--env', `CC_REMOTE=${handle.remoteId}`);
      args.push('--', '/bin/sh', '-c', reapScriptFor(handle));
      const res = await runBridge(args, { timeoutMs: REAP_TIMEOUT_MS });
      if (res.code === 0 && res.stdout.startsWith(`${REAP_TAG} ok `)) return;
      // BENIGN, AND TRUTHFULLY SO: no session means the agent's session ended,
      // and an agent ends every command of a session that ends.
      const marker = readMarker(res.stderr, res.stderr.slice(-512));
      if (marker && [BRIDGE_TAGS.notConnected, BRIDGE_TAGS.brokerDown].includes(marker.tag)) return;
      const why = res.stdout.startsWith(`${REAP_TAG} blind`)
        ? 'the agent\'s machine let it read no /proc/<pid>/environ'
        : (marker ? `${marker.tag} ${marker.message}` : res.error?.message
          ?? (res.code === null ? `no answer within ${REAP_TIMEOUT_MS} ms` : `exit ${res.code}`));
      throw new Error(`reap could not be proved to have run on remote '${handle.remoteId}': ${why}`
        + ' — a far-side process may have survived');
    },

    classifyFailure(config, { code, stderr = '', stderrTail = '' }) {
      const m = readMarker(stderr, stderrTail);
      if (!m) return null;
      if (code === BRIDGE_EXIT_NEVER_STARTED) {
        if (m.tag !== BRIDGE_TAGS.neverStarted) return null;
        const sp = m.message.indexOf(' ');
        const errno = sp > 0 ? m.message.slice(0, sp) : m.message;
        if (!ERRNO_RE.test(errno)) return null;
        return { code: errno, message: sp > 0 ? m.message.slice(sp + 1) : errno };
      }
      if (code !== BRIDGE_EXIT_OWN) return null;
      switch (m.tag) {
        case BRIDGE_TAGS.brokerDown:
        case BRIDGE_TAGS.notConnected:
        case BRIDGE_TAGS.staleKey:
          return { code: 'ENOREMOTE', message: m.message };
        case BRIDGE_TAGS.lost:
          return { code: 'ETRANSPORT', message: m.message };
        case BRIDGE_TAGS.tooManyStreams:
          return { code: 'EUNKNOWN', message: m.message };
        default:
          return null;
      }
    },
  };
}
