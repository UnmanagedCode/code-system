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
import { kindDescriptors } from './launcher/kinds/index.mjs';

// Node's fetch has NO DEFAULT TIMEOUT, so a CONDUCTOR_URL that accepts the
// connection and then stalls would hang POST /api/registration/retry forever —
// a user-facing request with no way out. And an unbounded body is buffered
// whole, so a hostile or broken conductor could hand us a gigabyte.
export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

// Read at most MAX_BODY_BYTES of a response, without buffering the rest.
// Exported because src/api.mjs reads the same conductor endpoint.
export async function readCapped(res) {
  try {
    if (!res.body) return (await res.text()).slice(0, MAX_BODY_BYTES).trim();
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      chunks.push(Buffer.from(chunk));
      total += chunk.length;
      if (total >= MAX_BODY_BYTES) break;
    }
    return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString('utf8').trim();
  } catch { return ''; }
}

const bodyText = readCapped;

function withTimeout(init = {}) {
  return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

// THE ARGV IS A FUNCTION OF (install path, kind) ONLY — no config value appears
// in it. That is what lets cc's per-(row.id, JSON.stringify(argv)) handle cache
// (src/systems/registry.ts, the HANDLES cache) hold ONE connection while remotes come and
// go: a new remote is a new file in the store and a new `bindRemote` view on
// the same process, never a re-registration.
//
// process.execPath rather than a bare "node": cc spawns without a shell, so a
// bare name would depend on the ORCHESTRATOR's PATH, which we do not control.
export function desiredRows() {
  // The label comes from the KIND's own descriptor, so the name a user sees on
  // the cc System row and the name on a card cannot drift apart.
  return kindDescriptors().map(({ kind, label }) => ({
    id: kind,
    label,
    launch: [process.execPath, LAUNCHER_MAIN, '--kind', kind],
  }));
}

// UNWRAP CC'S ERROR ENVELOPE.
//
// cc answers EVERY /api/settings/systems refusal as `{"error":"<message>"}` and
// nothing else — its shared router-tail handler strips the `code` its internal
// errors carry (cc's src/routes.ts at the pin 8b7b10bf). The body has to be
// unwrapped or the card shows a JSON envelope where docs/protocol.md promises
// cc's own words, and the `.git`-ancestor placement refusal — the 400 a user is
// most likely to meet — is exactly the message that must read as a sentence.
//
// FALLS BACK TO THE RAW TEXT, deliberately, in two directions: a proxy or a
// crash page can answer something that is not JSON at all, and a JSON body with
// no `error` key is somebody else's shape. In both cases that text is still the
// most useful thing we have, and swallowing it would leave a bare status code.
function ccMessage(text) {
  const raw = String(text ?? '');
  if (!raw.trimStart().startsWith('{')) return raw;
  try {
    const json = JSON.parse(raw);
    return typeof json?.error === 'string' && json.error !== '' ? json.error : raw;
  } catch { return raw; }
}

function sameLaunch(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// cc's own message is preserved VERBATIM. The 400 case is the `.git`-ancestor
// refusal, whose text already names the offending directory and the fix
// (src/systems/sessionRoot.ts, assertSessionRootsPlaceable) — paraphrasing it would throw away the
// only actionable part.
// NOTE: 404 is deliberately absent. `unsupported` means "this code-conductor
// has no Systems support", which is only knowable from the COLLECTION GET; a
// 404 on a per-row PATCH means the row vanished between our GET and our write,
// which is an `error` for the user to see, not a claim about cc's version.
function mapWrite(status, text, id) {
  if (status === 201 || status === 200) return { state: 'ok', httpStatus: status, message: `'${id}' is registered` };
  if (status === 409) return { state: 'ok', httpStatus: status, message: `'${id}' already exists` };
  const message = ccMessage(text);
  if (status === 400) return { state: 'blocked', httpStatus: status, message };
  if (status === 502) {
    return {
      state: 'unreachable',
      httpStatus: status,
      message: `${message}\n\ncc spawned the code-system launcher and the handshake failed.`
        + ' That is a bug signal in this plugin, not a user error.',
    };
  }
  return { state: 'error', httpStatus: status, message: message || `HTTP ${status}` };
}

// Re-GET the collection after a 409 and repair the row if the winner's launch
// argv is not ours.
async function reconcile(collection, want, fetchImpl, log) {
  try {
    const res = await fetchImpl(collection, withTimeout());
    if (!res.ok) return { state: 'ok', httpStatus: 409, message: `'${want.id}' already exists` };
    const json = JSON.parse(await bodyText(res) || '{}');
    const cur = (Array.isArray(json?.systems) ? json.systems : []).find(s => s?.id === want.id);
    if (!cur) return { state: 'ok', httpStatus: 409, message: `'${want.id}' already exists` };
    if (sameLaunch(cur.launch, want.launch)) {
      return { state: 'ok', httpStatus: 409, message: `'${want.id}' was created concurrently with the same launch` };
    }
    log(`registration: '${want.id}' lost a create race to a different launch — repairing`);
    const patch = await fetchImpl(`${collection}/${encodeURIComponent(want.id)}`, withTimeout({
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ launch: want.launch }),
    }));
    return mapWrite(patch.status, await bodyText(patch), want.id);
  } catch (e) {
    return { state: 'error', httpStatus: 409, message: `reconciling '${want.id}' after 409 failed: ${e instanceof Error ? e.message : String(e)}` };
  }
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
    const res = await fetchImpl(collection, withTimeout());
    if (res.status === 404) {
      // A real and current condition, surfaced by name: this code-conductor
      // predates Systems support.
      const detail = 'this code-conductor has no Systems support (404 on /api/settings/systems)';
      log(`registration: unsupported — ${detail}`);
      return { state: 'unsupported', detail, rows: [], checkedAt };
    }
    if (!res.ok) {
      const detail = `GET ${collection} → ${res.status} ${ccMessage(await bodyText(res))}`;
      log(`registration: error — ${detail}`);
      return { state: 'error', detail, rows: [], checkedAt };
    }
    // Capped read + parse, not res.json(), which would buffer the whole body.
    const json = JSON.parse(await bodyText(res) || '{}');
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
        // (src/appSettings.ts, updateSystem) for no reason on every backend restart.
        rows.push({ id: want.id, state: 'ok', httpStatus: null, message: `'${want.id}' is already registered` });
        log(`registration: '${want.id}' already registered — no request sent`);
        continue;
      }
      const res = cur
        ? await fetchImpl(`${collection}/${encodeURIComponent(want.id)}`, withTimeout({
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ launch: want.launch }),
        }))
        : await fetchImpl(collection, withTimeout({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: want.id, label: want.label, launch: want.launch }),
        }));
      let mapped = mapWrite(res.status, await bodyText(res), want.id);
      // A 409 means another backend instance created the row while we were
      // deciding. RE-READ AND RECONCILE rather than assuming it matches: the
      // winner may have registered a different launch argv (an older install
      // path), and leaving that in place would keep cc spawning the wrong
      // launcher.
      if (res.status === 409) mapped = await reconcile(collection, want, fetchImpl, log);
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
