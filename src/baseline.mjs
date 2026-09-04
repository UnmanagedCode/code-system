// THE TOOLING-BASELINE PROBE.
//
// Running the provider on cc's host does not free the target from cc's tooling
// requirements: cc derives `stat`, `readDir`, `realpath` and friends by sending
// `exec` frames carrying GNU-specific argv
// (.wiki/gotchas/tooling-baseline.md, docs/systems-protocol.md §7). A target
// missing that baseline must refuse CLEARLY, naming what was missing — never a
// half-working system.
//
// TWO TIERS, and this is the whole design:
//
//  1. `Transport.reachability` stays cheap and stays OUT of the target — a
//     `docker inspect` daemon query, or an ssh ControlPath socket's existence —
//     and returns a `fingerprint` that costs nothing extra, because it is built
//     from fields of a call already being made (image id + State.StartedAt; for
//     ssh the config hash plus the socket's inode+ctime).
//  2. This probe is ONE round trip, run by the backend, cached on the remote's
//     record against that fingerprint. So it costs one probe per container
//     start or image change — NOT one per card refresh — and a target that gets
//     fixed clears itself on the next refresh with no restart.
//
// IT NEVER RUNS DURING THE `hello` HANDSHAKE. cc's handshake budget is 10 s,
// and registration handshakes with ZERO remotes configured, so there is nothing
// to probe there anyway.
//
// IT IS NOT A REGISTRATION STATE. Registration is per-KIND — one `docker` row
// for every container — so a baseline failure on one Alpine container must not
// mark the whole row broken. It is per-remote and belongs on the card.

import { makeRunner } from './launcher/run.mjs';

// The capabilities the probe reports on. A run that does not answer for every
// one of them is incomplete, and incomplete is not "ok".
export const PROBE_CAPABILITIES = ['readDir', 'realpath', 'stat', 'base64', 'shell'];

// Anchored to THE EXACT ARGV CC SENDS (systems-protocol.md §7), in
// the exact forms.
//
// `command -v find` PROVES NOTHING: busybox HAS `find` and `stat` — what it
// lacks is `-printf` and `%.3Y` precision. The check must be of the flag, not
// of the binary.
//
// The `stat` row is why this asserts on OUTPUT SHAPE, not on exit code:
// busybox `stat` implements `-c` but ignores the `.3`, so it SUCCEEDS and is
// wrong — `81a4 2 1788194735` where GNU answers `81a4 2 1788194735.064`
// (systems-protocol.md §11, item 3). That silent degradation is the one cc
// will never surface on its own.
export const PROBE_SCRIPT = [
  'LC_ALL=C; export LC_ALL',
  `o=$(find /. -mindepth 1 -maxdepth 1 -printf '%y\\t%f\\n' 2>&1)`,
  `if [ $? -eq 0 ]; then printf 'OK\\treadDir\\n'; else printf 'FAIL\\treadDir\\tfind -printf\\t%s\\n' "$(printf '%s' "$o" | head -n 1)"; fi`,
  `o=$(realpath -e -- / 2>&1)`,
  `if [ $? -eq 0 ]; then printf 'OK\\trealpath\\n'; else printf 'FAIL\\trealpath\\trealpath -e --\\t%s\\n' "$(printf '%s' "$o" | head -n 1)"; fi`,
  `o=$(stat -L -c '%f %s %.3Y' -- / 2>&1)`,
  'if [ $? -ne 0 ]; then',
  `  printf 'FAIL\\tstat\\tstat -L -c %%f %%s %%.3Y\\t%s\\n' "$(printf '%s' "$o" | head -n 1)"`,
  'else',
  '  set -- $o',
  '  case "$3" in',
  `    *.*) printf 'OK\\tstat\\n' ;;`,
  `    *) printf 'FAIL\\tstat\\tstat -L -c %%.3Y\\tmtime has no sub-second precision: %s\\n' "$o" ;;`,
  '  esac',
  'fi',
  `if command -v base64 >/dev/null 2>&1; then printf 'OK\\tbase64\\n'; else printf 'FAIL\\tbase64\\tcommand -v base64\\tbase64 is not on PATH\\n'; fi`,
  `if [ -x /bin/bash ]; then printf 'OK\\tshell\\n'; else printf 'FAIL\\tshell\\t[ -x /bin/bash ]\\t/bin/bash is not executable on this target\\n'; fi`,
].join('\n');

/**
 * @returns {{state:'ok'|'unsupported', missing:Array<{capability:string,probe:string,detail:string}>}}
 */
export function parseProbeOutput({ stdout, stderr = '', code = 0 }) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? '');
  const missing = [];
  const answered = new Set();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const f = line.split('\t');
    if (f[0] === 'OK' && f[1]) { answered.add(f[1]); continue; }
    if (f[0] === 'FAIL' && f[1]) {
      answered.add(f[1]);
      missing.push({ capability: f[1], probe: f[2] ?? '', detail: f[3] ?? '' });
    }
  }
  // Nothing recognisable came back at all: the target could not run the probe,
  // which for a distroless/scratch image is the truth rather than an error to
  // paper over.
  if (answered.size === 0) {
    return {
      state: 'unsupported',
      missing: [{
        capability: 'shell',
        probe: '/bin/sh -c',
        detail: String(stderr ?? '').trim() || `the probe exited ${code} with no readable output`,
      }],
    };
  }
  for (const cap of PROBE_CAPABILITIES) {
    if (!answered.has(cap)) {
      missing.push({ capability: cap, probe: '(no answer)', detail: 'the target did not answer this probe' });
    }
  }
  return { state: missing.length > 0 ? 'unsupported' : 'ok', missing };
}

// Re-probe only when the current fingerprint differs from the stored one, or
// nothing is stored. This is what turns a per-card-refresh cost into a
// per-container-start one.
export function needsProbe(record, fingerprint) {
  const b = record?.baseline;
  if (!b || b.state === 'unknown' || !b.fingerprint) return true;
  return b.fingerprint !== fingerprint;
}

export function unknownBaseline() {
  return { state: 'unknown', fingerprint: null, missing: [], checkedAt: null };
}

/**
 * One probe round trip. Returns the new `baseline` object, or null when the
 * probe could not be run at all — in which case the stored verdict is left
 * exactly as it was, because "we could not look" is not the claim "unsupported".
 */
export async function probeBaseline(transport, record, fingerprint, { run = null } = {}) {
  const runner = run ?? makeRunner(transport, record.config ?? {}, record.remoteId);
  let res;
  try { res = await runner({ script: PROBE_SCRIPT }); }
  catch { return null; }
  const parsed = parseProbeOutput(res);
  return {
    state: parsed.state,
    fingerprint: fingerprint ?? null,
    missing: parsed.missing,
    checkedAt: new Date().toISOString(),
  };
}

// The decision the backend actually makes per card render, in one place so the
// caching rule is testable without an HTTP round trip: probe only when the
// remote is SWITCHED ON, the target is reachable, AND the fingerprint moved. A
// probe that could not run leaves the stored verdict exactly as it was.
//
// THE GATE BELONGS IN THIS CONDITION because the probe is the one backend path
// that execs INTO a target, and it bypasses the launcher's gate entirely — it
// runs in this process, not through StoreRemoteSource.lookup. Without it a
// switched-off remote would still be executed against on every card render,
// which is precisely what the operator withdrew permission for. It also saves a
// round trip per disabled card.
export async function refreshBaseline(transport, rec, reach, { run = null } = {}) {
  if (rec?.enabled !== true) return { record: rec, probed: false };
  if (!reach?.connected || !needsProbe(rec, reach.fingerprint)) return { record: rec, probed: false };
  const baseline = await probeBaseline(transport, rec, reach.fingerprint, { run });
  if (!baseline) return { record: rec, probed: false };
  return { record: { ...rec, baseline, updatedAt: new Date().toISOString() }, probed: true };
}
