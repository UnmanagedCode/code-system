// THE BOUND RUN'S FIXTURE: filesystem identity, and the container that serves
// it. No tests of its own — the pure halves are pinned by
// tests/boundconformance.test.mjs, docker-free.
//
// WHY ANY OF THIS EXISTS. cc's conformance suite builds its fixtures with
// node's own `fs` and then asks the provider about them, so a bound run needs a
// far side that reaches THE TEST PROCESS'S OWN FILESYSTEM AT THE SAME ABSOLUTE
// PATHS. Two facts make that obtainable here and are the whole mechanism:
//
//  1. Every fixture root in the suite is `mkdtemp(path.join(os.tmpdir(), …))`,
//     and node's `os.tmpdir()` reads `TMPDIR` on every call — so the fixtures
//     can be redirected into a directory we choose, with no edit to cc.
//  2. A `-v` SOURCE PATH IS RESOLVED BY THE DAEMON, ON THE HOST, never inside
//     this container. So the directory we choose has to be one that exists on
//     the host, reachable through a bind this container already has. `/tmp` is
//     this container's own overlay and appears in no mount of ours; the
//     workspace bind does, which is why the scratch lives under the repo.
//
// NOTHING HERE IS HARDCODED TO THIS BOX. The self container id, the bind's host
// source and its container destination are all MEASURED, cross-checked against
// each other, and refused by name on disagreement — see `establishIdentity`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run } from './dockerFixture.mjs';

/** A container id is 64 hex; the cgroup/mount trail names it in full. */
const CONTAINER_ID_RE = /\/docker\/containers\/([0-9a-f]{64})\b/;

/**
 * Our own container id, read from `/proc/self/mountinfo` — the daemon bind-mounts
 * `/docker/containers/<id>/{hostname,hosts,resolv.conf}` into every container, so
 * the id is in there verbatim. Preferred over `/etc/hostname`, which is only the
 * SHORT id and only until somebody passes `--hostname`.
 * @returns {string|null}
 */
export function parseSelfContainerId(mountinfo) {
  return CONTAINER_ID_RE.exec(mountinfo)?.[1] ?? null;
}

// mountinfo escapes space, tab, newline and backslash in the octal forms below.
// A workspace path containing a space is not exotic, and an unescaped compare
// would silently fail to find its mount.
const unescapeField = (s) => s.replace(/\\(040|011|012|134)/g, (_, o) => ({
  '040': ' ', '011': '\t', '012': '\n', '134': '\\',
}[o]));

/**
 * The mountinfo record for a mount point, as `{ root, mountPoint, source }`.
 * Fields 4 and 5 (1-indexed) are the root within the filesystem and the mount
 * point; `root` is the HOST-SIDE path for a bind, which is exactly the
 * cross-check `establishIdentity` runs against `docker inspect`.
 * @returns {{root:string, mountPoint:string}|null}
 */
export function parseMountinfoBind(mountinfo, mountPoint) {
  for (const line of mountinfo.split('\n')) {
    const f = line.split(' ');
    if (f.length < 5) continue;
    if (unescapeField(f[4]) !== mountPoint) continue;
    return { root: unescapeField(f[3]), mountPoint };
  }
  return null;
}

/**
 * Which of this container's binds contains `containerPath`, and what the host
 * calls it. LONGEST destination wins, so a nested bind beats its parent.
 * @param {string} containerPath
 * @param {{Source:string, Destination:string}[]} mounts from `docker inspect`
 * @returns {{source:string, destination:string, hostPath:string}|null}
 */
export function hostSourceFor(containerPath, mounts) {
  let best = null;
  for (const m of mounts ?? []) {
    const dest = m?.Destination;
    const src = m?.Source;
    if (typeof dest !== 'string' || typeof src !== 'string' || !dest || !src) continue;
    if (containerPath !== dest && !containerPath.startsWith(`${dest}${path.sep}`)) continue;
    if (best && best.destination.length >= dest.length) continue;
    best = { source: src, destination: dest, hostPath: path.join(src, path.relative(dest, containerPath)) };
  }
  return best;
}

/** A named refusal, so every failure below says which check failed and with what. */
export class IdentityError extends Error {
  constructor(check, message) { super(`${check}: ${message}`); this.check = check; }
}

const json = (res, what) => {
  try { return JSON.parse(res.stdout); }
  catch { throw new IdentityError(what, `docker inspect did not answer JSON: ${res.stderr || res.stdout}`); }
};

/**
 * Everything that has to be true before a bound run means anything, MEASURED —
 * and every value printed, so a run that is refused says which fact failed and
 * a run that proceeds shows what it stood on.
 *
 * Runs BEFORE the battery so a broken bind can never be mistaken for a
 * conformance failure.
 *
 * @param {object} o
 * @param {string[]} o.cli        the resolved docker invocation
 * @param {string}   o.scratchDir the per-run fixture root, already created
 * @param {string}   o.container  the fixture container, already started
 * @param {(s:string)=>void} o.log
 * @returns {Promise<void>} resolves when identity holds; throws IdentityError otherwise
 */
export async function proveIdentity({ cli, scratchDir, container, log }) {
  // ── path-prefix agreement, host side ──────────────────────────────
  // `withSystem` does `mkdtemp` then `realpath`; if those differ for us the
  // suite's own roots would differ too and every path assertion below would be
  // about the wrong directory.
  const real = await fs.realpath(scratchDir);
  if (real !== scratchDir) {
    throw new IdentityError('path-prefix agreement',
      `the scratch dir has a symlink component: mkdtemp gave ${scratchDir}, realpath gives ${real}`);
  }
  log(`identity: scratch ${scratchDir} (realpath agrees)`);

  // ── path-prefix agreement, container side ─────────────────────────
  const rp = await run([...cli, 'exec', '--', container, 'realpath', '-e', '--', scratchDir]);
  if (rp.code !== 0 || rp.stdout.trim() !== scratchDir) {
    throw new IdentityError('path-prefix agreement',
      `the container does not see ${scratchDir} at the same absolute path`
      + ` (realpath answered ${JSON.stringify(rp.stdout.trim())}, rc=${rp.code}: ${rp.stderr.trim()})`);
  }
  const pwd = await run([...cli, 'exec', '-w', scratchDir, '--', container, 'pwd']);
  if (pwd.code !== 0 || pwd.stdout.trim() !== scratchDir) {
    throw new IdentityError('path-prefix agreement',
      `\`docker exec -w ${scratchDir} pwd\` answered ${JSON.stringify(pwd.stdout.trim())} (rc=${pwd.code})`);
  }
  log('identity: realpath -e and `exec -w … pwd` both answer that path byte-for-byte');

  // ── byte identity, host → container ───────────────────────────────
  const hostToken = `HOSTTOKEN-${Math.random().toString(16).slice(2, 10)}`;
  const hostFile = path.join(scratchDir, 'identity-from-host.txt');
  await fs.writeFile(hostFile, `${hostToken}\n`);
  const readBack = await run([...cli, 'exec', '--', container, 'cat', '--', hostFile]);
  if (readBack.stdout.trim() !== hostToken) {
    throw new IdentityError('byte identity host→container',
      `wrote ${hostToken} at ${hostFile}; the container read ${JSON.stringify(readBack.stdout)}`
      + ` (rc=${readBack.code}: ${readBack.stderr.trim()})`);
  }
  log(`identity: ${hostToken} written here, read back inside at the same path`);

  // ── byte identity, container → host ───────────────────────────────
  const ctrToken = `CTRTOKEN-${Math.random().toString(16).slice(2, 10)}`;
  const ctrFile = path.join(scratchDir, 'identity-from-container.txt');
  const wrote = await run([...cli, 'exec', '--', container, '/bin/bash', '-lc',
    `printf '%s\\n' ${ctrToken} > ${JSON.stringify(ctrFile)}`]);
  if (wrote.code !== 0) {
    throw new IdentityError('byte identity container→host',
      `the container could not write ${ctrFile}: ${wrote.stderr.trim() || wrote.stdout.trim()}`);
  }
  const hostRead = await fs.readFile(ctrFile, 'utf8').catch(e => `<${e.code}>`);
  if (hostRead.trim() !== ctrToken) {
    throw new IdentityError('byte identity container→host',
      `the container wrote ${ctrToken}; this process reads ${JSON.stringify(hostRead)}`);
  }
  log(`identity: ${ctrToken} written inside, read back here at the same path`);

  // ── uid mapping ───────────────────────────────────────────────────
  // LOAD-BEARING, not hygiene. The suite's `readFile reports absence, a
  // directory, and an unreadable file` row chmods a file to 000 and requires
  // EACCES, and its own guard is `process.getuid() !== 0` on the TEST process —
  // which is not root here, so the row always runs. Measured: as uid 1000 the
  // container is refused; AS ROOT IT READS THE FILE and the row fails. A
  // default node:24-slim container runs as root.
  const uid = process.getuid();
  const gid = process.getgid();
  const idOut = await run([...cli, 'exec', '--', container, 'id', '-u']);
  if (Number(idOut.stdout.trim()) !== uid) {
    throw new IdentityError('uid mapping',
      `\`docker exec id -u\` answered ${JSON.stringify(idOut.stdout.trim())}, but this process is uid ${uid}`
      + ' — the suite\'s EACCES row (readFile of a 000 file) passes only when the far side is not root');
  }
  const statOut = await run([...cli, 'exec', '--', container, 'stat', '-c', '%u %g', '--', hostFile]);
  if (statOut.stdout.trim() !== `${uid} ${gid}`) {
    throw new IdentityError('uid mapping',
      `a file this process wrote stats as ${JSON.stringify(statOut.stdout.trim())} inside,`
      + ` but this process is ${uid} ${gid} — ownership does not survive the bind`);
  }
  log(`identity: the container is uid ${uid} gid ${gid}, and our files stat as ours inside it`);
}

/**
 * Where the daemon will find `containerPath`, cross-checked two ways.
 *
 * `docker inspect <self> .Mounts` is the authority; `/proc/self/mountinfo` is
 * the independent witness. THEY MUST AGREE — a disagreement means we are not
 * the container we think we are, and binding the wrong host directory would
 * give the fixture container a DIFFERENT filesystem that still answers every
 * path, which is the one failure this whole rig exists to make impossible.
 *
 * @returns {Promise<{selfId:string, hostPath:string, destination:string}>}
 */
export async function resolveHostPath({ cli, containerPath, log }) {
  const mountinfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
  const selfId = parseSelfContainerId(mountinfo);
  if (!selfId) {
    throw new IdentityError('self container id',
      'no /docker/containers/<id>/ mount in /proc/self/mountinfo — this process is not in a docker container,'
      + ' so there is no bind to translate through. Run the bound conformance from inside the workspace container.');
  }
  log(`identity: self container ${selfId}`);

  const inspect = await run([...cli, 'inspect', '--type', 'container', '--format', '{{json .Mounts}}', '--', selfId]);
  if (inspect.code !== 0) {
    throw new IdentityError('self container id',
      `the daemon does not know our own id ${selfId}: ${inspect.stderr.trim() || inspect.stdout.trim()}`);
  }
  const found = hostSourceFor(containerPath, json(inspect, 'self mounts'));
  if (!found) {
    throw new IdentityError('bind source',
      `${containerPath} is under no bind of this container, so the daemon cannot resolve a -v source for it`
      + ' — a `-v` source is resolved on the HOST, never inside this container');
  }
  log(`identity: bind ${found.source} → ${found.destination} (docker inspect)`);

  // The witness. mountinfo's `root` field is the host-side path of a bind, so
  // for the same mount point the two must name the same directory.
  const witness = parseMountinfoBind(mountinfo, found.destination);
  if (!witness) {
    throw new IdentityError('bind cross-check',
      `docker inspect calls ${found.destination} a mount, but /proc/self/mountinfo has no such mount point`);
  }
  if (witness.root !== found.source) {
    throw new IdentityError('bind cross-check',
      `docker inspect says ${found.destination} comes from ${found.source},`
      + ` but /proc/self/mountinfo says ${witness.root} — refusing to guess which is ours`);
  }
  log(`identity: /proc/self/mountinfo agrees (${witness.root})`);
  return { selfId, hostPath: found.hostPath, destination: found.destination };
}
