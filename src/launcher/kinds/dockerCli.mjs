// Decides HOW the docker CLI is invoked — and nothing else. The backend and
// every launcher are separate processes that run this same code, so they cannot
// disagree about the invocation.
//
// ORDER: a non-empty CODE_SYSTEM_DOCKER wins outright (parsed, never probed, never
// second-guessed — `["docker"]` is therefore the opt-out of the fallback).
// Otherwise bare `docker version` is probed, and ONLY a socket-permission denial
// falls through to `sudo -n docker version`. A daemon that is down, a missing
// binary or a timeout never reaches sudo: sudo would not fix them, and escalating
// on them would hide the real error.
//
// `sudo -n docker` is root-equivalent on the host. That is why the fallback is
// narrow (a denial only), visible (the card's reachability detail says so) and
// opt-out-able.

import { operatorError } from './config.mjs';

// THE OPERATOR SEAM: a whole docker argv as JSON. An env var and not a store field
// or launch flag: a stored value
// would be an HTTP-writable executable argv on cc's host; a launch flag would
// force re-registration; cc spawns the launcher with the orchestrator's env).
export const DOCKER_ENV = 'CODE_SYSTEM_DOCKER';

export const DIRECT_DOCKER = Object.freeze(['docker']);
export const SUDO_DOCKER = Object.freeze(['sudo', '-n', 'docker']);

const PROBE_ARGS = ['version', '--format', '{{.Server.Version}}'];

const first = (s) => String(s ?? '').split('\n')[0].trim();

/**
 * @returns {string[]|null} the operator's whole docker invocation, or null when unset/blank
 * @throws on a malformed override — DELIBERATELY: the launcher surfaces it as exit 2
 *   before any frame, quoting this text. Falling back would fail every operation
 *   with a socket error that names nothing.
 */
export function dockerOverrideArgv(env = process.env) {
  const raw = typeof env[DOCKER_ENV] === 'string' ? env[DOCKER_ENV].trim() : '';
  if (raw === '') return null;
  const bad = (why) => operatorError(
    `${DOCKER_ENV} ${why}. It must be a JSON array of non-empty strings — the WHOLE docker`
    + ` invocation, e.g. ${DOCKER_ENV}='["sudo","-n","docker"]'. Got ${JSON.stringify(raw)}`);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw bad('is not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw bad('is not a non-empty JSON array');
  if (!parsed.every(v => typeof v === 'string' && v !== '')) throw bad('contains a non-string or empty entry');
  return parsed;
}

// docker's wording for an unreadable socket, old and new
// (`…connect to the Docker daemon socket…` / `…connect to the docker API at…`).
export function isSocketDenied(stderr) {
  return first(stderr).startsWith('permission denied while trying to connect');
}

// sudo refusing to run (`sudo: a password is required`, `Sorry, user x is not
// allowed…`). FORGEABLE by a command that runs `sudo -n` itself, so callers only
// ever use it to re-probe, never to blame the provider.
export function isSudoRefusal(stderr) {
  const line = first(stderr);
  return line.startsWith('sudo: ') || line.startsWith('Sorry, user ');
}

/**
 * @param {object} o
 * @param {(cli:string[], args:string[], opts:{timeoutMs:number}) =>
 *   Promise<{code:number|null, stdout:string, stderr:string, error:Error|null}>} o.run
 * @param {Record<string,string|undefined>} [o.env]  re-read on EVERY call
 * @param {number} [o.timeoutMs]
 */
export function createDockerCliResolver({ run, env = process.env, timeoutMs = 5_000 }) {
  // The cache key is the RAW override string, so a policy change made through
  // the override takes effect at once and a cached `sudo` cannot outlive it.
  const rawOverride = () => (typeof env[DOCKER_ENV] === 'string' ? env[DOCKER_ENV].trim() : '');

  let settled = null;   // { key, via, argv }
  let inflight = null;  // { key, promise }
  let failure = null;   // detail of the last both-failed resolution

  const answered = (r) => r.code === 0 && r.stdout.trim() !== '';

  async function probe(key) {
    const direct = await run(DIRECT_DOCKER, PROBE_ARGS, { timeoutMs });
    if (answered(direct)) {
      failure = null;
      settled = { key, via: 'direct', argv: [...DIRECT_DOCKER] };
      return { ok: true, argv: [...DIRECT_DOCKER], via: 'direct', settled: true };
    }
    if (direct.code === null || direct.code === 0 || !isSocketDenied(direct.stderr)) {
      // Not a denial: sudo would not help. Hand back bare docker UNSETTLED so the
      // caller meets the real error, and the next resolve probes again.
      return { ok: true, argv: [...DIRECT_DOCKER], via: 'direct', settled: false };
    }
    const sudo = await run(SUDO_DOCKER, PROBE_ARGS, { timeoutMs });
    if (answered(sudo)) {
      failure = null;
      settled = { key, via: 'sudo', argv: [...SUDO_DOCKER] };
      return { ok: true, argv: [...SUDO_DOCKER], via: 'sudo', settled: true };
    }
    // NO bare errno token (.wiki/gotchas/refusal-message-errno-tokens.md).
    const why = sudo.error ? '`sudo` could not be run'
      : sudo.code === null ? '`sudo -n docker` did not answer in time'
        : `\`sudo -n docker\` failed: ${first(sudo.stderr) || `exit ${sudo.code}`}`;
    failure = `\`docker\` was denied access to the docker socket (${first(direct.stderr)}) and ${why}`
      + ` — add this user to the docker group, or set ${DOCKER_ENV} to a working docker invocation`;
    return { ok: false, detail: failure };
  }

  const resolver = {
    /** @returns {Promise<{ok:true, argv:string[], via:'override'|'direct'|'sudo', settled:boolean}|{ok:false, detail:string}>} */
    async resolve() {
      const override = dockerOverrideArgv(env);
      if (override) return { ok: true, argv: override, via: 'override', settled: true };
      const key = rawOverride();
      if (settled?.key === key) return { ok: true, argv: [...settled.argv], via: settled.via, settled: true };
      if (inflight?.key === key) return inflight.promise;
      const mine = { key, promise: null };
      mine.promise = probe(key).finally(() => { if (inflight === mine) inflight = null; });
      inflight = mine;
      return mine.promise;
    },

    /** Sync view of what is known right now — what a plan builder reads. */
    current() {
      const override = dockerOverrideArgv(env);
      if (override) return { argv: override, via: 'override' };
      if (settled?.key === rawOverride()) return { argv: [...settled.argv], via: settled.via };
      return { argv: [...DIRECT_DOCKER], via: 'direct' };
    },

    /** Our own docker call showed an access failure: forget the mode, re-resolve in the background. */
    invalidate() {
      if (dockerOverrideArgv(env) || inflight) return;
      settled = null;
      resolver.resolve().catch(() => { /* a probe never rejects; a malformed override is surfaced elsewhere */ });
    },

    lastFailure() { return failure; },
  };
  return resolver;
}
