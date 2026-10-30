// PINS the SESSION-SCOPED reap a closed terminal is relayed with: cc's §5 close
// contract is "hang the terminal up (SIGHUP to its session), then SIGKILL what is
// left … A job that left the session (`setsid`) survives". Run against THIS
// machine's own /proc, which is exactly what the script reads on a far side.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { REAP_TAG, TOKEN_VAR, buildSessionReapScript } from '../src/launcher/kinds/reapscript.mjs';
import { settle } from './dockerFixture.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const state = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]; } catch { return null; } };
const gone = (pid) => !alive(pid) || state(pid) === 'Z';

// A session leader (node's `detached` is setsid) carrying the token, with a
// background job in its session and a `setsid` job outside it — both inheriting
// the token. Prints the three pids.
function session(token) {
  const child = spawn('/bin/sh', ['-c',
    'sleep 1000 & echo BG=$!; setsid sleep 1000 & echo SS=$!; echo LEAD=$$; wait'], {
    detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, [TOKEN_VAR]: token },
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  return {
    child,
    pids: () => settle(() => /LEAD=\d+/.test(out), 5_000).then(() => ({
      bg: Number(/BG=(\d+)/.exec(out)[1]), ss: Number(/SS=(\d+)/.exec(out)[1]), lead: Number(/LEAD=(\d+)/.exec(out)[1]),
    })),
  };
}

test('the session reap kills the token holders in the session and spares one that called setsid', async (t) => {
  const token = randomBytes(12).toString('hex');
  const s = session(token);
  const { bg, ss, lead } = await s.pids();
  t.after(() => { for (const p of [bg, ss, lead]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } });
  // The negative control: everything is alive before the reap.
  assert.ok(alive(bg) && alive(ss) && alive(lead), 'all three run before the reap');

  const r = spawnSync('/bin/sh', ['-c', buildSessionReapScript(token, lead)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^${REAP_TAG} ok \\d+ \\d+\\n$`));
  assert.ok(await settle(() => gone(lead) && gone(bg), 3_000), 'the session leader and its background job are gone');
  assert.ok(alive(ss) && state(ss) !== 'Z', 'the job that left the session survives');
});

test('the session reap ignores a token holder in that session it was not asked about, and a session without the token', async (t) => {
  const mine = randomBytes(12).toString('hex');
  const other = randomBytes(12).toString('hex');
  const a = session(mine);
  const b = session(other);
  const pa = await a.pids();
  const pb = await b.pids();
  t.after(() => { for (const p of [...Object.values(pa), ...Object.values(pb)]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } });
  // `mine`'s token, but the OTHER session's sid: nothing carries both.
  const r = spawnSync('/bin/sh', ['-c', buildSessionReapScript(mine, pb.lead)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const p of [...Object.values(pa), ...Object.values(pb)]) assert.ok(alive(p) && state(p) !== 'Z', `${p} survives`);
});

test('the session reap answers blind, exit 3, when it can read no environ at all', () => {
  // No `tr` on the PATH is the measured way the scan goes blind.
  const r = spawnSync('/bin/sh', ['-c', buildSessionReapScript('t'.repeat(24), 1)],
    { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, `${REAP_TAG} blind\n`);
});
