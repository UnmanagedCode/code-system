// FIXTURES FOR THE REAL-SSH TESTS. No tests of its own.
//
// A live sshd in a container, reached by the SHIPPED provider over a real ssh
// client. Everything here is allowed to build images, run containers and
// generate keys — a test fixture may. THE PROVIDER MAY NOT: it is attach-only,
// and it never mutates the remote host.
//
// THE IMAGE IS BUILT IN-TREE rather than reusing any local one. Two reasons,
// both measured: the ssh-box image on this host bakes an `authorized_keys` from
// a private key we do not have, and it is Alpine/BusyBox, which
// .wiki/gotchas/baseline-probe-two-tier.md records as failing our tooling
// baseline in FOUR capabilities — so `fileops` would be gated off and the live
// suite could not exercise the thing it exists to exercise. debian:13-slim
// satisfies the GNU/POSIX baseline the protocol assumes.
//
// IT IS BUILT WITH NO CONTEXT — `docker build -` with the Dockerfile on stdin.
// The authorized key is injected at RUN time instead.
//
// THE CONSTRAINT IS NARROWER THAN THIS COMMENT ONCE CLAIMED, and card 2026-0014
// measured it: a `-v` source and a build context are resolved by the DAEMON, on
// the HOST — so a path that exists on the host mounts fine (the workspace bind
// does, and the bound conformance run uses it), while this container's own
// overlay `/tmp` is nameable by nothing on the host and does not. Neither is
// "unavailable here". See .wiki/gotchas/bound-conformance.md.
//
// AN AGENT IS FORWARDED INTO THIS ENVIRONMENT WITH REAL KEYS. Every generated
// ssh_config therefore sets `IdentitiesOnly yes` and `IdentityAgent none`, so
// the suite can only ever offer the throwaway key it just generated and can
// never reach a host outside the fixture.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSH_ENV, createSshTransport } from '../src/launcher/kinds/ssh.mjs';
import { DOCKER_ENV } from '../src/launcher/kinds/docker.mjs';
import { resolveDockerCli, run, settle, tempDir } from './dockerFixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCKERFILE = path.join(HERE, 'fixtures', 'sshbox', 'Dockerfile');
export const IMAGE = 'code-system-sshbox:test';

const PROBE_TIMEOUT_MS = 5_000;
const BUILD_TIMEOUT_MS = 300_000;

let seq = 0;
const uniqueName = (stem) => `code-system-sshtest-${stem}-${process.pid}-${seq++}`;

/**
 * Is there an ssh CLIENT we can actually run? Asks for its version, which
 * OpenSSH prints and then exits 0 — so a missing or unrunnable binary fails
 * here rather than as a confusing per-test error.
 *
 * NOTE `ssh -V` writes its banner to STDERR, so a gate reading stdout only
 * would reject a perfectly good client. Measured on OpenSSH_10.0p2.
 * @returns {Promise<{cli:string[], version:string}|null>}
 */
export async function probeSshClient(cli = ['ssh']) {
  const res = await run([...cli, '-V'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (res.code !== 0) return null;
  const version = `${res.stderr}${res.stdout}`.trim().split('\n')[0];
  return version ? { cli, version } : null;
}

export const SKIP_REASON =
  'the live ssh tests need BOTH a reachable Docker daemon (to host the sshd target) and a'
  + ' runnable ssh client. Tried the CODE_SYSTEM_DOCKER invocation (default `docker`) and'
  + ' `sudo -n docker` for the daemon, and `ssh -V` for the client.'
  + ` Set ${DOCKER_ENV} to a working argv, e.g. ${DOCKER_ENV}='["sudo","-n","docker"]', to run them.`
  + ` (${SSH_ENV} overrides the ssh invocation the PROVIDER uses; it does not gate these tests —`
  + ' the fixture always points it at its own generated ssh_config.)';

/**
 * THE COMPOSED GATE, extracted so it can be fenced docker-free. Both halves
 * must answer: a host with a daemon but no ssh client, or an ssh client but no
 * daemon, must SKIP rather than fail every test with a confusing error.
 * @returns {Promise<{cli:string[], serverVersion:string, ssh:string[], sshVersion:string}|null>}
 */
export async function sshGate({ docker = resolveDockerCli, ssh = probeSshClient } = {}) {
  const d = await docker();
  if (!d) return null;
  const s = await ssh();
  if (!s) return null;
  return { cli: d.cli, serverVersion: d.serverVersion, ssh: s.cli, sshVersion: s.version };
}

let gate;
export async function resolveSshGate() {
  if (gate === undefined) gate = await sshGate();
  return gate;
}

/** Skips LOUDLY when either half of the gate is missing. */
export async function skipUnlessSsh(t) {
  const found = await resolveSshGate();
  if (!found) { t.skip(SKIP_REASON); return null; }
  return found;
}

// Built once per process: the layer cache makes a rebuild cheap, but a `docker
// build` per test would still dominate the suite.
let built;
async function ensureImage(cli) {
  if (built) return built;
  const dockerfile = await fs.readFile(DOCKERFILE);
  const res = await run([...cli, 'build', '-t', IMAGE, '-'],
    { timeoutMs: BUILD_TIMEOUT_MS, stdin: dockerfile });
  if (res.code !== 0) throw new Error(`could not build ${IMAGE}: ${res.stderr || res.stdout}`);
  built = IMAGE;
  return built;
}

/**
 * One live ssh target: a container running sshd, a throwaway keypair, its host
 * key captured OUT OF BAND, and an ssh_config that reaches it by Host ALIAS.
 *
 * THE ALIAS IS THE POINT, not decoration: the stored remote is `{host: <alias>}`
 * and every identity, port and known_hosts setting lives in the operator's own
 * ssh config. That is criterion 2 exercised rather than asserted.
 *
 * NO TRUST-ON-FIRST-USE ANYWHERE. The host key is read with `docker exec` and
 * written into a real known_hosts, so the provider's refusal to accept an
 * unknown key is never worked around by the fixture.
 */
export async function withSshTarget(t, gate, { stem = 'box', alias = uniqueName('alias'), extraConfig = [] } = {}) {
  // THE ALIAS IS UNIQUE PER TARGET BY DEFAULT, and that is not cosmetic:
  // `controlPathFor` keys on (user, host), so two targets sharing an alias
  // would share ONE master — and a test could silently multiplex onto the
  // previous test's container.
  const { cli } = gate;
  await ensureImage(cli);
  const dir = await tempDir(t);

  const key = path.join(dir, 'id');
  const keygen = await run(['ssh-keygen', '-t', 'ed25519', '-N', '', '-f', key, '-q', '-C', 'code-system-test']);
  if (keygen.code !== 0) throw new Error(`ssh-keygen failed: ${keygen.stderr || keygen.stdout}`);
  const pub = (await fs.readFile(`${key}.pub`, 'utf8')).trim();

  const name = uniqueName(stem);
  // NOT `--rm`: a test that stops the container must leave it existing.
  const started = await run([...cli, 'run', '-d', '--name', name, '-e', `AUTHORIZED_KEY=${pub}`, IMAGE]);
  const config = { host: alias, user: 'root' };

  // Registered BEFORE the started-ok check, so a container that came up and
  // then failed readiness is still removed.
  t.after(async () => {
    // THE SHIPPED `disconnect`, not a hand-rolled `ssh -O exit`: one
    // implementation across surfaces, and the teardown exercises it.
    try {
      await createSshTransport({ cli: [...gate.ssh, '-F', path.join(dir, 'ssh_config')] }).disconnect(config);
    } catch { /* nothing to close is the requested state */ }
    await run([...cli, 'rm', '-f', name]);
  });
  if (started.code !== 0) throw new Error(`could not start ${name}: ${started.stderr || started.stdout}`);

  const inspected = await run([...cli, 'inspect', '-f', '{{.NetworkSettings.IPAddress}}', '--', name]);
  const ip = inspected.stdout.trim();
  if (!ip) throw new Error(`could not read an IP for ${name}: ${inspected.stderr || inspected.stdout}`);

  // THE HOST KEY, OUT OF BAND. The entrypoint runs `ssh-keygen -A`, so poll for
  // it rather than sleeping.
  let hostKey = '';
  await settle(async () => {
    const res = await run([...cli, 'exec', '--', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
    if (res.code === 0 && res.stdout.trim()) { hostKey = res.stdout.trim(); return true; }
    return false;
  }, 20_000);
  if (!hostKey) throw new Error(`could not read the host key of ${name}`);

  const knownHosts = path.join(dir, 'known_hosts');
  await fs.writeFile(knownHosts, `${ip} ${hostKey}\n`);

  const sshConfig = path.join(dir, 'ssh_config');
  await writeSshConfig(sshConfig, [
    `Host ${alias}`,
    `  HostName ${ip}`,
    '  User root',
    `  IdentityFile ${key}`,
    // THESE TWO ARE WHAT KEEP THE FORWARDED AGENT OUT OF THIS SUITE.
    '  IdentitiesOnly yes',
    '  IdentityAgent none',
    `  UserKnownHostsFile ${knownHosts}`,
    // DELIBERATELY NO `StrictHostKeyChecking`. The provider's known_hosts policy
    // works by OpenSSH's DEFAULT (`ask`) combining with the `BatchMode=yes` the
    // provider sets, so pinning the option here would test the fixture instead
    // of the policy.
    ...extraConfig,
  ]);

  // READINESS BY BOUNDED POLL, never a sleep. Uses ControlPath=none so probing
  // cannot leave a master behind and pre-empt what a test is measuring.
  const ready = await settle(async () => {
    const res = await run([...gate.ssh, '-F', sshConfig, '-T', '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=2', '-o', 'ControlPath=none', '--', alias, 'true']);
    return res.code === 0;
  }, 30_000);
  if (!ready) throw new Error(`sshd in ${name} never accepted a connection`);

  return {
    name, ip, alias, dir, key, hostKey, knownHosts, sshConfig, config,
    // What the LAUNCHER is given, so the provider runs through this fixture's
    // config and nothing else.
    sshEnv: JSON.stringify([...gate.ssh, '-F', sshConfig]),
    transport: () => createSshTransport({ cli: [...gate.ssh, '-F', sshConfig] }),
  };
}

/** An ssh_config only its owner can read — ssh refuses a group-writable one. */
export async function writeSshConfig(file, lines) {
  await fs.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

/** Run a script inside the target container, OUT OF BAND, for assertions. */
export function inTarget(cli, name, script, { env = {} } = {}) {
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return run([...cli, 'exec', ...flags, '--', name, '/bin/sh', '-c', script]);
}

// THE MARKER IS PASSED IN THE ENVIRONMENT, NOT IN THE SCRIPT, so the scanning
// shell's own /proc/<pid>/cmdline cannot contain it and count itself.
export async function markerCount(cli, name, marker) {
  const res = await inTarget(cli, name, [
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
 * Live processes ON THIS HOST whose argv names `controlPath` — the master,
 * plus any redundant client that failed to take ownership of it. The host-side
 * twin of `markerCount`, and the same reason for /proc over `ps`: this
 * devcontainer is not guaranteed a `ps`.
 *
 * The manual reproducer this replaces is `ps -eo pid,args | grep
 * ControlMaster=yes`, whose tell is SEVERAL `ssh … -N -f` naming the SAME
 * ControlPath.
 *
 * MATCH AN EXACT ARGV ELEMENT, not a substring of the joined line.
 * `sshBaseArgs` emits `-o` and `ControlPath=<p>` as two elements and
 * /proc/<pid>/cmdline is NUL-separated, so an exact element compare is right —
 * a substring match over the joined string would also count a DIFFERENT remote
 * whose path is a prefix of ours, and would count this scanning process itself
 * if the path ever reached its argv.
 *
 * Every read is best-effort: a pid can exit between readdir and read (ENOENT)
 * and /proc holds entries we may not read (EACCES). Both are skipped, never
 * thrown — a race must not red a test about orphans.
 *
 * TAKE THE COUNT AFTER `connect()` HAS RESOLVED: the provider's own `-O check`
 * invocations name the same ControlPath but are short-lived and already reaped
 * by then, so a settled count is exactly the masters.
 *
 * @returns {Promise<{count:number, pids:number[], cmdlines:string[]}>}
 *   `pids` so a test can SIGKILL the master out of band; `cmdlines` so a failure
 *   NAMES the orphans instead of asserting `2 !== 1`.
 */
export async function controlPathProcs(controlPath) {
  const want = `ControlPath=${controlPath}`;
  const pids = [];
  const cmdlines = [];
  let entries;
  try { entries = await fs.readdir('/proc'); }
  catch { return { count: 0, pids, cmdlines }; }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    let raw;
    try { raw = await fs.readFile(path.join('/proc', d, 'cmdline'), 'utf8'); }
    catch { continue; }
    const parts = raw.split('\0').filter(Boolean);
    if (!parts.includes(want)) continue;
    pids.push(Number(d));
    cmdlines.push(parts.join(' '));
  }
  return { count: pids.length, pids, cmdlines };
}

/**
 * How many times sshd has ACCEPTED AN AUTHENTICATION. sshd runs with `-e`, so
 * it logs to stderr and `docker logs` has it.
 *
 * THIS IS THE ONLY HONEST DISCRIMINATOR FOR MULTIPLEXING. "The command worked"
 * is what an unmultiplexed run also looks like; a flat authentication count
 * across N commands is what proves they shared one connection. Measured: one
 * `connect` + five execs → 1, and five execs with `ControlPath=none` → 5.
 */
export async function authCount(cli, name) {
  const res = await run([...cli, 'logs', name]);
  const text = `${res.stdout}${res.stderr}`;
  return (text.match(/Accepted publickey/g) ?? []).length;
}

export { run, settle, tempDir } from './dockerFixture.mjs';
