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

const PLACEHOLDER_CWD = '/';

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
export function makeRunner(transport, config, remoteId = null) {
  return ({ script, stdinData = null, signal = null }) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('operation was closed by the client')); return; }
    const req = {
      argv: ['/bin/sh', '-c', script],
      shell: null,
      cwd: PLACEHOLDER_CWD,
      env: null,
      stdinMode: stdinData ? 'pipe' : 'ignore',
      remoteId,
      token: randomBytes(12).toString('hex'),
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
        // SIGKILL rather than the default SIGTERM: `close` is a hard kill.
        ...(signal ? { signal, killSignal: 'SIGKILL' } : {}),
      });
    } catch (e) { reject(e); return; }

    const out = [];
    const err = [];
    child.stdout?.on('data', b => out.push(b));
    child.stderr?.on('data', b => err.push(b));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (stdinData && child.stdin) {
      // A far side that exits before draining its stdin is not our error to
      // report — the exit code and stderr already say what happened.
      child.stdin.on('error', () => {});
      child.stdin.end(stdinData);
    }
  });
}
