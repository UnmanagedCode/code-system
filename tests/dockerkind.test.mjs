// THE PURE HALF of the docker transport: argv construction, the CLI seam, the
// attach-only guard, the failure classifier and reachability. Runs in plain
// `npm test` with NO DOCKER ANYWHERE — `spawnPlan` is a pure function and
// `reachability`/`classifyFailure` are driven through injected stubs or an
// invocation that cannot exist.
//
// Every string quoted here as docker's own output was MEASURED against Docker
// Engine 29.7.2 (see .wiki/gotchas/docker-exec-transport.md). Paraphrasing one
// would make the classifier pass a test and fail in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_SUBCOMMANDS, DOCKER_ENV, assertAttachOnly, buildReapScript, createDockerTransport,
  dockerCliArgv,
} from '../src/launcher/kinds/docker.mjs';

const CONFIG = { container: 'app' };

// A frame as session.mjs builds it. `env: null` is the INHERIT case — which is
// what cc sends on all seven of its derivations, and what run.mjs sends for
// every fileops script and the baseline probe.
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

const plan = (over = {}, config = CONFIG) =>
  createDockerTransport({ cli: ['docker'] }).spawnPlan(config, req(over));

// Is `needle` present as a CONTIGUOUS run of `hay`?
function runIndex(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((v, j) => hay[i + j] === v)) return i;
  }
  return -1;
}

// ── P1: argv shape ───────────────────────────────────────────────────

// PINS: the frame's cwd reaches the container through `-w` and NOT as the host
// child's working directory (SpawnPlan's typedef says docker leaves `cwd`
// unset); the container is an OPERAND after `--`; and both the routing binding
// and the reap token reach the container. A mutant that drops `-w`, sets
// `plan.cwd`, drops `--`, or omits either `-e` reds this.
test('spawnPlan: the whole argv, the container as an operand, and cwd in argv not on the plan', () => {
  const p = plan();
  assert.equal(p.file, 'docker');
  assert.deepEqual(p.args, [
    'exec', '-w', '/w', '-e', 'CC_REMOTE=r1', '-e', 'CC_EXEC_TOKEN=tok', '--', 'app', 'git', 'status',
  ]);
  assert.equal(p.cwd, undefined, "the frame's cwd rides in argv as -w, never as the host child's cwd");
  assert.equal(p.env, undefined, 'the host-side docker client gets no env of its own');
});

// PINS acceptance 5: `cwd: '/'` is passed straight through. Every cc derivation
// carries it as a placeholder with its real target in argv, so a fence here
// would refuse all seven while `exec` and the file primitives kept working.
test("spawnPlan: cwd '/' is served verbatim, never fenced or rewritten", () => {
  const p = plan({ cwd: '/' });
  assert.equal(p.args[runIndex(p.args, ['-w']) + 1], '/');
});

// ── P2: stdin ────────────────────────────────────────────────────────

// PINS: `-i` iff the frame asked for a pipe. Measured, that is the difference
// between the container process receiving our stdin (how writeFile's base64
// payload arrives) and seeing an immediately-closed one (§5's stdin:'ignore').
// An always-`-i` mutant reds the second half; a never-`-i` mutant reds the
// first, and would silently turn every writeFile into a zero-byte file.
test("spawnPlan: -i is present iff stdinMode is 'pipe'", () => {
  assert.ok(plan({ stdinMode: 'pipe' }).args.includes('-i'));
  assert.equal(plan({ stdinMode: 'ignore' }).args.includes('-i'), false);
  // And it is an option of `docker exec`, before the operand boundary.
  const p = plan({ stdinMode: 'pipe' });
  assert.ok(p.args.indexOf('-i') < p.args.indexOf('--'));
});

// ── P3 / P4: env ─────────────────────────────────────────────────────

// PINS §5's `env` row — a supplied env REPLACES rather than overlays — and that
// the provider's binding beats a frame-supplied CC_REMOTE.
//
// THE FIXTURE MUST COLLIDE ON CC_REMOTE OR THIS PINS NOTHING: `{...frameEnv,
// CC_REMOTE}` and `{CC_REMOTE, ...frameEnv}` are byte-identical unless the
// frame's own env names one. Same trap tests/hostkind.test.mjs documents.
test('spawnPlan: a frame env REPLACES via `env -i`, with CC_REMOTE overlaid last', () => {
  const p = plan({ env: { PATH: '/p', CC_REMOTE: 'frame-supplied' } });
  assert.ok(
    runIndex(p.args, ['env', '-i', '--', 'PATH=/p', 'CC_REMOTE=r1', 'CC_EXEC_TOKEN=tok', 'git', 'status']) !== -1,
    `the replacement runs contiguously before the command; got ${JSON.stringify(p.args)}`);
  assert.equal(p.args.includes('CC_REMOTE=frame-supplied'), false,
    'a frame-supplied CC_REMOTE must not survive — that is the routing lie CC_REMOTE exists to prevent');
  // `env -i` would wipe any `-e` flags, so emitting them here would be a
  // silently-dropped binding rather than a visible error.
  assert.equal(p.args.includes('-e'), false, 'no -e flags in the replacement case');
});

// PINS the rule session.mjs's old `process.env` fallback broke: an ABSENT frame
// `env` means the command inherits THE CONTAINER's PATH, HOME and toolchain
// (§7: "they inherit the far side's environment"). That is what every cc
// derivation, every fileops script and the baseline probe rely on. A mutant
// treating null as "replace with the launcher's process.env" reds here — and
// that mutant was the shipped behaviour before this card.
test('spawnPlan: no frame env means the CONTAINER keeps its own environment', () => {
  const p = plan({ env: null });
  assert.equal(p.args.includes('env'), false, 'no `env -i` prefix');
  assert.equal(p.args.includes('-i'), false);
  // Only the two plumbing variables are overlaid, as docker flags.
  assert.ok(runIndex(p.args, ['-e', 'CC_REMOTE=r1']) !== -1);
  assert.ok(runIndex(p.args, ['-e', 'CC_EXEC_TOKEN=tok']) !== -1);
  // The command starts immediately after the container operand.
  assert.deepEqual(p.args.slice(p.args.indexOf('--') + 1), ['app', 'git', 'status']);
});

test('spawnPlan: an unrouted exec carries the token but no CC_REMOTE', () => {
  const p = plan({ remoteId: null });
  assert.equal(p.args.includes('CC_REMOTE=r1'), false);
  assert.ok(p.args.includes('CC_EXEC_TOKEN=tok'), 'reap still needs to find its own processes');
  assert.equal(p.args.some(a => a.startsWith('CC_REMOTE=')), false);
});

// ── P5: the shell form ───────────────────────────────────────────────

// PINS that the interpreter is the one the baseline probe requires
// (`[ -x /bin/bash ]`, src/baseline.mjs) and is named ABSOLUTELY, so it resolves
// under `env -i` regardless of the frame's PATH. A bare-`bash` mutant reds.
test("spawnPlan: the shell form is /bin/bash -lc, by absolute path", () => {
  const p = plan({ shell: 'echo hi', argv: null });
  assert.deepEqual(p.args.slice(-3), ['/bin/bash', '-lc', 'echo hi']);
  // And under a replacement env, where an unqualified name would depend on the
  // frame's PATH rather than the container's.
  const q = plan({ shell: 'echo hi', argv: null, env: { PATH: '/nowhere' } });
  assert.deepEqual(q.args.slice(-3), ['/bin/bash', '-lc', 'echo hi']);
});

// ── P6: detached ─────────────────────────────────────────────────────

// PINS: session.#terminate reads `detached` as "a group kill reached the far
// side". For docker it did not — the container process is not our OS descendant
// at all (measured) — so a `detached: true` mutant makes every terminated exec
// falsely OMIT `descendantsMaySurvive`, which is §11's undetectable lie.
test('spawnPlan: never detached, on either form and either env case', () => {
  for (const over of [{}, { env: { A: '1' } }, { shell: 'x', argv: null }, { stdinMode: 'pipe' }]) {
    assert.notEqual(plan(over).detached, true, JSON.stringify(over));
  }
});

// ── P7: the CLI seam ─────────────────────────────────────────────────

// PINS acceptance 10: the shipped default is bare `docker` with NO `sudo`
// anywhere, the override is a whole argv rather than a path, and a malformed
// override refuses LOUDLY instead of silently falling back — a silent fallback
// would fail every operation on a host like this one with a socket-permission
// error that names nothing.
test('the docker invocation is overridable, and the shipped default hardcodes no sudo', () => {
  assert.deepEqual(dockerCliArgv({}), ['docker']);
  assert.deepEqual(dockerCliArgv({ [DOCKER_ENV]: '   ' }), ['docker']);
  assert.equal(dockerCliArgv({}).join(' ').includes('sudo'), false);

  assert.deepEqual(dockerCliArgv({ [DOCKER_ENV]: '["sudo","-n","docker"]' }), ['sudo', '-n', 'docker']);

  for (const bad of ['docker', '[]', '["a",1]', '["a",""]', '{', '{"a":1}', 'null']) {
    assert.throws(() => dockerCliArgv({ [DOCKER_ENV]: bad }), /CODE_SYSTEM_DOCKER/,
      `${JSON.stringify(bad)} must refuse loudly, not fall back to bare docker`);
  }

  const p = createDockerTransport({ cli: ['sudo', '-n', 'docker'] }).spawnPlan(CONFIG, req());
  assert.equal(p.file, 'sudo');
  assert.deepEqual(p.args.slice(0, 3), ['-n', 'docker', 'exec']);
});

// ── P8: attach-only ──────────────────────────────────────────────────

// PINS acceptance 9. The provider may never run `docker start/stop/run/rm`;
// every docker invocation in the module goes through the guard, so an edit that
// reaches for one throws instead of shipping.
test('attach-only is ENFORCED, not remembered', () => {
  assert.deepEqual(ALLOWED_SUBCOMMANDS, ['exec', 'inspect']);
  for (const sub of ['start', 'stop', 'run', 'rm', 'create', 'kill']) {
    assert.throws(() => assertAttachOnly(sub), /ATTACH-ONLY/, sub);
  }
  for (const sub of ALLOWED_SUBCOMMANDS) assert.doesNotThrow(() => assertAttachOnly(sub));
  // And spawnPlan builds only `exec`, whatever the frame asked for.
  for (const over of [{}, { shell: 'x', argv: null }, { env: { A: '1' } }]) {
    assert.equal(plan(over).args[0], 'exec');
  }
});

// ── P9: classifyFailure ──────────────────────────────────────────────

const classify = (res) => createDockerTransport({ cli: ['docker'] }).classifyFailure(CONFIG, res);

// PINS two distinct wrong answers, both silent in production. Classifying a
// socket-permission failure as ENOREMOTE sends a user to recreate a container
// that is fine; classifying a command's own non-zero exit as a protocol error
// turns every failing `git` into a dead remote.
test('classifyFailure: a missing or stopped container is ENOREMOTE, naming the CONFIGURED container', () => {
  const missing = classify({
    code: 1, stdout: '',
    stderr: 'Error response from daemon: No such container: app\n',
  });
  assert.equal(missing.code, 'ENOREMOTE');
  assert.match(missing.message, /'app'/, "docker's own text names the 64-hex id, so ours must name the container");

  const stopped = classify({
    code: 1, stdout: '',
    stderr: 'Error response from daemon: container ab8b40c4aa899332002d6acb6b9535943a73dcebae8ad3c6961577b06f93b907 is not running\n',
  });
  assert.equal(stopped.code, 'ENOREMOTE');
  assert.match(stopped.message, /'app'/);
  assert.match(stopped.message, /ATTACH-ONLY/, 'a stopped container is not something we offer to start');
});

test('classifyFailure: our own access failing is NEVER ENOREMOTE', () => {
  for (const stderr of [
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/containers/app/json": dial unix /var/run/docker.sock: connect: permission denied\n',
    'Cannot connect to the Docker daemon at unix:///tmp/nonexistent.sock. Is the docker daemon running?\n',
  ]) {
    const v = classify({ code: 1, stdout: '', stderr });
    assert.equal(v.code, 'EUNKNOWN', 'the remote is not absent — WE cannot reach the daemon');
    assert.notEqual(v.code, 'ENOREMOTE');
    assert.match(v.message, /CODE_SYSTEM_DOCKER/, 'and the message names the seam that fixes it');
  }
});

// PINS §5's "a command that never started is an error frame, not an exit
// frame", for the two cases that produce it — and the surprising channel:
// both arrive on STDOUT with exit 127, so a stderr-only classifier is blind to
// them and fileops' header parse would see the text as file content.
test('classifyFailure: a command that never started is ENOENT, and its text is on STDOUT', () => {
  const noBinary = classify({
    code: 127, stderr: '',
    stdout: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "nope": executable file not found in $PATH\n',
  });
  assert.equal(noBinary.code, 'ENOENT');

  const noCwd = classify({
    code: 127, stderr: '',
    stdout: 'OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("/nope") set in config.json failed: no such file or directory\n',
  });
  assert.equal(noCwd.code, 'ENOENT');

  // MEASURED SEPARATELY, and it is neither exit 127 nor does it carry the
  // `unable to start container process: ` segment the other two share:
  // `docker exec -w relative` and `docker exec -w -evil` both answer exit 128
  // with `Cwd must be an absolute path` on stdout. Anchoring on the longer
  // prefix, or on 127 alone, reports a command that never started as one that
  // ran and exited 128.
  const badCwd = classify({
    code: 128, stderr: '',
    stdout: 'OCI runtime exec failed: exec failed: Cwd must be an absolute path\n',
  });
  assert.equal(badCwd.code, 'ENOENT');
  assert.match(badCwd.message, /Cwd must be an absolute path/);
});

// PINS the guards themselves. Without them a command's own output could forge a
// transport verdict — and the 127/stdout row has no stderr-side counterweight
// of its own, so it is guarded on the exit code, an EMPTY stderr, and the full
// docker-internal sentence as the very first bytes of stdout.
test('classifyFailure: a command cannot forge a transport verdict', () => {
  // The command's own failure, which is the overwhelmingly common case.
  assert.equal(classify({ code: 2, stdout: '', stderr: 'fatal: not a git repository' }), null);
  assert.equal(classify({ code: 1, stdout: 'usage: git ...', stderr: '' }), null);
  // Docker writes NOTHING to stdout on a daemon-response failure, so anything
  // there means the command ran and this is its own exit.
  assert.equal(classify({
    code: 1, stdout: 'some real output',
    stderr: 'Error response from daemon: No such container: app',
  }), null);
  // The daemon prefix must OPEN stderr, not merely appear in it.
  assert.equal(classify({
    code: 1, stdout: '',
    stderr: 'warning: something\nError response from daemon: No such container: app',
  }), null);
  // Exit 127 from a command that printed the OCI sentence itself, but wrote to
  // stderr as any real command eventually does.
  assert.equal(classify({
    code: 127, stderr: 'sh: 1: nope: not found',
    stdout: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "x": executable file not found in $PATH',
  }), null);
  // …and the same text at exit 1 rather than 127.
  assert.equal(classify({
    code: 1, stderr: '',
    stdout: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "x": executable file not found in $PATH',
  }), null);
  // A daemon response we have no row for stays the command's business.
  assert.equal(classify({ code: 1, stdout: '', stderr: 'Error response from daemon: something new' }), null);
});

// ── P10: reachability ────────────────────────────────────────────────

// Drives the real `reachability` against a docker invocation that CANNOT exist,
// plus a stub CLI written to a temp file for the outcomes that need a daemon.
// A shell script is the cheapest way to make the real spawn path — argv, exit
// code, stream separation — part of what is under test.

async function stubCli(t, {
  exitCode = 0, stdout = '', stderr = '',
  execStdout = 'CCREAP ok 0 7\n', execStderr = '', execExitCode = 0,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-dockerstub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const argvLog = path.join(dir, 'argv.txt');
  const bin = path.join(dir, 'docker');
  await fs.writeFile(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}`,
    // `exec` and `inspect` answer differently: a reap that gets an inspect-shaped
    // answer must (and does) report failure, which would otherwise make every
    // stub-driven test that calls reap throw.
    `if [ "$1" = exec ]; then printf '%b' ${JSON.stringify(execStdout)};`
      + ` printf '%b' ${JSON.stringify(execStderr)} >&2; exit ${execExitCode}; fi`,
    stdout ? `printf '%b' ${JSON.stringify(stdout)}` : ':',
    stderr ? `printf '%b' ${JSON.stringify(stderr)} >&2` : ':',
    `exit ${exitCode}`,
  ].join('\n'));
  await fs.chmod(bin, 0o755);
  return {
    cli: [bin],
    async argv() { return (await fs.readFile(argvLog, 'utf8')).split('\n').filter(Boolean); },
  };
}

// PINS: the fingerprint is image id + State.StartedAt from THE SAME call the
// card render is already making (the two-tier probe's tier 1), and it is `null`
// for every non-running answer. A constant-fingerprint mutant makes a restarted
// container reuse a stale baseline verdict (baseline.mjs → needsProbe); a
// `connected:true`-for-stopped mutant makes the backend probe a container it
// cannot reach on every card render.
test('reachability: a running container gives connected + a fingerprint that moves with the container', async (t) => {
  const running = await stubCli(t, {
    stdout: 'true sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e 2026-09-02T07:29:27.245884507Z\n',
  });
  const r = await createDockerTransport({ cli: running.cli }).reachability(CONFIG);
  assert.equal(r.connected, true);
  assert.equal(r.fingerprint,
    'docker:sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e:2026-09-02T07:29:27.245884507Z');

  // `--type container`, or an identically-named IMAGE could answer instead.
  const argv = await running.argv();
  assert.deepEqual(argv.slice(0, 3), ['inspect', '--type', 'container']);
  assert.ok(argv.includes('--'), 'the container is an operand');
  assert.equal(argv.at(-1), 'app');

  // A restart moves StartedAt, and therefore the fingerprint — which is the
  // whole mechanism that re-probes the baseline.
  const restarted = await stubCli(t, {
    stdout: 'true sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e 2026-09-04T11:00:00.000000000Z\n',
  });
  const r2 = await createDockerTransport({ cli: restarted.cli }).reachability(CONFIG);
  assert.notEqual(r2.fingerprint, r.fingerprint);
});

test('reachability: every non-running answer has a NULL fingerprint', async (t) => {
  const stopped = await stubCli(t, { stdout: 'false sha256:19a4 2026-06-09T13:00:14.458862563Z\n' });
  const a = await createDockerTransport({ cli: stopped.cli }).reachability(CONFIG);
  assert.equal(a.connected, false);
  assert.equal(a.fingerprint, null, 'a non-null fingerprint here caches a verdict for a container we cannot reach');
  assert.match(a.detail, /ATTACH-ONLY/);
  assert.match(a.detail, /'app'/);

  const missing = await stubCli(t, {
    exitCode: 1, stderr: 'Error response from daemon: No such container: app\n',
  });
  const b = await createDockerTransport({ cli: missing.cli }).reachability(CONFIG);
  assert.equal(b.connected, false);
  assert.equal(b.fingerprint, null);
  assert.match(b.detail, /'app'/);
  assert.match(b.detail, /No such container/);

  // The docker CLI itself cannot be spawned at all.
  const c = await createDockerTransport({ cli: ['/definitely-not-docker-xyz'] }).reachability(CONFIG);
  assert.equal(c.connected, false);
  assert.equal(c.fingerprint, null);
  assert.match(c.detail, /CODE_SYSTEM_DOCKER/, 'and it names the seam that fixes it');
});

// PINS acceptance 9 at the only two places that actually invoke docker: a
// mutant adding a `docker start` to reachability throws rather than starting
// anything, and the reap relay only ever `exec`s.
test('neither reachability nor reap ever runs anything but exec/inspect', async (t) => {
  const stub = await stubCli(t, { stdout: 'true sha256:x 2026-01-01T00:00:00Z\n' });
  const tr = createDockerTransport({ cli: stub.cli });
  await tr.reachability(CONFIG);
  await tr.reap(CONFIG, { pid: 1, token: 'tok', remoteId: 'r1' });
  const argv = await stub.argv();
  const subcommands = argv.filter(a => ALLOWED_SUBCOMMANDS.includes(a) || ['start', 'stop', 'run', 'rm'].includes(a));
  assert.deepEqual([...new Set(subcommands)].sort(), ['exec', 'inspect']);
  // The reap script carries the exec's token so it can find that exec's own
  // processes, and does NOT carry it as an `-e` flag (which would make the reap
  // match and kill itself).
  assert.ok(argv.some(a => a.includes('CC_EXEC_TOKEN=tok')), 'the reap scans for this token');
  assert.equal(argv.includes('-e'), false, 'the reap exec must not carry the token in its own environment');
});

// ── the live suite's skip gate, tested WITHOUT a daemon ──────────────

// PINS acceptance 11's mechanism: the gate for tests/docker-live.test.mjs is a
// DAEMON PROBE, not a `command -v docker`. This host has the CLI installed and
// the socket unreadable, so a `which`-shaped gate would let every live test run
// and fail with a permission error instead of skipping.
//
// The fixture below is exactly what unprivileged `docker version` does here,
// measured: it prints its whole Client block to STDOUT and exits 1 with the
// permission text on stderr. A gate reading "did it produce output" — or one
// checking the file exists — passes it; only asking for the SERVER version
// rejects it.
test('the live-docker skip gate rejects an installed CLI that cannot reach a daemon', async (t) => {
  const { probeCli, SKIP_REASON } = await import('./dockerFixture.mjs');

  assert.equal(await probeCli(['/definitely-not-docker-xyz']), null, 'a CLI that does not exist');

  const looksInstalled = await stubCli(t, {
    exitCode: 1,
    stdout: 'Client:\\n Version:           26.1.5+dfsg1\\n API version:       1.45\\n',
    stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: dial unix /var/run/docker.sock: connect: permission denied\\n',
  });
  assert.equal(await probeCli(looksInstalled.cli), null,
    'installed, executable, and talkative — but no daemon answered');

  // A daemon that does answer is accepted, so the gate is not simply "always
  // skip" (which would make every live test vacuous).
  const answers = await stubCli(t, { stdout: '29.7.2\\n' });
  assert.deepEqual((await probeCli(answers.cli)).serverVersion, '29.7.2');

  // LOUD: the skip names both attempts and the override that fixes it.
  assert.match(SKIP_REASON, /CODE_SYSTEM_DOCKER/);
  assert.match(SKIP_REASON, /sudo -n docker/);
});

// ── the `env -i` operand boundary ────────────────────────────────────

// PINS THE FIX FOR AN OPTION INJECTION. Frame-supplied env KEYS are arbitrary,
// and GNU `env` parses leading-`-` operands as its own options until it meets a
// non-option operand. Measured inside node:24-slim (coreutils 9.1) with `-w /`:
//
//   env -i    '--chdir=/tmp' PATH=/usr/bin pwd  → /tmp   cwd HIJACKED
//   env -i -- '--chdir=/tmp' PATH=/usr/bin pwd  → /      the -w holds
//
// and on coreutils 9.7 `--argv0=EVIL` spoofs $0 while 9.1 refuses the exec
// outright (`env: unrecognized option`, exit 125) — so the same frame either
// silently relocates the command or kills it, depending on the image.
//
// Dropping the `--` reds this AND the live test that runs the hijack for real.
test('spawnPlan: `env -i --` closes the option-injection window on frame env keys', () => {
  const p = plan({ env: { '--chdir=/evil': '', PATH: '/p' } });
  const i = runIndex(p.args, ['env', '-i', '--']);
  assert.notEqual(i, -1, `expected a literal -- after env -i; got ${JSON.stringify(p.args)}`);
  // Every assignment is AFTER the boundary, so none can be read as an option.
  const boundary = i + 2;
  for (const a of p.args.filter(x => x.startsWith('--chdir='))) {
    assert.ok(p.args.indexOf(a) > boundary, `${a} must sit after the -- boundary`);
  }
  // And the guard is unconditional, not a function of what the frame sent.
  assert.notEqual(runIndex(plan({ env: {} }).args, ['env', '-i', '--']), -1,
    'an empty frame env still gets the boundary');
});

// PINS the rest of the argv/option surface, checked rather than assumed:
// nothing else this kind interpolates can become an option.
test('spawnPlan: every other interpolated value is structurally an operand', () => {
  // (a) the container is guarded by operand() AND placed after `--`.
  assert.equal(createDockerTransport({ cli: ['docker'] }).validateConfig({ container: '-v /:/host' }).ok, false);
  const p = plan({}, { container: 'app' });
  assert.ok(p.args.indexOf('app') > p.args.indexOf('--'));

  // (b) a leading-dash cwd is CONSUMED BY `-w` as its value, never parsed.
  const c = plan({ cwd: '-evil' });
  assert.equal(c.args[c.args.indexOf('-w') + 1], '-evil');

  // (c) a leading-dash command reaches the container as the command. In the
  //     inherit branch it sits after `-- <container>`; in the replace branch
  //     after `env -i --` and the assignments. Measured: docker does not eat
  //     flags after the container operand, and env does not after `--`.
  const inh = plan({ argv: ['-evilcmd', 'x'] });
  assert.deepEqual(inh.args.slice(inh.args.indexOf('--') + 1), ['app', '-evilcmd', 'x']);
  const rep = plan({ argv: ['-evilcmd', 'x'], env: { PATH: '/p' } });
  assert.deepEqual(rep.args.slice(-2), ['-evilcmd', 'x']);
  assert.ok(runIndex(rep.args, ['env', '-i', '--']) !== -1);

  // (d) the `-e` inherit path takes its value as a SEPARATE argv token, so a
  //     leading dash there cannot become a docker option either. Confirmed
  //     live: `docker exec -e '--chdir=/tmp=x' -w / -- <ctr> pwd` → `/`.
  const e = plan({ env: null });
  for (let k = 0; k < e.args.length; k++) {
    if (e.args[k] === '-e') assert.equal(typeof e.args[k + 1], 'string');
  }
});

// ── the reap relay reports whether it could see anything ─────────────

// PINS that a reap which could not run does not read as a reap that found
// nothing. Both are "no kills, exit 0" from the caller's side, and the
// difference is a leaked container-side subtree versus a clean shutdown — the
// exact MUST-3 hazard the relay exists for. A mutant restoring the
// unconditional `exit 0`, or one discarding runDocker's result, reds here.
test('the reap script detects its own blindness rather than reporting success', () => {
  const script = buildReapScript('deadbeef');
  assert.match(script, /readable=0/, 'it counts what it could actually read');
  assert.match(script, /CCREAP blind/, 'and refuses to claim success when that count is zero');
  assert.match(script, /exit 3/);
  // The token match must be LITERAL: unquoted, `$t` in a case pattern is a glob.
  assert.match(script, /\*"\$t"\*/);
  assert.match(script, /t='CC_EXEC_TOKEN=deadbeef'/);
  // No `ps` and no `grep` — node:24-slim has neither guaranteed.
  assert.doesNotMatch(script, /\bps\b|\bgrep\b/);
});

test('reap throws when it cannot prove it ran, and stays quiet when the container is simply gone', async (t) => {
  const good = await stubCli(t, { execStdout: 'CCREAP ok 2 9\n' });
  await createDockerTransport({ cli: good.cli }).reap({ container: 'app' }, { token: 'tok', remoteId: 'r1' });

  // BLIND: the script ran and said so.
  const blind = await stubCli(t, { execStdout: 'CCREAP blind\n', execExitCode: 3 });
  await assert.rejects(
    () => createDockerTransport({ cli: blind.cli }).reap({ container: 'app' }, { token: 'tok', remoteId: 'r1' }),
    /may have survived/);

  // SILENT: exit 0 with no CCREAP line at all — a shell that did nothing.
  const silent = await stubCli(t, { execStdout: '' });
  await assert.rejects(
    () => createDockerTransport({ cli: silent.cli }).reap({ container: 'app' }, { token: 'tok', remoteId: 'r1' }),
    /'app'/);

  // BENIGN: the container is gone, so its processes went with it and there is
  // nothing left to reap. Recognised through the SAME classifier the exec path
  // uses, so the two cannot drift — and it must NOT be reported as a leak, or
  // every shutdown against a stopped container would cry wolf.
  const gone = await stubCli(t, {
    execStdout: '', execExitCode: 1,
    execStderr: 'Error response from daemon: No such container: app\n',
  });
  await createDockerTransport({ cli: gone.cli }).reap({ container: 'app' }, { token: 'tok', remoteId: 'r1' });

  // …but OUR ACCESS failing is not benign: nothing was reaped and the container
  // may well still be running it.
  const denied = await stubCli(t, {
    execStdout: '', execExitCode: 1,
    execStderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n',
  });
  await assert.rejects(
    () => createDockerTransport({ cli: denied.cli }).reap({ container: 'app' }, { token: 'tok', remoteId: 'r1' }),
    /may have survived/);
});

// ── the live suite's skip gate: candidate composition ────────────────

// PINS the composition itself, because nothing else can. Delete the
// `sudo -n docker` fallback and `npm test` stays GREEN on a host whose docker
// socket is root-owned — all of tests/docker-live.test.mjs silently skips, and
// no skip count is asserted anywhere. This is the test that reds instead.
test('the live-docker gate tries the CODE_SYSTEM_DOCKER invocation first, then `sudo -n docker`', async () => {
  const { candidates } = await import('./dockerFixture.mjs');

  assert.deepEqual(candidates({}), [['docker'], ['sudo', '-n', 'docker']],
    'the default is bare docker, with the privileged fallback behind it');

  assert.deepEqual(candidates({ [DOCKER_ENV]: '["podman"]' }), [['podman'], ['sudo', '-n', 'docker']],
    'an override is tried FIRST, and does not remove the fallback');

  assert.deepEqual(candidates({ [DOCKER_ENV]: '["sudo","-n","docker"]' }), [['sudo', '-n', 'docker']],
    'an override that IS the fallback is not tried twice');

  // A malformed override is not a candidate — but it must not take the fallback
  // with it, or a typo would silently skip the whole live suite.
  assert.deepEqual(candidates({ [DOCKER_ENV]: 'not json' }), [['sudo', '-n', 'docker']]);
});

test('resolveDockerCli returns the FIRST candidate that a daemon answers', async (t) => {
  const { resolveDockerCli } = await import('./dockerFixture.mjs');
  const answers = await stubCli(t, { stdout: '29.7.2\n' });
  // The override answers, so the fallback is never reached — asserted by the
  // returned argv being the override's, not `sudo -n docker`.
  const found = await resolveDockerCli({ [DOCKER_ENV]: JSON.stringify(answers.cli) });
  assert.deepEqual(found.cli, answers.cli);
  assert.equal(found.serverVersion, '29.7.2');
});
