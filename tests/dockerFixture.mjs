// FIXTURES FOR THE REAL-DOCKER TESTS. No tests of its own.
//
// Everything here is allowed to run `docker run` / `docker rm` — a test fixture
// may create and destroy containers. THE PROVIDER MAY NOT: attach-only is
// enforced in src/launcher/kinds/docker.mjs and pinned by
// tests/dockerkind.test.mjs.
//
// THE SKIP GATE IS A DAEMON PROBE, NOT A `which`. This host has the docker CLI
// installed and its socket unreadable, so `command -v docker` would let every
// live test run and then fail with a permission error. `docker version` against
// the daemon is the only question worth asking.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOCKER_ENV, dockerCliArgv } from '../src/launcher/kinds/docker.mjs';

const PROBE_TIMEOUT_MS = 5_000;

// Names must not collide across parallel test FILES (node --test runs one
// process per file), so both the pid and a per-process counter go in.
let seq = 0;
const uniqueName = (stem) => `code-system-test-${stem}-${process.pid}-${seq++}`;

/** Run an argv and collect everything, never rejecting for a non-zero exit. */
export function run(argv, { timeoutMs = 30_000, stdin = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { resolve({ code: null, stdout: '', stderr: String(e?.message ?? e) }); return; }
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, stdout: '', stderr: String(e?.message ?? e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (stdin && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  });
}

// The two invocations worth trying, in order: whatever the environment names,
// then `sudo -n docker` (this host's socket is root-owned). `-n` so a host
// wanting a password fails instead of hanging on a prompt.
//
// EXPORTED SO IT IS FENCED. Deleting the `sudo -n docker` fallback keeps
// `npm test` green on this host by silently skipping all of
// tests/docker-live.test.mjs, and no skip count is asserted anywhere — so the
// composition itself is what a test has to pin. See tests/dockerkind.test.mjs.
export function candidates(env) {
  const out = [];
  try { out.push(dockerCliArgv(env)); } catch { /* a malformed override is simply not a candidate */ }
  const sudo = ['sudo', '-n', 'docker'];
  if (!out.some(c => c.join(' ') === sudo.join(' '))) out.push(sudo);
  return out;
}

export const SKIP_REASON =
  'no reachable Docker daemon: tried the CODE_SYSTEM_DOCKER invocation (default `docker`)'
  + ` and \`sudo -n docker\`, and neither answered \`version\`. Set ${DOCKER_ENV} to a working`
  + ' argv, e.g. CODE_SYSTEM_DOCKER=\'["sudo","-n","docker"]\', to run the live docker tests.';

/**
 * Does this invocation reach a DAEMON? Asks for the SERVER version, so a CLI
 * that is installed but cannot reach the socket fails here — measured on this
 * host, unprivileged `docker version` still prints its whole Client block to
 * stdout and exits 1. That is why the gate is this and not `command -v docker`.
 * @returns {Promise<{cli:string[], serverVersion:string}|null>}
 */
export async function probeCli(cli) {
  const res = await run([...cli, 'version', '--format', '{{.Server.Version}}'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (res.code !== 0) return null;
  const serverVersion = res.stdout.trim();
  return serverVersion ? { cli, serverVersion } : null;
}

let resolved;
/** @returns {Promise<{cli:string[], serverVersion:string}|null>} */
export async function resolveDockerCli(env = process.env) {
  // Memoised per environment: a `docker version` per test would dominate the
  // suite, and the answer cannot change mid-run.
  const key = JSON.stringify(env[DOCKER_ENV] ?? '');
  if (resolved?.key === key) return resolved.value;
  let value = null;
  for (const cli of candidates(env)) {
    value = await probeCli(cli);
    if (value) break;
  }
  resolved = { key, value };
  return value;
}

/**
 * Skips the test LOUDLY when no daemon answers — the reason names both attempts
 * and the override, so a skipped run is diagnosable rather than silent.
 * @returns {Promise<{cli:string[], serverVersion:string}|null>} falsy when skipped
 */
export async function skipUnlessDocker(t) {
  const found = await resolveDockerCli();
  if (!found) { t.skip(SKIP_REASON); return null; }
  return found;
}

/**
 * A container of our own, removed however the test ends.
 * NOT `--rm`: a test that stops the container must leave it EXISTING-but-stopped
 * (`Error response from daemon: container … is not running`), and `--rm` would
 * delete it into the different "No such container" case instead.
 */
export async function withContainer(t, cli, { image = 'node:24-slim', stem = 'box' } = {}) {
  const name = uniqueName(stem);
  const res = await run([...cli, 'run', '-d', '--name', name, image, 'sleep', '600']);
  t.after(async () => { await run([...cli, 'rm', '-f', name]); });
  if (res.code !== 0) throw new Error(`could not start fixture container ${name}: ${res.stderr || res.stdout}`);
  return name;
}

/** Run a script inside the container, for assertions. */
export function inContainer(cli, container, script, { env = {} } = {}) {
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return run([...cli, 'exec', ...flags, '--', container, '/bin/sh', '-c', script]);
}

// THE MARKER IS PASSED IN THE ENVIRONMENT, NOT IN THE SCRIPT, so the scanning
// shell's OWN /proc/<pid>/cmdline cannot contain it and count itself. (Measured
// the other way round first: a script with the marker inlined always reports at
// least one.) `/proc` rather than `ps` — node:24-slim has no `ps`.
export async function markerCount(cli, container, marker) {
  const res = await inContainer(cli, container, [
    'n=0',
    'for d in /proc/[0-9]*; do',
    '  c=$(tr \'\\0\' \' \' < "$d/cmdline" 2>/dev/null)',
    '  case "$c" in *"$CC_MARKER"*) n=$((n+1)) ;; esac',
    'done',
    'printf %s "$n"',
  ].join('\n'), { env: { CC_MARKER: marker } });
  if (res.code !== 0) throw new Error(`markerCount failed: ${res.stderr || res.stdout}`);
  return Number(res.stdout.trim());
}

/**
 * An executable that records each invocation's argv and then becomes the real
 * docker CLI. Point CODE_SYSTEM_DOCKER at `argv` to count what the launcher
 * really ran — which no pure test can show.
 */
export async function countingShim(dir, cli) {
  const logPath = path.join(dir, 'docker-calls.log');
  const bin = path.join(dir, 'docker-shim.sh');
  await fs.writeFile(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
    `exec ${cli.map(c => JSON.stringify(c)).join(' ')} "$@"`,
  ].join('\n'));
  await fs.chmod(bin, 0o755);
  return {
    argv: [bin],
    logPath,
    async calls() {
      try { return (await fs.readFile(logPath, 'utf8')).split('\n').filter(Boolean); }
      catch { return []; }
    },
  };
}

export async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-docker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The bounded poll tests/launcher-shutdown.test.mjs uses: no sleeps, no timing luck. */
export async function settle(pred, ms = 5_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return pred();
}
