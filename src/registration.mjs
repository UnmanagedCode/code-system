// AUTO-REGISTRATION of this plugin's two cc System rows.
//
// Runs once, AFTER listen, and never blocks startup. It creates only what is
// missing, so restarts are idempotent. There is no system-CRUD UI: the rows are
// a property of the plugin being installed, not a thing a user configures.
//
// EVERY FAILURE IS A RECORDED STATE — never a throw, never an exit, never a
// retry loop. "Never crash-loop" is implemented by there being no loop: the one
// retry route is POST /api/registration/retry, driven by a button. State lives
// in memory only and is re-derived at every start, which is the right shape for
// a process the conductor kills and restarts at any time.
//
// REGISTRATION IS AN ACTIVE OPERATION (.wiki/gotchas/active-registration.md):
// cc placement-asserts and then SPAWNS the row's `launch` argv for a real
// handshake, so a 502 here means our launcher failed to greet, and a 400 is
// most often cc's `.git`-ancestor placement refusal.

import { LAUNCHER_MAIN } from './paths.mjs';
import { REGISTERED_KINDS } from './launcher/kinds/index.mjs';

const LABELS = { docker: 'Docker containers', ssh: 'SSH hosts' };

// THE ARGV IS A FUNCTION OF (install path, kind) ONLY — no config value appears
// in it. That is what lets cc's per-(row.id, JSON.stringify(argv)) handle cache
// (src/systems/registry.ts:186-193) hold ONE connection while remotes come and
// go: a new remote is a new file in the store and a new `bindRemote` view on
// the same process, never a re-registration.
//
// process.execPath rather than a bare "node": cc spawns without a shell, so a
// bare name would depend on the ORCHESTRATOR's PATH, which we do not control.
export function desiredRows() {
  return REGISTERED_KINDS.map(kind => ({
    id: kind,
    label: LABELS[kind] ?? kind,
    launch: [process.execPath, LAUNCHER_MAIN, '--kind', kind],
  }));
}

function sameLaunch(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

async function bodyText(res) {
  try { return (await res.text()).trim(); } catch { return ''; }
}

// cc's own message is preserved VERBATIM. The 400 case is the `.git`-ancestor
// refusal, whose text already names the offending directory and the fix
// (src/systems/sessionRoot.ts:78-83) — paraphrasing it would throw away the
// only actionable part.
function mapWrite(status, text, id) {
  if (status === 201 || status === 200) return { state: 'ok', httpStatus: status, message: `'${id}' is registered` };
  if (status === 409) return { state: 'ok', httpStatus: status, message: `'${id}' already exists` };
  if (status === 400) return { state: 'blocked', httpStatus: status, message: text };
  if (status === 502) {
    return {
      state: 'unreachable',
      httpStatus: status,
      message: `${text}\n\ncc spawned the code-system launcher and the handshake failed.`
        + ' That is a bug signal in this plugin, not a user error.',
    };
  }
  if (status === 404) return { state: 'unsupported', httpStatus: status, message: text };
  return { state: 'error', httpStatus: status, message: text || `HTTP ${status}` };
}

const OVERALL_ORDER = ['ok', 'unsupported', 'skipped', 'blocked', 'unreachable', 'error'];

function overall(rows) {
  let worst = 'ok';
  for (const r of rows) {
    if (OVERALL_ORDER.indexOf(r.state) > OVERALL_ORDER.indexOf(worst)) worst = r.state;
  }
  return worst;
}

/**
 * @returns {Promise<{state:string, detail?:string, rows:Array<{id:string,state:string,httpStatus:number|null,message:string}>, checkedAt:string}>}
 */
export async function register({
  conductorUrl = process.env.CONDUCTOR_URL,
  fetchImpl = globalThis.fetch,
  log = () => {},
} = {}) {
  const checkedAt = new Date().toISOString();
  const wanted = desiredRows();

  // Standalone-runnable is a plugin-compliance requirement, so no CONDUCTOR_URL
  // is a normal state, not a failure.
  if (!conductorUrl || !String(conductorUrl).trim()) {
    log('registration: skipped — CONDUCTOR_URL not set');
    return { state: 'skipped', detail: 'CONDUCTOR_URL not set — running standalone', rows: [], checkedAt };
  }
  const base = String(conductorUrl).trim().replace(/\/+$/, '');
  const collection = `${base}/api/settings/systems`;

  let existing;
  try {
    const res = await fetchImpl(collection);
    if (res.status === 404) {
      // A real and current condition, surfaced by name: this code-conductor
      // predates Systems support.
      const detail = 'this code-conductor has no Systems support (404 on /api/settings/systems)';
      log(`registration: unsupported — ${detail}`);
      return { state: 'unsupported', detail, rows: [], checkedAt };
    }
    if (!res.ok) {
      const detail = `GET ${collection} → ${res.status} ${await bodyText(res)}`;
      log(`registration: error — ${detail}`);
      return { state: 'error', detail, rows: [], checkedAt };
    }
    const json = await res.json();
    existing = Array.isArray(json?.systems) ? json.systems : [];
  } catch (e) {
    const detail = `GET ${collection} failed: ${e instanceof Error ? e.message : String(e)}`;
    log(`registration: error — ${detail}`);
    return { state: 'error', detail, rows: [], checkedAt };
  }

  const rows = [];
  for (const want of wanted) {
    const cur = existing.find(s => s?.id === want.id);
    try {
      if (cur && sameLaunch(cur.launch, want.launch)) {
        // SEND NOTHING. A PATCH would make cc re-probe
        // (src/appSettings.ts:604-607) for no reason on every backend restart.
        rows.push({ id: want.id, state: 'ok', httpStatus: null, message: `'${want.id}' is already registered` });
        log(`registration: '${want.id}' already registered — no request sent`);
        continue;
      }
      const res = cur
        ? await fetchImpl(`${collection}/${encodeURIComponent(want.id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ launch: want.launch }),
        })
        : await fetchImpl(collection, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: want.id, label: want.label, launch: want.launch }),
        });
      const mapped = mapWrite(res.status, await bodyText(res), want.id);
      rows.push({ id: want.id, ...mapped });
      log(`registration: '${want.id}' → ${mapped.state} (${cur ? 'PATCH' : 'POST'} ${res.status})`);
    } catch (e) {
      const message = `${cur ? 'PATCH' : 'POST'} for '${want.id}' failed: ${e instanceof Error ? e.message : String(e)}`;
      rows.push({ id: want.id, state: 'error', httpStatus: null, message });
      log(`registration: ${message}`);
    }
  }
  return { state: overall(rows), rows, checkedAt };
}

// The in-memory record the API serves. Re-derived at every start.
let current = { state: 'pending', rows: [], checkedAt: null };

export function registrationState() { return current; }

export async function runRegistration(opts = {}) {
  current = await register(opts);
  return current;
}
