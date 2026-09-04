// The `ssh` kind: `exec` over a multiplexed `ssh` slave, reachability over the
// ControlPath socket, and the MUST-3 kill relay a remote command needs because
// it lives on the far host and does NOT die when this provider does.
//
// It builds argv and nothing else. Frames, ids, chunking, error codes, timeouts
// and file semantics belong to session.mjs and fileops.mjs, once, for every
// kind — and `readFile`/`writeFile` are inherited from fileops.mjs, so there is
// no ssh-specific file-transfer code here and never should be.
//
// CONNECT STATE LIVES IN THE CONTROLPATH SOCKET, not in a process and not in
// memory. That is what lets the launcher and the backend agree with no IPC —
// the same argument src/store.mjs makes for config ("there is no cache"),
// applied to connection state. An `ssh -O exit` issued outside this plugin is
// therefore reflected immediately, with nothing restarted.
//
// THE ONE THING SSH DOES NOT SHARE WITH DOCKER: `docker exec` takes an ARGV,
// while `ssh` takes a SHELL STRING — everything after the destination is joined
// with spaces and re-parsed by the remote user's login shell. Measured: passing
// `/bin/sh -c 'pwd; echo $CC_REMOTE'` as separate argv elements ran
// `/bin/sh -c pwd` and then evaluated `echo $CC_REMOTE` in the LOGIN shell,
// where it was unset. So the whole remote command is quoted once with
// fileops.mjs's `shellQuote` and handed over as a SINGLE argv element.
// See .wiki/gotchas/ssh-controlmaster-transport.md for every measurement.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asObject, execEnv, operand } from './config.mjs';
import { shellQuote } from '../fileops.mjs';
// The kill relay's far-side script is SHARED with `docker`: identical
// mechanism, identical reason (a far-side child is not this process's OS
// descendant).
import { REAP_TAG, TOKEN_VAR, buildReapScript } from './reapscript.mjs';

// THE OPERATOR SEAM for a host where the ssh invocation needs to differ (a
// pinned config file, a wrapper). A WHOLE ARGV, JSON — not a path — because the
// thing that varies is the invocation, not the binary.
//
// The rationale for an env var rather than a store field or a launch flag is
// docker's, unchanged, and single-homed at docs/architecture.md → "Why the
// docker CLI is an env var rather than a store field or a launch flag".
export const SSH_ENV = 'CODE_SYSTEM_SSH';

// THE SHIPPED DEFAULT IS BARE `ssh`: the operator's own ~/.ssh/config and
// agent. That is what makes a remote's `host` a Host ALIAS — every identity,
// jump host, port and key lives in the operator's config, and none of it in an
// HTTP-writable store field.
const DEFAULT_CLI = ['ssh'];

/**
 * @returns {string[]} the whole ssh invocation, e.g. ['ssh'] or ['ssh','-F','/path/config']
 * @throws on a malformed override — DELIBERATELY. In the launcher this surfaces
 *   through main.mjs's resolveTransport as exit 2 before any frame with our
 *   stderr quoted. Falling back to bare `ssh` would instead make a typo look
 *   like a working default and fail every operation with an auth error that
 *   names nothing.
 */
export function sshCliArgv(env = process.env) {
  const raw = typeof env[SSH_ENV] === 'string' ? env[SSH_ENV].trim() : '';
  if (raw === '') return [...DEFAULT_CLI];
  const bad = (why) => new Error(
    `${SSH_ENV} ${why}. It must be a JSON array of non-empty strings — the WHOLE ssh`
    + ` invocation, e.g. ${SSH_ENV}='["ssh","-F","/path/to/ssh_config"]'. Got ${JSON.stringify(raw)}`);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw bad('is not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw bad('is not a non-empty JSON array');
  if (!parsed.every(v => typeof v === 'string' && v !== '')) throw bad('contains a non-string or empty entry');
  return parsed;
}

// Matched to docker's INSPECT_TIMEOUT_MS: `reachability` runs on every card
// render, and an operator's override could block.
const CHECK_TIMEOUT_MS = 5_000;
// Bounded by ConnectTimeout below plus the authentication round trip; `-f`
// returns as soon as authentication succeeds, so there is no polling loop.
const CONNECT_TIMEOUT_MS = 15_000;
// Inside session.mjs's REAP_DEADLINE_MS (1500), itself inside cc's
// DEFAULT_SHUTDOWN_GRACE_MS (2000).
const REAP_TIMEOUT_MS = 1_200;

// Seconds, for ssh's own ConnectTimeout. Half of criterion 10: nothing waits on
// TCP past this, so an unreachable host answers ENOREMOTE in seconds rather
// than hanging past cc's deadline.
const CONNECT_TIMEOUT_S = 5;

// A FINITE idle expiry, so a master orphaned by a crashed launcher reaps
// itself. `yes` or `0` would persist for ever.
const CONTROL_PERSIST = '600';

// Linux `sun_path` is 108 bytes including the NUL, so 107 are usable. We refuse
// well inside it: a truncated socket path is a DIFFERENT socket for the
// launcher than for the backend, which is the one thing the no-IPC design
// cannot tolerate.
export const CONTROL_PATH_MAX = 100;

// ABSOLUTE, both of them. One layer of resolution is unavoidable and is stated
// rather than hidden — ssh hands our single string to the remote user's LOGIN
// shell, which tokenizes it — but everything after that point depends on
// neither side's PATH. `/bin/bash` is also exactly what our baseline probe
// requires (`[ -x /bin/bash ]`, src/baseline.mjs), so two kinds cannot answer
// the same probe with different interpreters.
const SHELL_INTERPRETER = '/bin/bash';
const ENV_BIN = '/usr/bin/env';
// The reap relay's own shell. `/bin/sh` (not the login shell) for the reason
// fileops uses it: no profile output ahead of the script's first line.
const REAP_SHELL = '/bin/sh';

/**
 * The per-uid directory the ControlPath sockets live in. NOT a bare /tmp entry —
 * see `ensureControlDir` for what the directory's ownership and mode buy.
 */
export function controlDir() {
  return path.join(os.tmpdir(), `code-system-ssh-${process.getuid()}`);
}

/** The 20-hex identity of a connection target, and the whole of what keys it. */
function identityHash(config) {
  const user = String(config?.user ?? '');
  const host = String(config?.host ?? '');
  // A NUL separator, because it is the one byte no username or hostname can
  // contain: with a joinable separator, ('ab','c') and ('a','bc') would collide
  // onto one master.
  return createHash('sha256').update(`${user}\0${host}`).digest('hex').slice(0, 20);
}

/**
 * THE ONE SOURCE OF TRUTH for where a remote's master socket lives, so the
 * launcher and the backend compute the same path from the same config with no
 * message between them.
 *
 * KEYED ON THE RESOLVED CONNECTION IDENTITY (user, host), NOT ON `remoteId`.
 * Two remoteIds naming the same target share one master, which is what "one
 * ControlMaster per remote" means once the remote is understood as the target
 * rather than the record. More importantly, editing a remote's `host` yields a
 * DIFFERENT socket, so a live master is never silently reused against a host it
 * was not opened to; the old one expires on ControlPersist.
 *
 * @throws when TMPDIR pushes the result past the socket ceiling. NEVER a silent
 *   fallback to a second formula — that would hand the launcher and the backend
 *   two different paths and break the no-IPC agreement invisibly.
 */
export function controlPathFor(config) {
  const p = path.join(controlDir(), identityHash(config));
  if (Buffer.byteLength(p) > CONTROL_PATH_MAX) {
    throw new Error(
      `the ssh ControlPath '${p}' is ${Buffer.byteLength(p)} bytes, past this provider's`
      + ` ${CONTROL_PATH_MAX}-byte limit (Linux caps a unix socket path at 107) — set TMPDIR to a`
      + ' shorter directory for the process running this plugin');
  }
  return p;
}

/**
 * Create the control directory, refusing one we cannot trust. Called ONLY from
 * `connect` — the one operation that binds a socket. Never from the factory and
 * never from `spawnPlan`: the handshake must be a pure function of the launch
 * argv (.wiki/gotchas/active-registration.md) and `spawnPlan` must be pure
 * (kinds/index.mjs), and MEASUREMENT is what makes that affordable —
 * `ControlMaster=no` uses an existing master, never binds one, and runs fine
 * with no directory at all.
 *
 * An existing directory with the wrong owner or mode is REFUSED, not repaired:
 * on a world-writable /tmp that shape is suspicious, and chmod-ing it would
 * paper over exactly the hijack the mode is there to prevent.
 */
export async function ensureControlDir() {
  const dir = controlDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.stat(dir);
  if (st.uid !== process.getuid()) {
    throw new Error(`the ssh control directory '${dir}' is owned by uid ${st.uid}, not by this`
      + ` process (uid ${process.getuid()}) — refusing to put a control socket in it`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`the ssh control directory '${dir}' has mode`
      + ` 0${(st.mode & 0o7777).toString(8)}, which is group- or world-accessible — ssh_config(5)`
      + ' requires otherwise, and another local user could pre-create a socket there and attach'
      + ' this provider\'s commands to their own master. Remove it or fix its mode (0700).');
  }
  return dir;
}

/**
 * The option block EVERY invocation shares, so no call site can drift from
 * another. `master` is the only thing that varies.
 *
 * Three of these are easy to get wrong, so each says what it prevents. The
 * measurements are all in .wiki/gotchas/ssh-controlmaster-transport.md §6-§8;
 * the user-facing policy is docs/features.md.
 *
 * NO `-M` ANYWHERE: appended after `-o ControlMaster=yes` it yields an
 * EFFECTIVE `ask`, which `BatchMode=yes` cannot answer. One mechanism only,
 * from one builder.
 *
 * NO `StrictHostKeyChecking` AND NO `UserKnownHostsFile`: that is THE POLICY,
 * not an omission. OpenSSH's default `ask` plus the `BatchMode=yes` set here
 * makes an unknown or changed host key FAIL rather than prompt or
 * trust-on-first-use; repairing it is the operator's own out-of-band action.
 *
 * `-T` IS LOAD-BEARING: we honour the operator's ssh config, so a `RequestTTY
 * force` in it would give us a pty, and a pty's CR translation corrupts
 * fileops' `CCSTAT` header parse (src/launcher/fileops.mjs).
 *
 * NO CONFIG VALUE EVER BECOMES AN `-o`. Every value here is a provider-owned
 * constant or the provider-computed ControlPath.
 *
 * @param {'no'|'yes'} master
 */
export function sshBaseArgs(controlPath, { master }) {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
    '-o', `ControlPath=${controlPath}`,
    '-o', `ControlMaster=${master}`,
    '-o', `ControlPersist=${CONTROL_PERSIST}`,
  ];
}

const first = (s) => String(s ?? '').split('\n')[0].trim();
// The WHOLE diagnostic, for the `stderr` a transport row reports to cc. ssh's
// host-key refusal spans TWO lines and writes them with CRLF (measured), and the
// first line alone is the less useful half — so these rows report all of it,
// normalised. The streams reaching classifyFailure are already capped at 512
// bytes by session.mjs and run.mjs, so there is no bound to add here.
const allOf = (s) => String(s ?? '').replace(/\r/g, '').trim();

function destFor(config) {
  const host = String(config?.host ?? '');
  const user = String(config?.user ?? '');
  return user ? `${user}@${host}` : host;
}

/**
 * The single funnel for every ssh invocation this module makes. Bounded, and
 * never rejects for a non-zero exit: the caller reads `code`/`stderr`.
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, error:Error|null}>}
 */
function runSsh(cli, args, { timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      // detached so the timeout can kill the whole group: an operator's wrapper
      // invocation may put ssh a generation below us.
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

// ssh's own wordings, MEASURED against OpenSSH_10.0p2. Every one of these is
// exit 255, which is why the text is what classifies and the code never can:
// a missing control socket, an unreachable host, a bad hostname and a remote
// command that itself exits 255 are all exit 255.
const NO_CONTROL_SOCKET = 'Control socket connect(';
const CONNECT_FAILED = 'ssh: connect to host ';
const NO_RESOLVE = 'ssh: Could not resolve hostname ';
const BAD_HOSTNAME = 'hostname contains invalid characters';
// NEITHER OF THESE TWO OPENS THE STREAM (measured), which is what makes them
// the awkward pair. ssh prefixes the auth refusal with `<dest>: ` on its own
// line, and prefixes the host-key refusal with a whole extra LINE when the
// operator's config requests strict checking explicitly.
//
// So they are matched PER LINE, and only within ssh's own opening — see
// `sshOwnLine`. An unanchored `includes` was the only thing that accepted both
// measured shapes, and it also accepted a NESTED ssh inside a caller's own
// command: a submodule fetch or a jump host printing these exact bytes to its
// own stderr, exiting non-zero with an empty stdout. Reporting that as OUR
// transport failing swallows the command's own exit status and sends the
// operator to fix their `~/.ssh/config` for somebody else's failure.
const AUTH_DENIED = /^(\S+: )?Permission denied \(publickey/;
const HOSTKEY_FAILED = /^Host key verification failed/;

// The ONE multi-line preamble measured for the pair above. Deliberately not a
// general "lines ssh might write" list: every entry here is a line a command's
// own output is allowed to have in front of a match, so an unmeasured one is a
// hole rather than robustness.
const SSH_PREAMBLE = /^No \S+ host key is known for .* strict checking\.$/;

/**
 * The matched line, iff it is one of ssh's OWN opening lines — i.e. every line
 * before it is itself a line ssh wrote. Null once a command's own output has
 * got there first.
 *
 * This is the ANCHOR-THEN-REFINE shape `docker.mjs` uses (`startsWith` on the
 * stream wrapping an `includes`), generalised over that one preamble. When OUR
 * authentication or host-key check fails the remote command NEVER RAN, so ssh's
 * diagnostic opens stderr; a command that ran has its own output in front of it.
 * That position is the only available discriminator — the bytes themselves are
 * identical whichever ssh emitted them.
 *
 * @returns {string|null} the matched line, normalised (no CR)
 */
function sshOwnLine(stderr, pattern) {
  for (const line of allOf(stderr).split('\n')) {
    if (pattern.test(line)) return line;
    if (!SSH_PREAMBLE.test(line)) return null;
  }
  return null;
}
// GNU `env` refusing to start the command, on stderr with an empty stdout.
// TWO exit codes, measured separately: 127 for a missing binary, 125 for a
// `--chdir` that does not exist. A classifier anchored on 127 alone reports a
// bad cwd as a command that ran and exited 125.
const ENV_PREFIX = 'env: ';
const ENV_NEVER_STARTED_CODES = [127, 125];

export function createSshTransport({ cli } = {}) {
  // No I/O here, deliberately: the factory runs on the handshake path and, in
  // the backend, once per remote per card render (src/api.mjs).
  const argv0 = cli ?? sshCliArgv();

  return {
    kind: 'ssh',

    // FINAL, not "until this card". Advertising `true` obliges SIGNAL FIDELITY
    // (§5: "delivers exactly that signal"), i.e. a whole `Transport.signal`
    // seam relaying into the far host — for a capability whose only consumer at
    // the pin is one call site meaning "kill the command". `false` costs
    // nothing: the core sets `descendantsMaySurvive: true` on every exit it
    // terminated and `reap` SIGKILLs the far-side subtree anyway. The argument
    // is docker's, and lives once at kinds/docker.mjs → processGroupSignal.
    processGroupSignal: false,

    // ALWAYS TRUE, never derived from store contents: cc memoises the handshake
    // per connection generation, so a capability that flapped as remotes were
    // added would be memoised wrong. One row serves every host.
    remotes: true,

    remoteDescriptors: false,

    validateConfig(raw) {
      const o = asObject(raw);
      // Both become ARGV OPERANDS (`ssh <user>@<host>`), so a leading `-` would
      // make either an option — see kinds/config.mjs.
      const host = operand(o.host, 'host');
      if (!host.ok) return { ok: false, error: `ssh config: ${host.error}` };
      const user = operand(o.user, 'user', { required: false });
      if (!user.ok) return { ok: false, error: `ssh config: ${user.error}` };
      return { ok: true, config: { host: host.value, ...(user.value ? { user: user.value } : {}) } };
    },

    // PURE. No I/O and no spawning — the core spawns what this returns, which
    // is what makes the whole argv assertable with no ssh present.
    //
    // `master: 'no'` ON EVERY OPERATION, AND THAT IS WHAT KEEPS THIS PURE.
    // `no` means "use a master if one exists, never create one" — so this path
    // multiplexes when it can, connects normally when it cannot, and needs no
    // control directory. `auto` would have to BIND one, and nothing here may
    // create it, because this function is pure. Measurements, with controls, in
    // .wiki/gotchas/ssh-controlmaster-transport.md §4-§5.
    spawnPlan(config, req) {
      const dest = destFor(config);
      const controlPath = controlPathFor(config);

      const command = req.shell !== null
        ? [SHELL_INTERPRETER, '-lc', req.shell]
        : [String(req.argv?.[0]), ...(req.argv ?? []).slice(1)];

      // THE INHERIT BRANCH MUST NOT CALL `execEnv`, and this is a trap rather
      // than a style choice. Its signature is
      // `execEnv(frameEnv, remoteId, base = process.env)` (kinds/config.mjs).
      // This kind is always `remotes:true`, so `remoteId` is always set, so
      // `execEnv(null, id)` returns `{...process.env, CC_REMOTE}` — it would
      // ship THE LAUNCHER's whole environment across the wire, destroying §7's
      // promise that an absent `env` means the far side's own PATH and
      // toolchain, and breaking every fileops script and the baseline probe.
      // `docker` avoids it the same way: by not calling it on that branch.
      const assignments = req.env === null
        ? [
            ...(req.remoteId !== null ? [`CC_REMOTE=${req.remoteId}`] : []),
            `${TOKEN_VAR}=${req.token}`,
          ]
        // REPLACE, exactly as posix_spawn does (§5's `env` row). `{}` as the
        // base so the launcher's environment cannot leak even if this branch
        // were ever reached with a null frameEnv. CC_REMOTE is overlaid AFTER
        // the replacement, so the provider's binding beats a frame-supplied one.
        : Object.entries({ ...execEnv(req.env, req.remoteId, {}), [TOKEN_VAR]: req.token })
          .map(([k, v]) => `${k}=${v}`);

      // TERMINATOR 2 — GNU `env`'s own option section. Frame-supplied env KEYS
      // are arbitrary strings and `env` reads leading-`-` operands as ITS OWN
      // options until the first non-option operand: measured for docker,
      // `env -i '--chdir=/tmp' PATH=/usr/bin pwd` runs at /tmp and
      // `--argv0=EVIL` spoofs `$0`. NEEDED IN BOTH ENV BRANCHES — on the
      // inherit branch the assignments are ours, but `command[0]` is the
      // FRAME's argv[0] and may start with `-`.
      //
      // `--chdir=` replaces docker's `-w`, which has no ssh equivalent. It also
      // means a bad cwd fails inside `env` with a wording we classify, rather
      // than needing a hand-rolled `cd || refuse` preamble.
      const remote = [
        ENV_BIN,
        `--chdir=${req.cwd}`,
        ...(req.env === null ? [] : ['-i']),
        '--',
        ...assignments,
        ...command,
      ].map(shellQuote).join(' ');

      return {
        file: argv0[0],
        args: [
          ...argv0.slice(1),
          ...sshBaseArgs(controlPath, { master: 'no' }),
          // TERMINATOR 1 — ssh's option section. Measured: WITH it, a
          // leading-dash host is refused by ssh itself (`hostname contains
          // invalid characters`); WITHOUT it, `-badhost true` makes ssh read
          // `-b` as an option, swallow `adhost`, and take the COMMAND as the
          // hostname (`ssh: Could not resolve hostname true`). Both exit 255,
          // which is why the pinning test asserts THIS argv and not stderr.
          '--',
          dest,
          // ONE element: ssh joins everything after the destination with spaces
          // and the remote login shell re-parses it, so a command split across
          // elements loses its quoting (measured).
          remote,
        ],
        // `cwd` UNSET: the frame's cwd rides in the remote command, not as the
        // host client's working directory (see SpawnPlan's typedef).
        env: undefined,
        // NOT detached. session.#terminate reads `detached` as "a group kill
        // reached the far side"; for ssh it did not — the remote command is not
        // our OS descendant at all — so claiming it would make every terminated
        // exec falsely omit `descendantsMaySurvive`.
        detached: false,
      };
      // `stdinMode` needs nothing here: session.mjs passes it straight to
      // spawn's stdio[0], so 'ignore' already gives ssh a closed stdin (it
      // cannot eat the launcher's frame stream) and 'pipe' is how writeFile's
      // base64 payload arrives and how EOF propagates. No `-n` and no `-i`.
    },

    // TIER 1 of the two-tier baseline probe: it reads a HOST-SIDE artifact —
    // the ControlPath socket — and never makes a round trip INTO the target,
    // because this runs on every card render.
    //
    // IT NEVER CONNECTS. `-O check` asks the socket and nothing else, so a card
    // render cannot side-effect a connection into existence.
    async reachability(config) {
      const dest = destFor(config);
      // `fingerprint` MUST be null on every non-connected answer:
      // baseline.mjs's needsProbe treats a falsy fingerprint as "probe again",
      // so a non-null one here would cache a stale verdict against a host we
      // could not reach.
      const no = (detail) => ({ connected: false, detail, fingerprint: null });

      let controlPath;
      try { controlPath = controlPathFor(config); }
      catch (e) { return no(e instanceof Error ? e.message : String(e)); }

      const res = await runSsh(
        argv0, [...sshBaseArgs(controlPath, { master: 'no' }), '-O', 'check', '--', dest],
        { timeoutMs: CHECK_TIMEOUT_MS });

      if (res.error || res.code === null) {
        return no(`could not run '${argv0.join(' ')}': ${res.error?.message ?? 'no exit status'}`
          + ` (override the ssh invocation with ${SSH_ENV})`);
      }
      if (res.code !== 0) {
        // The ordinary "not connected" answer, and the measured wording for it
        // is `Control socket connect(<path>): No such file or directory`.
        return no(`no multiplexed connection to '${dest}': ${first(res.stderr) || `exit ${res.code}`}`
          + ` — the control socket is '${controlPath}' (${SSH_ENV} sets the ssh invocation)`);
      }

      // THE FINGERPRINT RECIPE IS THE ONE ALREADY LOCKED at
      // .wiki/gotchas/baseline-probe-two-tier.md: the config hash plus the
      // socket's inode and ctime. A new master means a new socket means a new
      // inode, which is exactly the property needsProbe needs — and it is NOT
      // parsed out of `Master running (pid=…)`, which would never move across a
      // reconnect that reused a pid.
      let st;
      try { st = await fs.stat(controlPath); }
      catch (e) {
        // `-O check` said yes and the socket is not there. Claiming connected
        // without a fingerprint would cache a verdict keyed on nothing.
        return no(`ssh reports a master for '${dest}' but its control socket '${controlPath}'`
          + ` cannot be read: ${e instanceof Error ? e.message : String(e)}`);
      }
      return {
        connected: true,
        detail: `multiplexed connection to '${dest}' is up`
          + ` (${first(res.stderr) || 'master running'}); control socket '${controlPath}'`,
        fingerprint: `ssh:${identityHash(config)}:${st.ino}:${Math.trunc(st.ctimeMs)}`,
      };
    },

    // THE DEDICATED MASTER. `-N` (no remote command) + `-f` (background only
    // AFTER authentication succeeds), so success is bounded by ConnectTimeout
    // with no polling loop — and then it PROVES itself with one `-O check`
    // rather than trusting exit 0.
    //
    // This is the one operation that binds a socket, so it is the one that
    // needs the control directory — and being async, it is allowed the I/O that
    // `spawnPlan` and the factory are not.
    async connect(config) {
      const dest = destFor(config);
      const controlPath = controlPathFor(config);
      await ensureControlDir();

      const res = await runSsh(
        argv0, [...sshBaseArgs(controlPath, { master: 'yes' }), '-N', '-f', '--', dest],
        { timeoutMs: CONNECT_TIMEOUT_MS });
      if (res.code !== 0) {
        throw new Error(`ssh could not open a master connection to '${dest}': `
          + `${first(res.stderr) || res.error?.message || `exit ${res.code}`}`);
      }
      const check = await runSsh(
        argv0, [...sshBaseArgs(controlPath, { master: 'no' }), '-O', 'check', '--', dest],
        { timeoutMs: CHECK_TIMEOUT_MS });
      if (check.code !== 0) {
        throw new Error(`ssh reported success opening a master to '${dest}' but the control socket`
          + ` '${controlPath}' does not answer: ${first(check.stderr) || `exit ${check.code}`}`);
      }
      return { controlPath, detail: first(check.stderr) };
    },

    // IDEMPOTENT: "already closed" IS the requested state, and the measured
    // wording for it is exit 255 with `Control socket connect(…): No such file
    // or directory`. The fixture's own teardown depends on that.
    //
    // No `ensureControlDir` here: closing a socket needs no directory created,
    // and creating one in order to tear something down would be absurd.
    async disconnect(config) {
      const dest = destFor(config);
      const controlPath = controlPathFor(config);
      const res = await runSsh(
        argv0, [...sshBaseArgs(controlPath, { master: 'no' }), '-O', 'exit', '--', dest],
        { timeoutMs: CHECK_TIMEOUT_MS });
      if (res.code === 0) return;
      if (res.stderr.startsWith(NO_CONTROL_SOCKET)) return;
      throw new Error(`ssh could not disconnect the master for '${dest}' (control socket`
        + ` '${controlPath}'): ${first(res.stderr) || res.error?.message || `exit ${res.code}`}`);
    },

    // PROTOCOL MUST 3. A remote command is not the ssh client's OS descendant:
    // killing the local slave leaves the remote process running, so the kill
    // has to be relayed to the far side. Same token scan `docker` uses, from
    // the same module (kinds/reapscript.mjs).
    async reap(config, handle) {
      const dest = destFor(config);
      if (!dest || !handle?.token) return;
      let controlPath;
      try { controlPath = controlPathFor(config); }
      catch (e) { throw new Error(`reap could not address '${dest}': ${e instanceof Error ? e.message : e}`); }

      // The relay carries NO token in its own environment, so it cannot kill
      // itself — the token appears only inside the script it scans FOR.
      const remote = [REAP_SHELL, '-c', buildReapScript(handle.token)].map(shellQuote).join(' ');
      const res = await runSsh(
        argv0, [...sshBaseArgs(controlPath, { master: 'no' }), '--', dest, remote],
        { timeoutMs: REAP_TIMEOUT_MS });

      // A REAP THAT COULD NOT RUN MUST NOT READ AS A REAP THAT FOUND NOTHING.
      // From here the two are identical — no kills, exit 0 — and the difference
      // is a leaked far-side subtree versus a clean shutdown. So this throws,
      // and session.#reap REPORTS it without taking the connection down.
      if (res.code === 0 && res.stdout.startsWith(`${REAP_TAG} ok `)) return;

      // THE ONE BENIGN FAILURE: the host is not there, so its processes went
      // with it. Recognised through the SAME classifier the exec path uses, so
      // the two cannot drift — and crying wolf on every shutdown against a
      // down host would train the warning away.
      const verdict = this.classifyFailure(config, {
        code: res.code ?? 1, stdout: res.stdout, stderr: res.stderr,
      });
      if (verdict?.code === 'ENOREMOTE') return;

      const why = res.stdout.startsWith(`${REAP_TAG} blind`)
        ? 'the target could not read any /proc/<pid>/environ (no `tr`, or no readable /proc)'
        : first(res.error?.message || res.stdout || res.stderr) || `exit ${res.code}`;
      throw new Error(
        `reap could not be proved to have run on '${dest}': ${why}`
        + ' — a remote process may have survived');
    },

    // THE TRANSPORT'S OWN ERROR VOCABULARY, read once. An unreachable host
    // cannot be caught by remotes.mjs — the store record exists, so the lookup
    // succeeds and the failure appears only as a non-zero exit of ssh.
    //
    // EVERY ROW IS GUARDED ON AN EMPTY STDOUT PLUS ssh's OWN WORDING, ANCHORED,
    // because EXIT 255 ON ITS OWN CLASSIFIES NOTHING: ssh forwards a remote
    // command's exit status verbatim, so a command may itself exit 255
    // (measured). Two anchors are in use, and the difference is measured rather
    // than stylistic: the rows whose wording OPENS the stream are matched with
    // `startsWith` on the stream, which is the strictest available; the two that
    // do not open it (auth, host key) go through `sshOwnLine`, which anchors
    // per line and refuses once a command's own output has got in front. The
    // measurements and the exit-255 argument live once, in
    // .wiki/gotchas/ssh-controlmaster-transport.md.
    classifyFailure(config, { code, stdout = '', stderr = '' }) {
      const host = String(config?.host ?? '');
      const dest = destFor(config);

      if (code === 255 && stdout === '') {
        // THE HOST IS NOT THERE. All three measured, all opening stderr.
        if (stderr.startsWith(CONNECT_FAILED) || stderr.startsWith(NO_RESOLVE)) {
          return {
            code: 'ENOREMOTE',
            message: `ssh cannot reach host '${host}': ${first(stderr)}`,
            stderr: allOf(stderr),
          };
        }
        if (stderr.startsWith(BAD_HOSTNAME)) {
          return {
            code: 'ENOREMOTE',
            message: `ssh refused the configured host '${host}' as a hostname: ${first(stderr)}`,
            stderr: allOf(stderr),
          };
        }
        // OUR ACCESS FAILING IS NOT THE REMOTE BEING ABSENT, so never
        // ENOREMOTE: that would send a user to rebuild a host that is fine.
        const authLine = sshOwnLine(stderr, AUTH_DENIED);
        if (authLine) {
          return {
            code: 'EUNKNOWN',
            message: `ssh could not authenticate to '${dest}' — the host is reachable but this`
              + ' provider was refused. Fix it in the operator\'s own ~/.ssh/config or ssh agent'
              + ` (${SSH_ENV} sets the whole ssh invocation): ${authLine}`,
            stderr: allOf(stderr),
          };
        }
        // THE known_hosts POLICY, surfacing. We set no StrictHostKeyChecking
        // and no UserKnownHostsFile, so OpenSSH's default `ask` plus our
        // `BatchMode=yes` means an unknown or changed key FAILS here: this
        // provider never prompts and never trusts on first use. Adding the key
        // is the operator's out-of-band action.
        // Both measured shapes are accepted: `Host key verification failed.`
        // alone (the DEFAULT `ask`), and the same line preceded by
        // `No ED25519 host key is known for <ip> and you have requested strict
        // checking.` with both lines in CRLF (an explicit
        // `StrictHostKeyChecking yes`). The MATCHED line is what the message
        // quotes — stderr's first line is the less diagnostic half here.
        const hostkeyLine = sshOwnLine(stderr, HOSTKEY_FAILED);
        if (hostkeyLine) {
          return {
            code: 'EUNKNOWN',
            message: `ssh could not verify the host key for '${dest}'. This provider never prompts`
              + ' and never trusts a key on first use — add it to the operator\'s own known_hosts'
              + ` out of band (e.g. ssh-keyscan), then retry: ${hostkeyLine}`,
            stderr: allOf(stderr),
          };
        }
      }

      // §5's "a command that never started is an `error` frame, not an `exit`
      // frame". GNU `env` refusing to exec, on stderr with an empty stdout, at
      // one of TWO measured exit codes — 127 for a missing binary, 125 for a
      // `--chdir` that does not exist.
      if (ENV_NEVER_STARTED_CODES.includes(code) && stdout === '' && stderr.startsWith(ENV_PREFIX)) {
        return { code: 'ENOENT', message: first(stderr), stderr: allOf(stderr) };
      }

      // The common case by far: the failure is the command's own.
      return null;
    },
  };
}
