// THE PURE HALF of the ssh transport: argv construction, the ControlPath
// formula, the CLI seam, the failure classifier, reachability and the
// connect/disconnect/reap seams. Runs in plain `npm test` with NO SSH AND NO
// DOCKER ANYWHERE — `spawnPlan` is a pure function, and everything that would
// invoke ssh is driven through a stub `ssh` written to a temp dir.
//
// Every string quoted here as ssh's own output was MEASURED against
// OpenSSH_10.0p2 (see .wiki/gotchas/ssh-controlmaster-transport.md).
// Paraphrasing one would make the classifier pass a test and fail in
// production — every transport row is guarded on ssh's exact wording, because
// exit 255 on its own classifies nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROL_PATH_MAX, SSH_ENV, controlDir, controlPathFor, createSshTransport, sshBaseArgs,
  sshCliArgv,
} from '../src/launcher/kinds/ssh.mjs';

const CONFIG = { host: 'box', user: 'me' };
const DEST = 'me@box';

// A frame as session.mjs builds it. `env: null` is the INHERIT case — which is
// what cc sends on EVERY `exec` it issues, and what run.mjs sends for every
// fileops script and the baseline probe.
function req(over = {}) {
  return {
    argv: ['git', 'status'],
    shell: null,
    cwd: '/w',
    env: null,
    stdinMode: 'ignore',
    remoteId: 'r1',
    token: 'tok',
    ...over,
  };
}

const transport = (cli = ['ssh']) => createSshTransport({ cli });
const plan = (over = {}, config = CONFIG) => transport().spawnPlan(config, req(over));

// Is `needle` present as a CONTIGUOUS run of `hay`?
function runIndex(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((v, j) => hay[i + j] === v)) return i;
  }
  return -1;
}

// The single remote command string ssh is handed. Everything after the
// destination is ONE argv element, so this is `args.at(-1)`.
const remoteOf = (p) => p.args.at(-1);

// Point TMPDIR at a fresh directory for the duration of one test, so the
// ControlPath formula is exercised without depending on — or polluting — the
// real /tmp. `os.tmpdir()` reads TMPDIR on every call, which is what makes this
// work; it is restored however the test ends.
async function withTmpdir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-sshtmp-'));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(async () => {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

// ── U10: the ControlPath formula ─────────────────────────────────────

// PINS the property the whole no-IPC design rests on: the launcher and the
// backend compute the SAME path from the same config with no message between
// them, so connect state can live in the socket. Keyed on the resolved
// connection identity (user, host) rather than on remoteId, so editing a
// remote's host yields a DIFFERENT socket and a live master is never silently
// reused against a host it was not opened to.
//
// A mutant keying on remoteId, or salting with anything per-process, reds the
// stability half; a mutant ignoring `user` reds the third.
test('controlPathFor is a stable function of (user, host) and of nothing else', async (t) => {
  await withTmpdir(t);
  const a = controlPathFor({ host: 'box', user: 'me' });
  assert.equal(controlPathFor({ host: 'box', user: 'me' }), a, 'stable across calls');
  assert.notEqual(controlPathFor({ host: 'box2', user: 'me' }), a, 'a different host is a different socket');
  assert.notEqual(controlPathFor({ host: 'box', user: 'you' }), a, 'a different user is a different socket');
  assert.notEqual(controlPathFor({ host: 'box' }), a, 'no user at all is a different socket');
  // The separator must be a byte no hostname or username can contain, or
  // ('ab','c') and ('a','bc') would collide onto one master.
  assert.notEqual(controlPathFor({ user: 'ab', host: 'c' }), controlPathFor({ user: 'a', host: 'bc' }));
  // It lives under the per-uid control directory, not loose in a shared /tmp.
  assert.equal(path.dirname(a), controlDir());
  assert.match(path.basename(controlDir()), new RegExp(`code-system-ssh-${process.getuid()}$`));
});

// PINS the sun_path ceiling. Linux allows 107 usable bytes in a unix socket
// path (108 including the NUL) and TMPDIR is caller-controlled, so a long one
// silently truncates the socket name — and a truncated path is a DIFFERENT
// socket for the launcher than for the backend, which is the one thing this
// design cannot tolerate. It refuses instead, naming TMPDIR.
//
// A mutant that falls back to a second, shorter formula reds here: that would
// give the two processes two paths and break the no-IPC agreement silently.
test('controlPathFor REFUSES a path past the socket ceiling rather than truncating', async (t) => {
  const dir = await withTmpdir(t);
  // Comfortably inside the ceiling: the real formula is ~45 bytes.
  assert.ok(Buffer.byteLength(controlPathFor(CONFIG)) <= CONTROL_PATH_MAX);
  assert.ok(CONTROL_PATH_MAX < 108, 'the ceiling must sit under Linux sun_path (108 incl. NUL)');

  const deep = path.join(dir, 'x'.repeat(120));
  await fs.mkdir(deep, { recursive: true });
  process.env.TMPDIR = deep;
  assert.throws(() => controlPathFor(CONFIG), /TMPDIR/,
    'a path past the ceiling must refuse loudly and name the variable that caused it');
  assert.throws(() => controlPathFor(CONFIG), new RegExp(String(CONTROL_PATH_MAX)));
});

// ── U11: the CLI seam ────────────────────────────────────────────────

// PINS the same contract CODE_SYSTEM_DOCKER has: the shipped default is bare
// `ssh` — the operator's OWN ~/.ssh/config and agent, which is what makes a
// remote a Host alias — the override is a WHOLE ARGV rather than a path, and a
// malformed value refuses LOUDLY instead of silently falling back. A silent
// fallback would make a typo look like a working default and fail every
// operation with an auth error naming nothing.
test('the ssh invocation is overridable, and the shipped default is bare ssh', () => {
  assert.deepEqual(sshCliArgv({}), ['ssh']);
  assert.deepEqual(sshCliArgv({ [SSH_ENV]: '   ' }), ['ssh']);
  assert.deepEqual(sshCliArgv({ [SSH_ENV]: '["ssh","-F","/tmp/x/ssh_config"]' }), ['ssh', '-F', '/tmp/x/ssh_config']);

  for (const bad of ['ssh', '[]', '["a",1]', '["a",""]', '{', '{"a":1}', 'null']) {
    assert.throws(() => sshCliArgv({ [SSH_ENV]: bad }), /CODE_SYSTEM_SSH/,
      `${JSON.stringify(bad)} must refuse loudly, not fall back to bare ssh`);
  }

  // A multi-token override lands as `file` plus LEADING args, before our own
  // option block — so `-F <config>` is in force for every invocation.
  const p = createSshTransport({ cli: ['ssh', '-F', '/tmp/x/ssh_config'] }).spawnPlan(CONFIG, req());
  assert.equal(p.file, 'ssh');
  assert.deepEqual(p.args.slice(0, 2), ['-F', '/tmp/x/ssh_config']);
  assert.equal(p.args[2], '-T', "our own block follows the operator's leading args");
});

// ── U1/U2: the argv shape ────────────────────────────────────────────

// PINS the whole argv, deep-equal, for the INHERIT form. The option block, the
// terminator, the destination and the single command element are all fixed
// here, so any drift in any of them reds one assertion with a readable diff.
test('spawnPlan: the whole argv, with the remote command as ONE element', async (t) => {
  await withTmpdir(t);
  const cp = controlPathFor(CONFIG);
  const p = plan();
  assert.equal(p.file, 'ssh');
  assert.deepEqual(p.args, [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', `ControlPath=${cp}`,
    '-o', 'ControlMaster=no',
    '-o', 'ControlPersist=600',
    '--', DEST,
    "'/usr/bin/env' '--chdir=/w' '--' 'CC_REMOTE=r1' 'CC_EXEC_TOKEN=tok' 'git' 'status'",
  ]);
  assert.equal(p.cwd, undefined, "the frame's cwd rides in the remote command, never as the host child's cwd");
  assert.equal(p.env, undefined, 'the host-side ssh client gets no env of its own');
  assert.notEqual(p.detached, true);
});

// PINS the two structural facts a deep-equal alone would not survive a
// refactor of: `--` ends ssh's option section immediately before the
// destination, and the remote command is a SINGLE argv element.
//
// THE TERMINATOR IS THE FIX FOR A MEASURED HIJACK. With it, a leading-dash host
// is refused by ssh itself (`hostname contains invalid characters`, exit 255);
// WITHOUT it, `-badhost true` makes ssh read `-b` as an option, swallow
// `adhost`, and take the COMMAND as the hostname
// (`ssh: Could not resolve hostname true`). Both exit 255, which is exactly why
// this is asserted on the pure plan's argv and not on runtime stderr.
//
// The single-element rule is the other measured half: ssh JOINS everything
// after the destination with spaces and the remote login shell re-parses it, so
// a command split across argv elements loses its quoting. Measured — passing
// `/bin/sh -c 'pwd; echo $CC_REMOTE'` as separate elements ran `/bin/sh -c pwd`
// and then evaluated `echo $CC_REMOTE` in the LOGIN shell, where it was unset.
test('spawnPlan: `--` ends ssh\'s options right before the destination', async (t) => {
  await withTmpdir(t);
  for (const over of [{}, { env: { PATH: '/p' } }, { shell: 'x', argv: null }, { stdinMode: 'pipe' }]) {
    const p = plan(over);
    const i = p.args.indexOf('--');
    assert.equal(i, p.args.length - 3, `the terminator is third from the end: ${JSON.stringify(over)}`);
    assert.equal(p.args[i + 1], DEST);
    assert.equal(p.args.length - (i + 2), 1, 'exactly ONE element carries the whole remote command');
    // Every `-o` is an option, i.e. before the boundary.
    for (const [k, a] of p.args.entries()) {
      if (a === '-o') assert.ok(k < i, `an -o after the terminator would be read as a command`);
    }
  }
});

// PINS the option block itself, one option at a time, against the DEFAULTS this
// ssh actually has — measured with `ssh -G`: batchmode no, connecttimeout none,
// controlpersist no, requesttty auto, stricthostkeychecking ask. Every option
// here therefore changes something; a mutant dropping any one of them reds.
//
// `-T` IS LOAD-BEARING, NOT COSMETIC, and it is measured: we honour the
// operator's own ssh config, so a `RequestTTY force` in it gives us a pty, and a
// pty applies CR translation. Against the live fixture, `printf 'CCSTAT …\n'`
// came back `CCSTAT 81a4 12\r\n` without `-T` and `…\n` with it — the `\r`
// corrupts fileops' header parse. (`RequestTTY yes` alone does NOT reproduce it:
// ssh declines a pty when stdin is not a terminal, which ours never is.)
//
// NO StrictHostKeyChecking AND NO UserKnownHostsFile IS THE POLICY, not an
// omission — see the host-key test below, which measures what it produces.
test('sshBaseArgs: every option earns its place, and none is a config value', () => {
  const args = sshBaseArgs('/tmp/cs/sock', { master: 'no' });
  assert.deepEqual(args, [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ControlPath=/tmp/cs/sock',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPersist=600',
  ]);
  // ControlPersist must be FINITE, so a master orphaned by a crashed launcher
  // reaps itself. `yes` or `0` persist for ever.
  const persist = args[args.indexOf('-o', args.indexOf('-o') + 1)];
  assert.ok(args.includes('ControlPersist=600'));
  assert.equal(/^ControlPersist=(yes|0)$/.test(String(persist)), false);
  // THE POLICY, asserted as an absence: we set neither, deliberately.
  assert.equal(args.some(a => a.startsWith('StrictHostKeyChecking')), false);
  assert.equal(args.some(a => a.startsWith('UserKnownHostsFile')), false);
  // The master mode is the ONLY thing that varies between call sites.
  assert.ok(sshBaseArgs('/tmp/cs/sock', { master: 'yes' }).includes('ControlMaster=yes'));
  assert.ok(sshBaseArgs('/tmp/cs/sock', { master: 'no' }).includes('ControlMaster=no'));
});

// PINS criterion 3: NO config value ever becomes an `-o`. Every `-o` value is a
// provider-owned constant or the provider-computed ControlPath, so a stored
// remote cannot inject an ssh option even if `operand()` were bypassed.
test('spawnPlan: no `-o` value is ever derived from stored config', async (t) => {
  await withTmpdir(t);
  const cp = controlPathFor({ host: 'evil', user: 'nasty' });
  const p = plan({}, { host: 'evil', user: 'nasty' });
  const oValues = p.args.flatMap((a, i) => (a === '-o' ? [p.args[i + 1]] : []));
  assert.deepEqual(oValues, [
    'BatchMode=yes', 'ConnectTimeout=5', `ControlPath=${cp}`, 'ControlMaster=no', 'ControlPersist=600',
  ]);
  for (const v of oValues) {
    if (!v.startsWith('ControlPath=')) {
      assert.equal(/evil|nasty/.test(v), false, `${v} must not carry a config value`);
    }
  }
});

// ── U3: the SECOND terminator, GNU env's ─────────────────────────────

// PINS THE FIX FOR AN OPTION INJECTION, in the branch docker's own measurement
// found it in. Frame-supplied env KEYS are arbitrary strings and GNU `env` reads
// leading-`-` operands as ITS OWN options until the first non-option operand:
// `env -i '--chdir=/tmp' PATH=/usr/bin pwd` runs at /tmp (measured for docker,
// .wiki/gotchas/docker-exec-transport.md §4), and `--argv0=` spoofs `$0`.
//
// IT IS NEEDED IN BOTH ENV BRANCHES, not just REPLACE: in the INHERIT branch the
// assignments are ours, but `command[0]` is the FRAME's argv[0] and may start
// with `-`. A mutant emitting it only under `env -i` reds the inherit half.
test('spawnPlan: `env --` closes the option-injection window, in BOTH env branches', async (t) => {
  await withTmpdir(t);
  for (const over of [
    { env: null },
    { env: {} },
    { env: { '--chdir=/evil': '', PATH: '/p' } },
    { shell: 'x', argv: null },
    { argv: ['-evilcmd', 'x'] },
  ]) {
    const remote = remoteOf(plan(over));
    const tokens = remote.split(' ');
    const boundary = tokens.indexOf("'--'");
    assert.notEqual(boundary, -1, `expected a quoted -- after env's options: ${remote}`);
    assert.equal(tokens[0], "'/usr/bin/env'", remote);
    // Everything env must not read as an option sits AFTER the boundary.
    for (const [i, tk] of tokens.entries()) {
      if (i > 0 && i < boundary) {
        assert.match(tk, /^'(--chdir=|-i)/, `only our own env options may precede the boundary: ${tk}`);
      }
    }
    for (const needle of ["'--chdir=/evil='", "'-evilcmd'"]) {
      const at = tokens.indexOf(needle);
      if (at !== -1) assert.ok(at > boundary, `${needle} must sit after env's -- boundary`);
    }
  }
});

// ── U4/U5/U6: env ───────────────────────────────────────────────────

// PINS §5's `env` row — a supplied env REPLACES rather than overlays — and that
// the provider's binding beats a frame-supplied CC_REMOTE.
//
// THE FIXTURE MUST COLLIDE ON CC_REMOTE OR THIS PINS NOTHING: `{...frameEnv,
// CC_REMOTE}` and `{CC_REMOTE, ...frameEnv}` are byte-identical unless the
// frame's own env names one.
test('spawnPlan: a frame env REPLACES via `env -i`, with CC_REMOTE overlaid last', async (t) => {
  await withTmpdir(t);
  const remote = remoteOf(plan({ env: { PATH: '/p', CC_REMOTE: 'frame-supplied' } }));
  assert.equal(remote,
    "'/usr/bin/env' '--chdir=/w' '-i' '--' 'PATH=/p' 'CC_REMOTE=r1' 'CC_EXEC_TOKEN=tok' 'git' 'status'");
  assert.equal(remote.includes('frame-supplied'), false,
    'a frame-supplied CC_REMOTE must not survive — that is the routing lie CC_REMOTE exists to prevent');
});

// PINS §7's promise, and a trap that is invisible to an outcome-shaped test.
// `execEnv`'s signature is `(frameEnv, remoteId, base = process.env)`
// (kinds/config.mjs). This kind is ALWAYS `remotes:true`, so `remoteId` is
// always set, so `execEnv(null, id)` returns `{...process.env, CC_REMOTE}` — it
// would ship THE LAUNCHER's whole environment across the wire, destroying the
// promise that an absent `env` means the far side's own PATH and toolchain, and
// breaking every fileops script and the baseline probe.
//
// So the assertion is on a value that exists ONLY in this process's
// environment: if `execEnv` were called on the inherit branch with its default
// `base`, that value would appear in the plan. Nothing about the command's
// OUTCOME could show this.
test('spawnPlan: an absent frame env never ships the LAUNCHER\'s environment', async (t) => {
  await withTmpdir(t);
  const key = `CODE_SYSTEM_SSH_CANARY_${process.pid}`;
  const value = `canary-${Math.random().toString(36).slice(2)}`;
  process.env[key] = value;
  t.after(() => { delete process.env[key]; });

  const p = plan({ env: null });
  const whole = JSON.stringify(p);
  assert.equal(whole.includes(value), false,
    'the launcher\'s own environment must not cross the wire on the inherit branch');
  assert.equal(whole.includes(key), false);
  // And structurally: no `env -i`, so the far side keeps its own environment.
  const remote = remoteOf(p);
  assert.equal(remote.includes("'-i'"), false, 'no `env -i` on the inherit branch');
  assert.equal(remote,
    "'/usr/bin/env' '--chdir=/w' '--' 'CC_REMOTE=r1' 'CC_EXEC_TOKEN=tok' 'git' 'status'");
});

test('spawnPlan: an unrouted exec carries the token but no CC_REMOTE', async (t) => {
  await withTmpdir(t);
  const remote = remoteOf(plan({ remoteId: null }));
  assert.equal(remote.includes('CC_REMOTE'), false);
  assert.ok(remote.includes("'CC_EXEC_TOKEN=tok'"), 'reap still needs to find its own processes');
});

// ── U7/U8: the interpreter, the cwd, the operand guard ───────────────

// PINS criterion 7. ONE layer of resolution is unavoidable — ssh hands our
// single string to the remote user's LOGIN shell, which tokenizes it — and
// everything after that point is named absolutely, so neither side's PATH
// resolves anything. The recorded `host.mjs` defect is a bare `bash`; a mutant
// repeating it here reds.
test('spawnPlan: both interpreters are named ABSOLUTELY, in either env branch', async (t) => {
  await withTmpdir(t);
  for (const over of [{ shell: 'echo hi', argv: null }, { shell: 'echo hi', argv: null, env: { PATH: '/nowhere' } }]) {
    const remote = remoteOf(plan(over));
    assert.ok(remote.endsWith("'/bin/bash' '-lc' 'echo hi'"), remote);
    assert.ok(remote.startsWith("'/usr/bin/env' "), remote);
    // A bare name anywhere would depend on a PATH neither side controls.
    assert.equal(/(^|\s)'(env|bash|sh)'/.test(remote), false, `an unqualified interpreter in ${remote}`);
  }
  // And the argv form names no interpreter of its own beyond `env`.
  assert.ok(remoteOf(plan()).startsWith("'/usr/bin/env' "));
});

// PINS acceptance 5 (`cwd: '/'` is served verbatim — every cc derivation carries
// it as a placeholder with its real target in argv, so fencing it would refuse
// all seven), and the operand guard at the store's front door.
test('spawnPlan: cwd rides in `--chdir`, verbatim, and an option-shaped config is refused', async (t) => {
  await withTmpdir(t);
  assert.ok(remoteOf(plan({ cwd: '/' })).startsWith("'/usr/bin/env' '--chdir=/' '--' "));
  // A leading-dash cwd is a single quoted token, so `env` cannot read it as an
  // option; and it still precedes the boundary as OUR option, by construction.
  assert.ok(remoteOf(plan({ cwd: '-evil' })).includes("'--chdir=-evil'"));
  // A leading-dash argv[0] lands after env's terminator.
  const remote = remoteOf(plan({ argv: ['-evilcmd', 'x'] }));
  assert.ok(remote.endsWith("'-evilcmd' 'x'"));
  assert.ok(remote.indexOf("'--'") < remote.indexOf("'-evilcmd'"));
  // The store's front door refuses an option-shaped host or user outright.
  const tr = transport();
  assert.equal(tr.validateConfig({ host: '-oProxyCommand=x' }).ok, false);
  assert.equal(tr.validateConfig({ host: 'box', user: '-oProxyCommand=x' }).ok, false);
  assert.equal(tr.validateConfig({ host: 'box' }).ok, true);
  // A host with no user is a bare destination, not `@host`.
  assert.equal(plan({}, { host: 'box' }).args.at(-2), 'box');
});

// ── U9: the `exclusive` guards, both of them ─────────────────────────

// PINS that BOTH guards survive. The `[ -e "$p" ]` pre-check is a plain `test`
// that no shell can ignore, so it already prevents the routine truncating-write
// outcome; what `set -C` uniquely buys is the CHECK-THEN-ACT RACE — a file
// created between the pre-check and the redirect. Dropping either leaves the
// other looking sufficient, which is why both are asserted here.
//
// This is `fileops.mjs`'s shared code, inherited by this kind unchanged; the
// residual exposure (that race, on a target shell ignoring noclobber) is
// documented in docs/protocol.md → "What `exclusive` does and does not
// guarantee".
test('the inherited exclusive write keeps BOTH its pre-check and its `set -C`', async () => {
  const { buildWriteScript } = await import('../src/launcher/fileops.mjs');
  const script = buildWriteScript({ path: '/tmp/x', exclusive: true, nonce: 'abc123' });
  assert.match(script, /if \[ -e "\$p" \]/, 'the pre-check no shell can ignore');
  assert.match(script, /^set -C$/m, 'and the noclobber guard that closes the race');
  assert.ok(script.indexOf('set -C') < script.indexOf('base64 -d > "$p"'),
    'the guard must precede the redirect it protects');
  // Absent from the plain branch, or every plain write would refuse.
  assert.doesNotMatch(buildWriteScript({ path: '/tmp/x', nonce: 'abc123' }), /set -C/);
});

// ── U12: classifyFailure ─────────────────────────────────────────────

const classify = (res) => transport().classifyFailure(CONFIG, res);

// PINS the ENOREMOTE rows. All three were measured, and all three are exit 255
// with an EMPTY stdout and ssh's own wording opening stderr — because exit 255
// on its own means nothing at all (a missing control socket, an unreachable
// host, a bad hostname and a remote command that itself exits 255 are
// indistinguishable by code).
test('classifyFailure: a host that is not there is ENOREMOTE, naming the configured host', () => {
  const rows = [
    'ssh: connect to host 172.17.0.99 port 22: No route to host\n',
    'ssh: connect to host 127.0.0.1 port 1: Connection refused\n',
    'ssh: connect to host 172.17.0.99 port 22: Connection timed out\n',
    'ssh: Could not resolve hostname no-such-host-xyz.invalid: Name or service not known\n',
    'hostname contains invalid characters\n',
  ];
  for (const stderr of rows) {
    const v = classify({ code: 255, stdout: '', stderr });
    assert.equal(v?.code, 'ENOREMOTE', stderr);
    assert.match(v.message, /'box'/, 'the message names the CONFIGURED host');
    assert.equal(v.stderr, stderr.trim());
  }
});

// PINS docker's rule, applied here: OUR ACCESS FAILING IS NOT THE REMOTE BEING
// ABSENT. `ENOREMOTE` for an auth or host-key failure would send a user to
// rebuild a host that is perfectly fine.
//
// The host-key row is also THE POLICY, measured. We set no
// `StrictHostKeyChecking` and no `UserKnownHostsFile`, so OpenSSH's default
// (`ask`, measured with `ssh -G`) combines with the `BatchMode=yes` we DO set:
// an unknown or changed host key FAILS — it never prompts and never
// TOFU-accepts. Adding the key is the operator's out-of-band action, so the
// message says so.
test('classifyFailure: an auth or host-key failure is EUNKNOWN, never ENOREMOTE', () => {
  const denied = classify({
    code: 255, stdout: '',
    stderr: 'root@172.17.0.5: Permission denied (publickey).\n',
  });
  assert.equal(denied.code, 'EUNKNOWN', 'we cannot authenticate — the host is not absent');
  assert.notEqual(denied.code, 'ENOREMOTE');
  assert.match(denied.message, /ssh config|agent/i, 'and the message names where the fix lives');

  const hostkey = classify({ code: 255, stdout: '', stderr: 'Host key verification failed.\n' });
  assert.equal(hostkey.code, 'EUNKNOWN');
  assert.notEqual(hostkey.code, 'ENOREMOTE');
  assert.match(hostkey.message, /known_hosts/,
    'the fix is adding the key out of band, and the message must say where');
  assert.match(hostkey.message, /never prompts|BatchMode|no TOFU|never accept/i,
    'and that this provider fails rather than trusting on first use');
});

// PINS §5's "a command that never started is an `error` frame, not an `exit`
// frame", for the two measured shapes — and note the DIFFERENT exit codes,
// measured against the live fixture:
//   exit 127  env: 'nosuchbinary-xyz': No such file or directory
//   exit 125  env: cannot change directory to '/nope-xyz': No such file or directory
// Both on STDERR with an empty stdout. A classifier anchored on 127 alone
// reports a bad cwd as a command that ran and exited 125.
test('classifyFailure: a command that never started is ENOENT, on BOTH measured exit codes', () => {
  const noBinary = classify({
    code: 127, stdout: '', stderr: "env: 'nosuchbinary-xyz': No such file or directory\n",
  });
  assert.equal(noBinary.code, 'ENOENT');
  assert.match(noBinary.message, /nosuchbinary-xyz/);

  const badCwd = classify({
    code: 125, stdout: '', stderr: "env: cannot change directory to '/nope-xyz': No such file or directory\n",
  });
  assert.equal(badCwd.code, 'ENOENT');
  assert.match(badCwd.message, /cannot change directory/);
});

// PINS THE GUARDS. Without them a command's own output forges a transport
// verdict — and ssh forwards a remote command's exit status VERBATIM, so a
// command CAN exit 255 (measured). Forging a row therefore requires exiting
// exactly 255 (or env's 127/125), printing nothing at all to stdout, and
// opening stderr with ssh's exact bytes. That is a bound on plausibility, and
// the outcome of forging it is a named refusal, never a wrong answer.
test('classifyFailure: a command cannot forge a transport verdict', () => {
  // The overwhelmingly common case: the failure is the command's own.
  assert.equal(classify({ code: 1, stdout: '', stderr: 'fatal: not a git repository' }), null);
  assert.equal(classify({ code: 2, stdout: 'usage: git ...', stderr: '' }), null);
  // A remote command that itself exits 255 — measured to pass through verbatim.
  assert.equal(classify({ code: 255, stdout: 'my own output', stderr: 'my own error' }), null);
  assert.equal(classify({ code: 255, stdout: '', stderr: 'my own error' }), null);
  // ssh's wording present but NOT opening stderr.
  assert.equal(classify({
    code: 255, stdout: '',
    stderr: 'warning: something first\nssh: connect to host box port 22: No route to host',
  }), null);
  // ssh's wording with the command's own stdout alongside it.
  assert.equal(classify({
    code: 255, stdout: 'real output',
    stderr: 'ssh: connect to host box port 22: No route to host',
  }), null);
  // Host key wording at an exit code ssh never produces for it.
  assert.equal(classify({ code: 1, stdout: '', stderr: 'Host key verification failed.\n' }), null);
  // env's wording at the WRONG exit code — the command's own failure.
  assert.equal(classify({ code: 1, stdout: '', stderr: "env: 'x': No such file or directory\n" }), null);
  assert.equal(classify({ code: 126, stdout: '', stderr: "env: 'x': No such file or directory\n" }), null);
});

// ── U13-U16: the async seams, driven through a stub ssh ──────────────

/**
 * A stub `ssh` on disk: it logs its argv one element per line and answers on a
 * branch of what it was asked. A real executable is the cheapest way to make
 * the real spawn path — argv, exit code, stream separation — part of what is
 * under test.
 *
 * `socket: true` makes it CREATE a file at the requested ControlPath, so
 * `reachability`'s fingerprint has a real inode and ctime to read.
 */
async function stubSsh(t, {
  checkExit = 0, checkStdout = '', checkStderr = 'Master running (pid=4242)\n',
  exitExit = 0, exitStdout = '', exitStderr = 'Exit request sent.\n',
  connectExit = 0, connectStderr = '',
  execStdout = 'CCREAP ok 0 7\n', execStderr = '', execExit = 0,
  socket = false,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-sshstub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const argvLog = path.join(dir, 'argv.txt');
  const bin = path.join(dir, 'ssh');
  const q = JSON.stringify;
  await fs.writeFile(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> ${q(argvLog)}`,
    // Recover the ControlPath the caller asked for, so the stub can materialise
    // a socket there — reachability's fingerprint is read off that file.
    'cp=""; verb=""; prev=""',
    'for a in "$@"; do',
    '  case "$a" in -o) : ;; ControlPath=*) cp=${a#ControlPath=} ;; esac',
    '  case "$prev" in -O) verb=$a ;; esac',
    '  prev=$a',
    'done',
    // Quiet: with the control directory absent — the normal state for every
    // operation except `connect` — this simply does not happen, and its
    // complaint must not reach the stderr under assertion.
    socket ? '[ -n "$cp" ] && [ -d "$(dirname "$cp")" ] && : > "$cp"' : ':',
    `if [ "$verb" = check ]; then printf '%b' ${q(checkStdout)}; printf '%b' ${q(checkStderr)} >&2; exit ${checkExit}; fi`,
    `if [ "$verb" = exit ]; then printf '%b' ${q(exitStdout)}; printf '%b' ${q(exitStderr)} >&2; exit ${exitExit}; fi`,
    // A master start: -N with no remote command.
    `case " $* " in *" -N "*) printf '%b' ${q(connectStderr)} >&2; exit ${connectExit} ;; esac`,
    `printf '%b' ${q(execStdout)}; printf '%b' ${q(execStderr)} >&2; exit ${execExit}`,
  ].join('\n'));
  await fs.chmod(bin, 0o755);
  return {
    cli: [bin],
    dir,
    // Empty when the stub was never invoked at all — every caller passes
    // arguments, so `[]` is unambiguously "never run" rather than "run bare".
    async argv() {
      try { return (await fs.readFile(argvLog, 'utf8')).split('\n').filter(Boolean); }
      catch { return []; }
    },
  };
}

// PINS tier 1 of the two-tier baseline probe for this kind: reachability reads a
// HOST-SIDE artifact — the ControlPath socket — and never makes a round trip
// INTO the target, because it runs on every card render. The fingerprint recipe
// is the one already locked in .wiki/gotchas/baseline-probe-two-tier.md: the
// config hash plus the socket's inode and ctime. A new master means a new
// socket means a new inode, which is exactly what makes `needsProbe` re-probe.
//
// A mutant that connects here side-effects every card render; a mutant with a
// constant fingerprint caches a stale baseline verdict across a reconnect.
test('reachability: a live master gives connected + a fingerprint tied to the socket', async (t) => {
  await withTmpdir(t);
  // A LIVE MASTER IMPLIES `connect` ALREADY RAN, and `connect` is what creates
  // the control directory — so the fixture creates it here rather than
  // pretending reachability would.
  await fs.mkdir(controlDir(), { recursive: true, mode: 0o700 });
  const stub = await stubSsh(t, { checkExit: 0, socket: true });
  const r = await createSshTransport({ cli: stub.cli }).reachability(CONFIG);
  assert.equal(r.connected, true, r.detail);
  assert.match(r.fingerprint, /^ssh:[0-9a-f]{20}:\d+:\d+$/, r.fingerprint);
  assert.match(r.detail, new RegExp(controlPathFor(CONFIG).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the detail names the ControlPath, so an operator can issue `ssh -O exit` out of band');

  const argv = await stub.argv();
  assert.ok(runIndex(argv, ['-O', 'check']) !== -1, 'a control-socket query, not a round trip');
  assert.equal(argv.at(-1), DEST);
  assert.equal(argv.at(-2), '--');
  assert.equal(argv.includes('-N'), false, 'reachability must never START a master');
  assert.ok(argv.includes('ControlMaster=no'), 'nor become one');
});

// PINS the rule baseline.mjs's `needsProbe` depends on: a falsy fingerprint
// means "probe again", so a non-null one on a host we could not reach would
// cache a verdict against it.
test('reachability: every non-connected answer has a NULL fingerprint', async (t) => {
  await withTmpdir(t);
  const noMaster = await stubSsh(t, {
    checkExit: 255, checkStderr: 'Control socket connect(/tmp/x): No such file or directory\n',
  });
  const a = await createSshTransport({ cli: noMaster.cli }).reachability(CONFIG);
  assert.equal(a.connected, false);
  assert.equal(a.fingerprint, null);
  assert.match(a.detail, /no multiplexed connection|not connected/i);

  // Exit 0 but no socket on disk: we cannot fingerprint what we cannot stat, and
  // claiming connected without one would cache a verdict keyed on nothing.
  const noFile = await stubSsh(t, { checkExit: 0, socket: false });
  const b = await createSshTransport({ cli: noFile.cli }).reachability(CONFIG);
  assert.equal(b.fingerprint, null);

  // The ssh CLI itself cannot be spawned at all.
  const c = await createSshTransport({ cli: ['/definitely-not-ssh-xyz'] }).reachability(CONFIG);
  assert.equal(c.connected, false);
  assert.equal(c.fingerprint, null);
  assert.match(c.detail, /CODE_SYSTEM_SSH/, 'and it names the seam that fixes it');
});

// PINS THE MECHANISM criterion 1's out-of-band clause depends on: this
// transport holds NO connection state. Every call re-asks the socket, so an
// `ssh -O exit` issued outside the plugin is reflected immediately with nothing
// restarted. A memoised answer would report a master that is gone.
// (Same argument as store.mjs's "there is no cache", applied to connect state.)
test('reachability: there is no cached connect state — every call re-asks the socket', async (t) => {
  await withTmpdir(t);
  const stub = await stubSsh(t, { checkExit: 0, socket: true });
  const tr = createSshTransport({ cli: stub.cli });
  await tr.reachability(CONFIG);
  const after1 = (await stub.argv()).filter(a => a === 'check').length;
  await tr.reachability(CONFIG);
  const after2 = (await stub.argv()).filter(a => a === 'check').length;
  assert.equal(after1, 1);
  assert.equal(after2, 2, 'a second call must really re-query, not answer from memory');
});

// PINS the dedicated master criterion 1 names, and the idempotence the fixture's
// own teardown depends on.
//
// THERE IS NO `-M`, DELIBERATELY, and it is measured. `ssh -G` on this client:
// `-o ControlMaster=yes` → `controlmaster true`; `-M` → `true`; but
// `-o ControlMaster=yes -M` (our option block precedes any appended flag) →
// `controlmaster ASK` — and `ask` cannot be answered under `BatchMode=yes`, so
// `connect` would hang or fail. One mechanism only, from the one builder.
test('connect starts ONE master with no doubled ControlMaster, and disconnect is idempotent', async (t) => {
  await withTmpdir(t);
  const stub = await stubSsh(t, { connectExit: 0, checkExit: 0, socket: true });
  const tr = createSshTransport({ cli: stub.cli });
  await tr.connect(CONFIG);

  const argv = await stub.argv();
  assert.ok(argv.includes('-N'), 'no remote command: this is a master, not an exec');
  assert.ok(argv.includes('-f'), 'backgrounded only AFTER authentication succeeds');
  assert.ok(argv.includes('ControlMaster=yes'));
  assert.ok(argv.some(a => a.startsWith('ControlPersist=')));
  assert.equal(argv.includes('-M'), false,
    '`-M` alongside `-o ControlMaster=yes` measures as `ask`, which BatchMode cannot answer');
  assert.equal(argv.filter(a => a.startsWith('ControlMaster=')).length, 2,
    'the master start, then the -O check that proves it — one ControlMaster each');
  assert.ok(argv.includes('check'), 'connect proves itself rather than trusting exit 0');

  // A connect whose master never came up must not report success.
  const dead = await stubSsh(t, { connectExit: 255, connectStderr: 'Permission denied (publickey).\n' });
  await assert.rejects(() => createSshTransport({ cli: dead.cli }).connect(CONFIG), /ssh/i);

  // DISCONNECT is idempotent: "already closed" IS the requested state, and the
  // measured wording for it is exit 255 + `Control socket connect(...)`.
  const gone = await stubSsh(t, {
    exitExit: 255, exitStderr: 'Control socket connect(/tmp/x): No such file or directory\n',
  });
  await createSshTransport({ cli: gone.cli }).disconnect(CONFIG);
  assert.ok((await gone.argv()).includes('exit'));

  // But a disconnect that failed for any OTHER reason is reported.
  const broken = await stubSsh(t, { exitExit: 255, exitStderr: 'something else entirely\n' });
  await assert.rejects(() => createSshTransport({ cli: broken.cli }).disconnect(CONFIG), /disconnect|something else/i);
});

// PINS the relay's proof obligation, which is the whole reason `reap` may
// throw: from the caller's side a blind scan and a clean one are identical
// ("no kills, exit 0") and only one of them is a leak.
test('reap proves it ran, stays quiet when the host is gone, and carries no token itself', async (t) => {
  await withTmpdir(t);
  const handle = { pid: null, token: 'tok', remoteId: 'r1' };

  const good = await stubSsh(t, { execStdout: 'CCREAP ok 2 9\n' });
  await createSshTransport({ cli: good.cli }).reap(CONFIG, handle);
  const argv = await good.argv();
  assert.ok(argv.some(a => a.includes('CC_EXEC_TOKEN=tok')), 'the reap scans for this token');
  assert.equal(argv.some(a => a === 'CC_EXEC_TOKEN=tok'), false,
    'but never as an assignment in its OWN environment, or it would kill itself');
  assert.ok(argv.some(a => a.includes('/bin/sh')), 'the relay runs under a POSIX shell');

  // BLIND: the script ran and said it could see nothing.
  const blind = await stubSsh(t, { execStdout: 'CCREAP blind\n', execExit: 3 });
  await assert.rejects(() => createSshTransport({ cli: blind.cli }).reap(CONFIG, handle),
    /may have survived/);

  // SILENT: exit 0 with no CCREAP line at all — a shell that did nothing.
  const silent = await stubSsh(t, { execStdout: '', execExit: 0 });
  await assert.rejects(() => createSshTransport({ cli: silent.cli }).reap(CONFIG, handle),
    /may have survived/);

  // BENIGN: the host is not there, so its processes went with it. Recognised
  // through the SAME classifier the exec path uses, so the two cannot drift —
  // and crying wolf on every shutdown would train the warning away.
  const gone = await stubSsh(t, {
    execStdout: '', execExit: 255,
    execStderr: 'ssh: connect to host 172.17.0.99 port 22: No route to host\n',
  });
  await createSshTransport({ cli: gone.cli }).reap(CONFIG, handle);

  // …but OUR ACCESS failing is not benign: nothing was reaped and the host may
  // well still be running it.
  const denied = await stubSsh(t, {
    execStdout: '', execExit: 255,
    execStderr: 'root@box: Permission denied (publickey).\n',
  });
  await assert.rejects(() => createSshTransport({ cli: denied.cli }).reap(CONFIG, handle),
    /may have survived/);
});

// ── U18: where the control directory is created, and where it is NOT ──

// PINS A DESIGN CONSTRAINT THAT WAS MEASURED, and the measurement contradicts
// the obvious reading of ssh_config(5)'s "will fall back to connecting normally
// if the control socket does not exist". That sentence is about a missing
// SOCKET. With the control DIRECTORY missing, `ControlMaster=auto` must still
// BIND one, and the bind fails. Four measurements, two of them controls:
//
//   ControlMaster=auto, dir absent          → exit 255, `unix_listener: cannot bind to path …`
//   ControlMaster=no,   dir absent          → exit 0, the command runs, nothing created
//   ControlMaster=no,   master live, 5 execs→ 0 further authentications, socket inode unchanged
//   ControlPath=none,   5 execs (control)   → 5 authentications
//
// So EVERY OPERATION CARRIES `ControlMaster=no`: it multiplexes onto a master
// when one exists and connects normally when none does, and it never needs a
// directory. That is what lets `spawnPlan` stay pure and the factory stay
// I/O-free while a first `exec` against a fresh remote still works — an
// `auto` mutant would need the directory that nothing on the pure exec path may
// create, and would exit 255 instead.
test('no operation carries ControlMaster=auto, and none needs the control directory', async (t) => {
  const dir = await withTmpdir(t);
  process.env.TMPDIR = dir;
  const expected = controlDir();
  const stub = await stubSsh(t, { checkExit: 0, socket: true });
  const tr = createSshTransport({ cli: stub.cli });

  // The factory does no I/O at all: nothing has been created by constructing it.
  await assert.rejects(() => fs.stat(expected), /ENOENT/, 'the factory must not touch the disk');

  // Nor does spawnPlan, however many plans are built.
  for (let i = 0; i < 5; i++) tr.spawnPlan(CONFIG, req());
  await assert.rejects(() => fs.stat(expected), /ENOENT/,
    'spawnPlan must stay pure — the handshake and the plan are I/O-free');

  // And no operation asks to become a master except `connect`.
  for (const over of [{}, { env: { A: '1' } }, { shell: 'x', argv: null }]) {
    const args = tr.spawnPlan(CONFIG, req(over)).args;
    assert.ok(args.includes('ControlMaster=no'), JSON.stringify(over));
    assert.equal(args.includes('ControlMaster=auto'), false,
      '`auto` would have to bind a socket, in a directory nothing pure may create');
    assert.equal(args.includes('ControlMaster=yes'), false);
  }
  await createSshTransport({ cli: stub.cli }).reachability(CONFIG);
  await createSshTransport({ cli: stub.cli }).reap(CONFIG, { pid: null, token: 'tok', remoteId: 'r1' });
  const argv = await stub.argv();
  assert.equal(argv.includes('ControlMaster=auto'), false, 'nor reachability, nor reap');
  assert.equal(argv.includes('ControlMaster=yes'), false);
  // reachability answered without the directory existing, which is the point.
  await assert.rejects(() => fs.stat(expected), /ENOENT/);
});

// PINS where the I/O actually lives: `connect` is the ONE operation that binds
// a socket, so it is the one that creates the directory — and being async it is
// allowed the I/O `spawnPlan` and the factory are not. A mutant that moved this
// into the factory reds the test above; one that dropped it entirely reds here.
test('connect creates the control directory, at 0700 and owned by us', async (t) => {
  const dir = await withTmpdir(t);
  process.env.TMPDIR = dir;
  const expected = controlDir();
  const stub = await stubSsh(t, { connectExit: 0, checkExit: 0, socket: true });

  await createSshTransport({ cli: stub.cli }).connect(CONFIG);
  const st = await fs.stat(expected);
  assert.ok(st.isDirectory());
  assert.equal(st.mode & 0o7777, 0o700, 'ssh_config(5) requires it not be group/world accessible');
  assert.equal(st.uid, process.getuid());
});

// PINS that a control directory we cannot trust is REFUSED rather than reused —
// and not repaired either. /tmp is world-writable, so a directory at our path
// owned by someone else, or group/world accessible, could let another local user
// pre-create a socket at our (derivable) ControlPath and attach OUR commands to
// THEIR master. chmod-ing it would paper over exactly that, so an existing
// directory with the wrong mode is a refusal naming the mode it found.
test('connect refuses a control directory that is group- or world-accessible', async (t) => {
  const dir = await withTmpdir(t);
  process.env.TMPDIR = dir;
  const target = controlDir();
  await fs.mkdir(target, { recursive: true });
  await fs.chmod(target, 0o777);
  const stub = await stubSsh(t, { connectExit: 0, checkExit: 0, socket: true });

  await assert.rejects(() => createSshTransport({ cli: stub.cli }).connect(CONFIG), (e) => {
    assert.match(e.message, /0777/, e.message);
    assert.match(e.message, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  // Refused, NOT repaired: the mode we found is still the mode on disk.
  assert.equal((await fs.stat(target)).mode & 0o7777, 0o777,
    'a suspicious directory must not be silently chmod-ed into acceptability');
  assert.deepEqual(await stub.argv(), [], 'and no ssh was invoked at all');
});
