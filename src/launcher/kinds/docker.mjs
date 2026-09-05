// The `docker` kind: `exec` over `docker exec`, reachability over
// `docker inspect`, and the MUST-3 kill relay a `docker exec` child needs
// because it lives in the container and does NOT die when this provider does
// (measured — see .wiki/gotchas/docker-exec-transport.md).
//
// It builds argv and nothing else. Frames, ids, chunking, error codes,
// timeouts and file semantics belong to session.mjs and fileops.mjs, once, for
// every kind — and `readFile`/`writeFile` are inherited from fileops.mjs, so
// there is no docker-specific file-transfer code here and never should be.

import { spawn } from 'node:child_process';
import { asObject, execEnv, operand } from './config.mjs';
// The kill relay's far-side script is SHARED with `ssh`: identical mechanism,
// identical reason (a far-side child is not this process's OS descendant).
import { REAP_TAG, TOKEN_VAR, buildReapScript } from './reapscript.mjs';

// THE OPERATOR SEAM for a host where the docker CLI needs a prefix (this one:
// the socket is root-owned, so live tests want ["sudo","-n","docker"]).
//
// A WHOLE ARGV, JSON — not a path — because the thing that varies is the
// invocation, not the binary.
//
// WHY AN ENV VAR AND NOT A STORE FIELD OR A LAUNCH FLAG:
//  - A store field would be an HTTP-WRITABLE EXECUTABLE ARGV on cc's host: the
//    backend REST surface writes remote records, so a card-UI field taking an
//    argv is remote code execution on cc's machine by design. config.mjs exists
//    to keep stored values from becoming options; it cannot make one safe as an
//    executable.
//  - A launch flag has to get its value from somewhere anyway, and changing it
//    would force a re-registration: src/registration.mjs makes the launch argv a
//    function of (install path, kind) ONLY, which is what holds cc's connection
//    cache while remotes come and go.
//  - An env var is operator-set rather than user-writable, is this codebase's
//    established seam for exactly this shape (CODE_SYSTEM_STORE,
//    CODE_SYSTEM_FAKE_TRANSPORT, CODE_SYSTEM_ALLOW_HOST_KIND), and cc spawns the
//    launcher with the ORCHESTRATOR's environment — so the operator running the
//    orchestrator is exactly who should own it. The backend reads the same
//    function in-process, so one implementation serves both surfaces.
export const DOCKER_ENV = 'CODE_SYSTEM_DOCKER';

// WHAT THE CARD UI RENDERS FOR THIS KIND, and the one home for its human label
// — src/registration.mjs reads it for the cc System row's label too, so the
// name a user sees in cc and on a card cannot drift apart.
//
// `configFields` is the form, and it must stay exactly what `validateConfig`
// below accepts; tests/kindmeta.test.mjs pins the two together.
export const KIND_META = {
  label: 'Docker containers',
  configFields: [
    {
      name: 'container',
      label: 'Container',
      required: true,
      placeholder: 'my-app',
      hint: 'The container name or id, as `docker ps` shows it. It must already be running — code-system never starts one.',
    },
  ],
};

// THE SHIPPED DEFAULT HARDCODES NO `sudo`. Pinned by tests/dockerkind.test.mjs.
const DEFAULT_CLI = ['docker'];

/**
 * @returns {string[]} the whole docker invocation, e.g. ['docker'] or ['sudo','-n','docker']
 * @throws on a malformed override — DELIBERATELY. In the launcher this surfaces
 *   through main.mjs's resolveTransport as exit 2 before any frame with our
 *   stderr quoted, which is how the `host` guard already refuses. Falling back
 *   to bare `docker` would instead fail every operation with a socket-permission
 *   error that names nothing.
 */
export function dockerCliArgv(env = process.env) {
  const raw = typeof env[DOCKER_ENV] === 'string' ? env[DOCKER_ENV].trim() : '';
  if (raw === '') return [...DEFAULT_CLI];
  const bad = (why) => new Error(
    `${DOCKER_ENV} ${why}. It must be a JSON array of non-empty strings — the WHOLE docker`
    + ` invocation, e.g. ${DOCKER_ENV}='["sudo","-n","docker"]'. Got ${JSON.stringify(raw)}`);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw bad('is not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw bad('is not a non-empty JSON array');
  if (!parsed.every(v => typeof v === 'string' && v !== '')) throw bad('contains a non-string or empty entry');
  return parsed;
}

// THE ONLY TWO SUBCOMMANDS THIS PROVIDER MAY EVER RUN. Attach-only is a locked
// decision (.wiki/decisions/architecture-shape.md): connecting never starts or
// stops a container. Enforced rather than remembered — every docker invocation
// this module makes goes through `runDocker`, which asserts membership, so a
// future edit reaching for `docker start` throws instead of shipping.
export const ALLOWED_SUBCOMMANDS = ['exec', 'inspect'];

// Throws for anything else. Not a defensive check against hostile input — the
// argv is built right here — it is the attach-only decision made unforgettable.
export function assertAttachOnly(subcommand) {
  if (ALLOWED_SUBCOMMANDS.includes(subcommand)) return;
  throw new Error(
    `the docker provider is ATTACH-ONLY and may only run ${ALLOWED_SUBCOMMANDS.join('/')},`
    + ` never '${subcommand}' — it must not start, stop, create or remove a container`);
}

// `docker inspect` is on every card render (GET /api/remotes → reachability), and
// an operator's override could be a `sudo` WITHOUT `-n` that blocks on a password
// prompt. Both docker calls are therefore bounded.
const INSPECT_TIMEOUT_MS = 5_000;
// Inside session.mjs's REAP_DEADLINE_MS (1500), which is itself inside cc's
// DEFAULT_SHUTDOWN_GRACE_MS (2000). Measured cost of the reap script: ~121 ms.
const REAP_TIMEOUT_MS = 1_200;

// Image id + State.StartedAt, from ONE call the card render is already making.
// A restarted container gets a new StartedAt, which is what makes the cached
// baseline verdict re-probe (src/baseline.mjs → needsProbe).
const INSPECT_FORMAT = '{{.State.Running}} {{.Image}} {{.State.StartedAt}}';

/**
 * The single funnel for every docker invocation this module makes. Bounded, and
 * never rejects for a non-zero exit: the caller reads `code`/`stderr`.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, error:Error|null}>}
 */
function runDocker(cli, args, { timeoutMs }) {
  assertAttachOnly(args[0]);
  return new Promise((resolve) => {
    let child;
    try {
      // detached so the timeout can kill the whole group: a `sudo` prompting for
      // a password is a grandchild of ours.
      child = spawn(cli[0], [...cli.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { resolve({ code: null, stdout: '', stderr: '', error: e }); return; }
    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    timer.unref?.();
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    child.stdout?.on('data', b => out.push(b));
    child.stderr?.on('data', b => err.push(b));
    child.on('error', e => done({ code: null, stdout: '', stderr: '', error: e }));
    child.on('close', code => done({
      code: code ?? 1,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      error: null,
    }));
  });
}

// A never-started `docker exec` puts its diagnostic on STDOUT with exit 127 or
// 128 (measured), where a daemon-level refusal puts it on stderr with exit 1.
// The longest stem SHARED by every measured never-started message. The
// `unable to start container process: ` segment that follows it on two of the
// three is absent from `Cwd must be an absolute path`, so anchoring on the
// longer string would report a non-absolute `-w` as the command having run and
// exited 128.
const OCI_PREFIX = 'OCI runtime exec failed: exec failed: ';
const DAEMON_PREFIX = 'Error response from daemon: ';

const first = (s) => String(s ?? '').split('\n')[0].trim();

export function createDockerTransport({ cli } = {}) {
  const argv0 = cli ?? dockerCliArgv();

  return {
    kind: 'docker',

    // FINAL, not "until card 2026-0003". It is achievable — measured, a
    // `docker exec`'d process is ALREADY its own process-group and session
    // leader (so §11 item 2's `setsid` prerequisite is unnecessary), and
    // `kill -9 -<pgid>` works inside the container although §11's own
    // `kill -- -<pgid>` is refused by dash's builtin. It stays false because
    // advertising `true` obliges SIGNAL FIDELITY (§5: "delivers exactly that
    // signal"), i.e. a whole `Transport.signal` seam relaying into the
    // container, for a capability whose only consumer at the pin is one call
    // site meaning "kill the command". `false` costs nothing: the core sets
    // `descendantsMaySurvive: true` on every exit it terminated and `reap`
    // SIGKILLs the container-side subtree anyway. Advertising `true` falsely is,
    // in §11's words, "the one lie this protocol cannot detect".
    // See .wiki/gotchas/docker-exec-transport.md for both measurements.
    processGroupSignal: false,

    // ALWAYS TRUE, never derived from store contents: cc memoises the handshake
    // per connection generation, so a capability that flapped as remotes were
    // added would be memoised wrong. One row serves every container
    // (systems-protocol.md §11).
    remotes: true,

    // ALWAYS TRUE, for the SAME reason `remotes` is, and never derived from
    // store contents: cc memoises the handshake per connection generation, so a
    // capability that flapped as remotes gained or lost a mirror would be
    // memoised wrong. The PER-REMOTE answer lives in the `describeRemote`
    // FRAME, from `record.mirror` (src/launcher/remotes.mjs) — and a remote the
    // operator did not opt in answers a descriptor with NEITHER field, which
    // §2.1 calls a valid "I advertise nothing" and cc takes down exactly the
    // path a provider that never heard of the frame takes.
    //
    // WHAT IT COSTS: one extra request/response pair per target per connection
    // generation for an opted-out remote. Everything downstream of the answer is
    // unchanged — cc's NO_ADVERTISEMENT → noMirror(systemPath) is the same
    // geometry, the same walk, the same exec frames.
    remoteDescriptors: true,

    validateConfig(raw) {
      const o = asObject(raw);
      // `container` becomes an ARGV OPERAND (`docker exec <container>`), so a
      // leading `-` would make it an option — see kinds/config.mjs.
      const container = operand(o.container, 'container');
      if (!container.ok) return { ok: false, error: `docker config: ${container.error}` };
      return { ok: true, config: { container: container.value } };
    },

    // PURE. No I/O and no spawning — the core spawns what this returns, which is
    // what makes the whole argv assertable with no docker present.
    spawnPlan(config, req) {
      const container = String(config?.container ?? '');
      const command = req.shell !== null
        // ABSOLUTE, not `bash`. Under `env -i` an unqualified interpreter would
        // depend on the FRAME's PATH, and `/bin/bash` is exactly what our
        // baseline probe requires (`[ -x /bin/bash ]`, src/baseline.mjs).
        ? ['/bin/bash', '-lc', req.shell]
        : [String(req.argv?.[0]), ...(req.argv ?? []).slice(1)];

      const args = ['exec'];
      // §5's stdin row: 'pipe' hands the container process our stdin (this is
      // how writeFile's base64 payload arrives, and EOF propagates); 'ignore'
      // gives it an immediately-closed stdin.
      if (req.stdinMode === 'pipe') args.push('-i');
      // The frame's cwd rides in ARGV, never as the host child's cwd. `/` is
      // passed straight through — every cc derivation carries it as a
      // placeholder, so fencing it would refuse them all (§7).
      args.push('-w', req.cwd);

      if (req.env === null) {
        // INHERIT: the container keeps its own PATH/HOME/toolchain, which is
        // what §7 promises for every `exec` cc issues, and what every fileops
        // script and the baseline probe need. Only our two plumbing variables
        // are overlaid.
        if (req.remoteId !== null) args.push('-e', `CC_REMOTE=${req.remoteId}`);
        args.push('-e', `${TOKEN_VAR}=${req.token}`);
        args.push('--', container, ...command);
      } else {
        // REPLACE, exactly as posix_spawn does (§5's `env` row). `env -i` is the
        // mechanism: it clears the container's own environment, which an
        // overlay of `-e` flags cannot do. NO `-e` flags here — `env -i` would
        // wipe them.
        //
        // THE `--` AFTER `-i` IS LOAD-BEARING, and its absence is an option
        // injection. Frame-supplied env KEYS are arbitrary, and GNU `env` parses
        // leading-`-` operands as ITS OWN options before the first non-option
        // operand. Measured inside node:24-slim (coreutils 9.1) with `-w /`:
        //   env -i    '--chdir=/tmp' PATH=/usr/bin pwd  → /tmp   (cwd hijacked)
        //   env -i -- '--chdir=/tmp' PATH=/usr/bin pwd  → /      (the -w holds)
        // and on coreutils 9.7 `--argv0=EVIL` spoofs $0, while 9.1 refuses the
        // whole exec with `env: unrecognized option`. One literal closes the
        // class; validating keys would not, because the option set is GNU's.
        const composed = { ...execEnv(req.env, req.remoteId, {}), [TOKEN_VAR]: req.token };
        args.push('--', container, 'env', '-i', '--',
          ...Object.entries(composed).map(([k, v]) => `${k}=${v}`),
          ...command);
      }

      return {
        file: argv0[0],
        args: [...argv0.slice(1), ...args],
        // `cwd` UNSET: the frame's cwd is `-w` above, not the host client's
        // working directory (see SpawnPlan's typedef).
        env: undefined,
        // NOT detached. session.#terminate reads `detached` as "a group kill
        // reached the far side"; for docker it did not — the container-side
        // process is not our OS descendant at all — so claiming it would make
        // every terminated exec falsely omit `descendantsMaySurvive`.
        detached: false,
      };
    },

    // TIER 1 of the two-tier baseline probe: a daemon query, never a round trip
    // INTO the target, because this runs on every card render.
    async reachability(config) {
      const container = String(config?.container ?? '');
      const res = await runDocker(
        argv0, ['inspect', '--type', 'container', '--format', INSPECT_FORMAT, '--', container],
        { timeoutMs: INSPECT_TIMEOUT_MS });

      // `fingerprint` MUST be null on every non-running answer: baseline.mjs's
      // needsProbe treats a falsy fingerprint as "probe again", so a
      // non-null one here would cache a stale verdict against a container we
      // could not reach.
      const no = (detail) => ({ connected: false, detail, fingerprint: null });

      if (res.error || res.code === null) {
        return no(`could not run '${argv0.join(' ')}': ${res.error?.message ?? 'no exit status'}`
          + ` (override the docker invocation with ${DOCKER_ENV})`);
      }
      if (res.code !== 0) {
        return no(`docker could not inspect container '${container}': `
          + `${first(res.stderr) || `exit ${res.code}`} (${DOCKER_ENV} sets the docker invocation)`);
      }
      const [running, image, startedAt] = res.stdout.trim().split(/\s+/);
      if (!image || !startedAt) {
        // Exit 0 with an answer we cannot read. Saying "stopped" here would name
        // a cause we did not measure.
        return no(`docker inspect answered for '${container}' in a shape this provider`
          + ` cannot read: ${JSON.stringify(res.stdout.trim().slice(0, 120))}`);
      }
      if (running !== 'true') {
        return no(`container '${container}' exists but is not running —`
          + ' this provider is ATTACH-ONLY: code-system never starts a container');
      }
      return {
        connected: true,
        detail: `container '${container}' running (${image}) since ${startedAt}`,
        fingerprint: `docker:${image}:${startedAt}`,
      };
    },

    // THE OPERATOR GATE'S PER-KIND SIDE EFFECT — and for docker there is
    // nothing to do. Every `docker exec` is a fresh client, so no channel
    // exists to open or close; the gate itself is a store field the backend
    // writes, and moving it is the whole of what Connect does here.
    //
    // NOT A STUB, and not an omission. A `docker start`/`stop` here is named as
    // possible LATER work and would break attach-only outright — it cannot even
    // be written, because every docker invocation goes through `runDocker` and
    // `assertAttachOnly` refuses any subcommand outside ALLOWED_SUBCOMMANDS.
    // tests/kindmeta.test.mjs asserts ZERO docker invocations for both, which
    // fails for an added `inspect` as well as for a `start`.
    async connect() { return {}; },
    async disconnect() {},

    // PROTOCOL MUST 3. A `docker exec` child is not the host client's OS
    // descendant: SIGKILLing the client leaves the container process running
    // (measured; the negative control in tests/docker-live.test.mjs pins it).
    // So the kill has to be relayed INTO the container.
    async reap(config, handle) {
      const container = String(config?.container ?? '');
      if (!container || !handle?.token) return;
      const res = await runDocker(
        argv0, ['exec', '--', container, '/bin/sh', '-c', buildReapScript(handle.token)],
        { timeoutMs: REAP_TIMEOUT_MS });

      // A REAP THAT COULD NOT RUN MUST NOT READ AS A REAP THAT FOUND NOTHING.
      // From here the two are identical — no kills, exit 0 — and the difference
      // is a leaked container-side subtree versus a clean shutdown. So this
      // throws, and session.#reap REPORTS it. It still does not take the
      // connection down: a failed reap is not a failed session.
      if (res.code === 0 && res.stdout.startsWith(`${REAP_TAG} ok `)) return;

      // THE ONE BENIGN FAILURE: the container is gone or stopped, so its
      // processes went with it and there is nothing left to reap. Recognised
      // through the same classifier the exec path uses, so the two cannot drift.
      const verdict = this.classifyFailure(config, {
        code: res.code ?? 1, stdout: res.stdout, stderr: res.stderr,
      });
      if (verdict?.code === 'ENOREMOTE') return;

      const why = res.stdout.startsWith(`${REAP_TAG} blind`)
        ? 'the target could not read any /proc/<pid>/environ (no `tr`, or no readable /proc)'
        : first(res.error?.message || res.stdout || res.stderr) || `exit ${res.code}`;
      throw new Error(
        `reap could not be proved to have run in container '${container}': ${why}`
        + ' — a container-side process may have survived');
    },

    // THE TRANSPORT'S OWN ERROR VOCABULARY, read once. A stopped or missing
    // container cannot be caught by remotes.mjs — the store record exists, so
    // the lookup succeeds and the failure only appears as a non-zero exit of the
    // docker CLI. Only the kind knows what those exits mean.
    //
    // EVERY ROW IS GUARDED SO A COMMAND CANNOT FORGE A VERDICT. Misclassifying
    // is silent in production and expensive both ways: reading a
    // socket-permission failure as ENOREMOTE sends a user to recreate a
    // container that is fine, and reading a command's own non-zero exit as a
    // protocol error turns every failing `git` into a dead remote.
    classifyFailure(config, { code, stdout = '', stderr = '' }) {
      const container = String(config?.container ?? '');

      // Rows that arrive on STDERR with exit 1, and with docker's stdout
      // untouched. A command would have to exit 1, print NOTHING at all, and
      // open its stderr with docker's exact wording to reach these.
      if (code === 1 && stdout === '') {
        if (stderr.startsWith(DAEMON_PREFIX)) {
          // docker's own text names the 64-hex container id, not the name the
          // remote was configured with, so the message says both.
          if (stderr.includes('No such container')) {
            return {
              code: 'ENOREMOTE',
              message: `container '${container}' does not exist on this docker daemon`,
              stderr: first(stderr),
            };
          }
          if (stderr.includes('is not running')) {
            return {
              code: 'ENOREMOTE',
              message: `container '${container}' exists but is not running —`
                + ' this provider is ATTACH-ONLY: code-system never starts a container',
              stderr: first(stderr),
            };
          }
        }
        // OUR ACCESS FAILING IS NOT THE REMOTE BEING ABSENT, so never ENOREMOTE:
        // that would send the user to recreate a container that is fine.
        if (stderr.startsWith('permission denied while trying to connect')
          || stderr.startsWith('Cannot connect to the Docker daemon')) {
          return {
            code: 'EUNKNOWN',
            message: `the docker daemon is not reachable as '${argv0.join(' ')}'`
              + ` — set ${DOCKER_ENV} to a working docker invocation (e.g. ["sudo","-n","docker"])`,
            stderr: first(stderr),
          };
        }
      }

      // §5's "a command that never started is an `error` frame, not an `exit`
      // frame". Three measured shapes, all on STDOUT, all opening with
      // OCI_PREFIX:
      //   exit 127  exec: "<argv0>": executable file not found in $PATH
      //   exit 127  chdir to cwd ("<cwd>") set in config.json failed: …
      //   exit 128  Cwd must be an absolute path        (a non-absolute `-w`)
      //
      // THIS ROW HAS NO DAEMON-SIDE COUNTERWEIGHT — `Error response from daemon`
      // is not in play — so it is guarded on three things: an exit code from the
      // measured pair, an EMPTY stderr, and OCI_PREFIX as the very first bytes
      // of stdout.
      //
      // BE PRECISE ABOUT WHAT THE STDERR GUARD MEANS. It is NOT "docker writes
      // nothing there": on this path `stdout` would be the COMMAND's own output
      // had a command run at all. It is that forging this row requires a command
      // which exits exactly 127 or 128, opens its stdout with the 38 bytes of
      // OCI_PREFIX, and writes not one byte to stderr. That is a
      // bound on plausibility, not a proof — and the outcome of forging it is a
      // named refusal, never a wrong answer.
      if ((code === 127 || code === 128) && stderr === '' && stdout.startsWith(OCI_PREFIX)) {
        return { code: 'ENOENT', message: first(stdout), stderr: '' };
      }

      // The common case by far: the failure is the command's own.
      return null;
    },
  };
}
