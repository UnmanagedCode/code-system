// READING THE LAUNCHER'S OWN STDERR BACK. Pure — it takes the text, never a
// path — and pinned by tests/boundconformance.test.mjs. No tests of its own.
//
// WHY A BOUND RUN NEEDS THIS AT ALL. cc's ProviderConnection spawns the
// provider with piped stdio and drains its stderr into a BOUNDED TAIL that it
// prints only inside an ETRANSPORT message, so a launcher that exits cleanly
// has its diagnostics discarded. Everything src/launcher/session.mjs reports
// there — the admission-drift alarm included — is therefore invisible to a run
// that went well, which is precisely the run in which the alarm matters.
// tests/conformance-docker.mjs redirects that stream to a file and hands the
// contents here.

import { ADMISSION_DRIFT_WARNING, CHANNEL_CENSUS_PREFIX } from '../src/launcher/session.mjs';

// The census line's numeric tail, anchored on the prefix session.mjs exports so
// the two halves cannot disagree about the words.
const CENSUS_RE = new RegExp(`${CHANNEL_CENSUS_PREFIX} (\\d+) of (\\d+) admitted ops on (\\d+) channels`);

/**
 * TWO DIFFERENT JOBS, and only one of them is a guard.
 *
 * The drift warning is an ALARM: it means a cc derivation stopped matching
 * src/launcher/admission.mjs and every op of that shape quietly fell back to the
 * per-op spawn — a change no outcome in cc's battery can show, because admission
 * fails CLOSED and the slow path is still correct. Its presence reds the run.
 *
 * The census is a MEASUREMENT: it answers "was the channel carrying ops". The
 * channel-off arm correctly produces none at all, since src/launcher/main.mjs
 * builds no pool for `CODE_SYSTEM_CHANNEL=0`, so an absent census is not a
 * problem and is not treated as one.
 *
 * A census line matching the prefix but not `CENSUS_RE` IS a problem rather than
 * a line skipped: a format change that silently emptied this parse would read
 * exactly like a run whose channel carried nothing.
 *
 * @param {string} text everything the launchers of one arm wrote to stderr
 * @returns {{drift:string[], sessions:number, carried:number, admitted:number,
 *   channels:number, problems:string[], other:string[]}}
 */
export function readLauncherDiagnostics(text) {
  const out = { drift: [], sessions: 0, carried: 0, admitted: 0, channels: 0, problems: [], other: [] };
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);

  // DEDUPED: cc spawns a launcher per connection, so one standing condition
  // prints once per session and would otherwise be dozens of identical lines.
  for (const line of new Set(lines)) {
    if (line.includes(ADMISSION_DRIFT_WARNING)) out.drift.push(line);
    else if (!line.includes(CHANNEL_CENSUS_PREFIX)) out.other.push(line);
  }

  // Counted on every line, not on the deduped set: two sessions that carried the
  // same figures are two sessions.
  for (const line of lines) {
    if (!line.includes(CHANNEL_CENSUS_PREFIX)) continue;
    const m = CENSUS_RE.exec(line);
    if (!m) {
      out.problems.push(`a census line this runner cannot parse — the line format moved: ${line}`);
      continue;
    }
    out.sessions++;
    out.carried += Number(m[1]);
    out.admitted += Number(m[2]);
    out.channels += Number(m[3]);
  }

  for (const line of out.drift) {
    out.problems.push(`the launcher raised the admission-drift alarm: ${line}`);
  }
  return out;
}
