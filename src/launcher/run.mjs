// Run ONE script on a target and collect its result. The single implementation
// behind both surfaces that need it — the launcher's file operations
// (src/launcher/fileops.mjs) and the backend's tooling-baseline probe
// (src/baseline.mjs) — so the two can never disagree about how a command
// reaches a remote.
//
// NOT the `shell` exec form. cc's `shell` form is defined as a LOGIN shell
// (`bash -lc`, systems-protocol.md §5), which sources profile files whose
// output would arrive before the script's own — and our readers parse the first
// line. `/bin/sh -c` through the argv form keeps the channel clean.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ProtocolError } from './protocol.mjs';

const PLACEHOLDER_CWD = '/';

// Bytes of each stream shown to a kind's `classifyFailure`. Same bound
// session.mjs uses, for the same reason.
const CLASSIFY_HEAD_BYTES = 512;

/**
 * @param {import('./kinds/index.mjs').Transport} transport
 * @param {object} config      the remote's kind-specific config
 * @param {string|null} remoteId
 * @returns {(req:{script:string, stdinData?:Buffer|null, signal?:AbortSignal|null})
 *            => Promise<{code:number, stdout:Buffer, stderr:string}>}
 *
 * `signal` is how `close` reaches a derived operation. §5 says close means "cc
 * has stopped listening: kill the command (hard)", and cc's readFile/writeFile
 * backstop works BY sending close — so without a kill handle here that
 * instruction would be the one this launcher ignores, leaving a far-side
 * process nobody reaps.
 */
export function makeRunner(transport, config, remoteId = null, { token = null, onSpawn = null } = {}) {
  return ({ script, stdinData = null, signal = null }) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('operation was closed by the client')); return; }
    const req = {
      argv: ['/bin/sh', '-c', script],
      shell: null,
      cwd: PLACEHOLDER_CWD,
      env: null,
      stdinMode: stdinData ? 'pipe' : 'ignore',
      remoteId,
      token: token ?? randomBytes(12).toString('hex'),
    };
    let plan;
    try { plan = transport.spawnPlan(config ?? {}, req); }
    catch (e) { reject(e); return; }

    let child;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: plan.cwd,
        env: plan.env ?? undefined,
        stdio: [req.stdinMode, 'pipe', 'pipe'],
        // DETACHED, so the child LEADS ITS OWN PROCESS GROUP — and we kill that
        // group by hand rather than using node's `signal` option.
        //
        // node's `signal` kills only the direct pid. The read script's payload
        // stage is a PIPELINE (`tail | head | base64 | tr`) whose members are
        // the shell's GRANDCHILDREN: killing `sh` alone reparents them to PID 1
        // still blocked on the far side, forever. Measured — before this, a
        // full `npm test` left two live quartets behind.
        detached: true,
      });
    } catch (e) { reject(e); return; }
    onSpawn?.(child);

    // The whole group, because that is the point of `detached` above.
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const onAbort = () => killGroup();
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (fn) => (...args) => {
      signal?.removeEventListener('abort', onAbort);
      fn(...args);
    };

    const out = [];
    const err = [];
    child.stdout?.on('data', b => out.push(b));
    child.stderr?.on('data', b => err.push(b));
    child.on('error', settle(reject));
    child.on('close', settle((code) => {
      if (signal?.aborted) { reject(new Error('operation was closed by the client')); return; }
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      // THE TRANSPORT'S OWN FAILURE, not the script's. A stopped or missing
      // container is a non-zero exit of the docker CLI carrying a daemon
      // message — the script never ran at all — so reporting it as the script's
      // result would surface a bare EUNKNOWN with a parse failure behind it.
      // This is the single funnel for fileops.mjs AND the baseline probe, which
      // is why neither needs a line of transport-specific code. A null verdict
      // (the common case, and every kind without the hook) resolves as before.
      const verdict = code !== 0
        ? transport.classifyFailure?.(config ?? {}, {
            code: code ?? 1,
            // A bounded HEAD, matching session.mjs: the transport diagnostics this
            // reads are one short line, and a failed multi-megabyte read must
            // not be re-materialised as a string to look at its first 60 bytes.
            stdout: stdout.subarray(0, CLASSIFY_HEAD_BYTES).toString('utf8'),
            stderr: stderr.slice(0, CLASSIFY_HEAD_BYTES),
          })
        : null;
      if (verdict) {
        reject(new ProtocolError(verdict.code, verdict.message, {
          exitCode: code ?? 1, stderr: verdict.stderr ?? stderr,
        }));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    }));
    if (stdinData && child.stdin) {
      // A far side that exits before draining its stdin is not our error to
      // report — the exit code and stderr already say what happened.
      child.stdin.on('error', () => {});
      child.stdin.end(stdinData);
    }
  });
}
