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
  ALLOWED_SUBCOMMANDS, DOCKER_ENV, assertAttachOnly, createDockerTransport, dockerCliArgv,
} from '../src/launcher/kinds/docker.mjs';
// MOVED to kinds/reapscript.mjs when card 2026-0004 landed: `ssh` needs the
// identical relay, so the script is shared rather than copied.
import { buildReapScript } from '../src/launcher/kinds/reapscript.mjs';
import { stubDockerCli as stubCli } from './helpers.mjs';

const CONFIG = { container: 'app' };

// A frame as session.mjs builds it. `env: null` is the INHERIT case — which is
// what cc sends on EVERY `exec` it issues (its own derivations and a caller's
// command alike), and what run.mjs sends for every fileops script and the
// baseline probe.
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

// ── P1b: the configured identity (`config.user` → `docker exec -u`) ──

const WITH_USER = { container: 'app', user: 'node' };

// PINS: the identity reaches docker as a FLAG, left of the operand boundary, and
// the container is still the first operand. A mutant pushing it after `--`, or
// joining it onto its value (`-unode`), makes the identity the command docker
// runs and shifts the container out of position.
test('spawnPlan: the configured identity becomes -u, before the -- operand boundary', () => {
  const p = plan({}, WITH_USER);
  assert.notEqual(runIndex(p.args, ['-u', 'node']), -1,
    `-u and its value must be two argv elements; got ${JSON.stringify(p.args)}`);
  assert.ok(p.args.indexOf('-u') < p.args.indexOf('--'), 'it is an option of `docker exec`, not an operand');
  assert.equal(p.args[p.args.indexOf('--') + 1], 'app', 'the container is still the first operand');
  assert.deepEqual(p.args.slice(p.args.indexOf('--') + 1), ['app', 'git', 'status']);
});

// PINS THE BACK-COMPAT CLAIM: an unset identity emits no flag at all — not
// `-u ''`, not `-u root`. A mutant defaulting the identity reds here, and would
// silently change which user the commands of every remote with no identity
// configured run as.
test('spawnPlan: no configured identity means NO -u flag at all', () => {
  for (const config of [{ container: 'app' }, { container: 'app', user: '' }, { container: 'app', user: undefined }]) {
    const p = plan({}, config);
    assert.equal(p.args.includes('-u'), false, JSON.stringify(config));
    assert.equal(p.args.some(a => a.startsWith('-u')), false, 'nor joined onto a value');
    assert.deepEqual(p.args, [
      'exec', '-w', '/w', '-e', 'CC_REMOTE=r1', '-e', 'CC_EXEC_TOKEN=tok', '--', 'app', 'git', 'status',
    ], 'a remote with no identity carries nothing of this field in its argv');
  }
});

// PINS that the identity is not accidentally scoped to the inherit branch. The
// REPLACE branch is a separate arm of the same function, and a mutant pushing
// `-u` inside `if (req.env === null)` leaves every cc-supplied-env exec running
// as the image default while the inherit path obeys the card.
test('spawnPlan: the identity applies to the env -i REPLACE branch too', () => {
  const p = plan({ env: { PATH: '/p' } }, WITH_USER);
  assert.notEqual(runIndex(p.args, ['-u', 'node']), -1);
  assert.ok(p.args.indexOf('-u') < runIndex(p.args, ['env', '-i', '--']),
    '-u is docker\'s flag and must stay left of the env replacement');
  assert.ok(p.args.indexOf('-u') < p.args.indexOf('--'));
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
// (§7: "Every command therefore runs in the provider's own environment … the far
// side's PATH and toolchain, not cc's"). That is what every `exec` cc issues,
// every fileops script and the baseline probe rely on. A mutant
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

// ── P8b: validateConfig and the identity's shape ─────────────────────

const validate = (raw) => createDockerTransport({ cli: ['docker'] }).validateConfig(raw);

// PINS that the form's rule is exactly what docker will take, so a stored
// identity never fails at exec time for a SHAPE reason — the operator sees a
// 400 in the card, not a broken remote later. Measured: `-u 'no such'` is
// refused by the daemon (exit 1, `unable to find user`), so this only moves the
// refusal earlier; and `_apt`/`app.user`/`my-user` are real account names a
// stricter rule would lock out.
test('validateConfig: identity forms docker accepts are accepted, and malformed ones are refused by name', () => {
  for (const user of ['node', '1000', 'node:node', '1000:1000', '_apt', 'app.user', 'my-user:my-group']) {
    const v = validate({ container: 'app', user });
    assert.equal(v.ok, true, `${JSON.stringify(user)} must be accepted: ${v.error}`);
    assert.equal(v.config.user, user, 'and stored verbatim');
  }
  // Surrounding whitespace is NORMALISED AWAY, not refused — which is what
  // docs/features.md promises an operator who pastes a value with a stray space.
  assert.deepEqual(validate({ container: 'app', user: '  node  ' }).config,
    { container: 'app', user: 'node' }, 'a padded identity is trimmed, not rejected');
  for (const user of ['no such', 'a;b', '$(id)', 'a:', ':b', 'a:b:c', '-rm', 'x\ny', 'a b:c', '.hidden']) {
    const v = validate({ container: 'app', user });
    assert.equal(v.ok, false, `${JSON.stringify(user)} must be refused`);
    assert.match(v.error, /user/, 'and the message names the field that is wrong');
  }
});

// PINS THAT THE REFUSAL AN OPERATOR READS IS TRUE OF THE FIELD THEY TYPED IN.
// `container` is an argv OPERAND, so config.mjs's shared message — "it becomes a
// command-line operand, and a leading dash makes it an option instead" — is
// accurate there. The identity is `-u`'s ARGUMENT: docker consumes the next argv
// element whatever it begins with, so both halves of that sentence are false
// here, and an operator following it looks for an option that is not there.
//
// The value stays refused either way; only the explanation is under test. A
// mutant routing the identity back through `operand` reds on the first half —
// and a mutant that "fixed" it by weakening config.mjs for everyone reds on the
// second.
test('validateConfig: a leading-dash identity is refused in docker\'s own terms, not as an operand', () => {
  for (const user of ['-rm', '--privileged', '-u']) {
    const v = validate({ container: 'app', user });
    assert.equal(v.ok, false, `${JSON.stringify(user)} must still be refused`);
    assert.doesNotMatch(v.error, /command-line operand/,
      'the identity is -u\'s argument, not an operand');
    assert.doesNotMatch(v.error, /makes it an option instead/,
      'and docker does not read it as an option');
    assert.match(v.error, /is not a docker identity/, 'it is refused for what it actually is');
    assert.match(v.error, /letter, digit or underscore/, 'and says what would be accepted');
  }
  // THE SHARED RULE IS UNTOUCHED where it is accurate: `container` really is an
  // operand, and `ssh`'s fields are interpolated the same way.
  const c = validate({ container: '-v /:/host' });
  assert.equal(c.ok, false);
  assert.match(c.error, /command-line operand/, 'an operand field keeps the operand wording');
});

// PINS the one thing that keeps `sameConfig` (src/api.mjs) from seeing a phantom
// change: an empty identity is DROPPED, not stored as ''. A mutant storing ''
// makes the stored `{container}` and the form's `{container, user:''}`
// canonicalise differently, so every docker remote with no identity set switches
// off on its next save.
test('validateConfig: an empty identity is dropped, not stored as \'\'', () => {
  for (const raw of [{ container: 'app' }, { container: 'app', user: '' }, { container: 'app', user: '   ' }]) {
    const v = validate(raw);
    assert.equal(v.ok, true);
    assert.deepEqual(v.config, { container: 'app' }, JSON.stringify(raw));
    assert.equal('user' in v.config, false, 'no phantom key for sameConfig to trip on');
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

// PINS that a misconfigured identity does not masquerade as a missing
// container. ENOREMOTE is read by cc's assertRemoteKnown as "this provider does
// not serve this remote", which would send the operator to recreate a container
// that is perfectly healthy — instead of to the one field that is wrong.
//
// Both measured wordings, verbatim: the user form and the group form.
test('classifyFailure: an identity the container rejects is EUNKNOWN naming the Run-as field, never ENOREMOTE', () => {
  const withUser = (res) =>
    createDockerTransport({ cli: ['docker'] }).classifyFailure({ container: 'app', user: 'nosuchuser' }, res);

  for (const stderr of [
    'Error response from daemon: unable to find user nosuchuser: no matching entries in passwd file\n',
    'Error response from daemon: unable to find group nosuchgroup: no matching entries in group file\n',
  ]) {
    const v = withUser({ code: 1, stdout: '', stderr });
    assert.equal(v.code, 'EUNKNOWN', stderr);
    assert.notEqual(v.code, 'ENOREMOTE', 'the container is fine — the identity is not');
    assert.match(v.message, /'app'/, 'the configured container');
    assert.match(v.message, /'nosuchuser'/, 'and the configured identity');
    assert.match(v.message, /Run as/, 'and the field on the card that fixes it');
    assert.match(v.message, /Advanced/, 'and where to find it');
    // cc RE-PARSES a refusal's message text, so a bare fs-errno token would
    // silently downgrade this into "the command answered non-zero".
    assert.doesNotMatch(v.message, /\b(ENOENT|EACCES|EEXIST|EISDIR|ENOTDIR|EPERM)\b/,
      '.wiki/gotchas/refusal-message-errno-tokens.md');
    assert.equal(v.stderr, stderr.trim(), 'docker\'s own first line is carried');
  }
});

// PINS §5's "a command that never started is an error frame, not an exit
// frame", for the THREE measured shapes that produce it — and the surprising
// channel: all arrive on STDOUT, with exit 127 (missing binary, missing `-w`
// directory) or 128 (a non-absolute `-w`). A stderr-only classifier is blind to
// every one of them, and fileops' header parse would see the text as file
// content.
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
// transport verdict — and the never-started rows have no daemon-side
// counterweight of their own, so they are guarded on an exit code from the
// measured pair (127 or 128), an EMPTY stderr, and the 38-byte stem all three
// share as the very first bytes of stdout.
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

  // THE IDENTITY ROWS ARE INSIDE THE SAME GUARDS. A command that prints
  // docker's identity wording itself must not be able to claim the remote's
  // Run-as field is wrong.
  const idErr = 'Error response from daemon: unable to find user nosuchuser: no matching entries in passwd file';
  assert.equal(classify({ code: 1, stdout: 'some real output', stderr: idErr }), null,
    'docker writes nothing to stdout on a daemon refusal');
  assert.equal(classify({ code: 2, stdout: '', stderr: idErr }), null, 'and it is always exit 1');
  assert.equal(classify({ code: 1, stdout: '', stderr: `warning: x\n${idErr}` }), null,
    'the daemon prefix must OPEN stderr, not merely appear in it');
});

// ── P10: reachability ────────────────────────────────────────────────

// Drives the real `reachability` against a docker invocation that CANNOT exist,
// plus a stub CLI written to a temp file for the outcomes that need a daemon.
// A shell script is the cheapest way to make the real spawn path — argv, exit
// code, stream separation — part of what is under test.


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
  // WITH AN IDENTITY CONFIGURED, so the guard covers the path that now builds a
  // second flag as well.
  await tr.reachability(WITH_USER);
  await tr.reap(WITH_USER, { pid: 1, token: 'tok', remoteId: 'r1' });
  const argv = await stub.argv();
  const subcommands = argv.filter(a => ALLOWED_SUBCOMMANDS.includes(a) || ['start', 'stop', 'run', 'rm'].includes(a));
  assert.deepEqual([...new Set(subcommands)].sort(), ['exec', 'inspect']);
  // The reap script carries the exec's token so it can find that exec's own
  // processes, and does NOT carry it as an `-e` flag (which would make the reap
  // match and kill itself).
  assert.ok(argv.some(a => a.includes('CC_EXEC_TOKEN=tok')), 'the reap scans for this token');
  assert.equal(argv.includes('-e'), false, 'the reap exec must not carry the token in its own environment');

  // AND THE IDENTITY DOES NOT LEAK INTO THE DAEMON QUERY. `docker inspect` never
  // enters the container and has no `-u` flag at all: a mutant that "helpfully"
  // passed the remote's identity here would refuse every card render.
  const inspectOnly = await stubCli(t, { stdout: 'true sha256:x 2026-01-01T00:00:00Z\n' });
  await createDockerTransport({ cli: inspectOnly.cli }).reachability(WITH_USER);
  const iargv = await inspectOnly.argv();
  assert.equal(iargv[0], 'inspect');
  assert.equal(iargv.includes('-u'), false, `inspect must carry no -u: ${JSON.stringify(iargv)}`);
  assert.equal(iargv.includes('node'), false, 'nor the identity in any other position');
});

// PINS THE MUST-3 LEAK the relay exists to prevent. The reap script `kill -9`s
// by uid ownership, so it must run as the SAME identity the exec did; relaying
// as the image default would silently fail to kill a subtree owned by a
// different user and report a clean shutdown. Measured: an unprivileged reap is
// NOT blind (`CCREAP ok 0 1`) — a process can always read its own environ — so
// carrying `-u` costs the relay nothing.
test('reap relays through the configured identity, and omits -u when there is none', async (t) => {
  const withUser = await stubCli(t, { execStdout: 'CCREAP ok 1 4\n' });
  await createDockerTransport({ cli: withUser.cli }).reap(WITH_USER, { token: 'tok', remoteId: 'r1' });
  const a = await withUser.argv();
  assert.notEqual(runIndex(a, ['exec', '-u', 'node', '--', 'app']), -1,
    `the relay must run as the remote's identity; got ${JSON.stringify(a.slice(0, 6))}`);

  const without = await stubCli(t, { execStdout: 'CCREAP ok 1 4\n' });
  await createDockerTransport({ cli: without.cli }).reap(CONFIG, { token: 'tok', remoteId: 'r1' });
  const b = await without.argv();
  assert.notEqual(runIndex(b, ['exec', '--', 'app']), -1, 'and a remote without one carries no flag');
  assert.equal(b.includes('-u'), false);
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

  // (a2) the identity is guarded the same way, and reaches docker as `-u`'s
  //      VALUE — two argv elements, so a leading dash is consumed rather than
  //      parsed. The validator refuses one anyway, which is the belt.
  assert.equal(createDockerTransport({ cli: ['docker'] }).validateConfig(
    { container: 'app', user: '-v /:/host' }).ok, false);
  const u = plan({}, { container: 'app', user: 'node' });
  assert.equal(u.args[u.args.indexOf('-u') + 1], 'node');
  assert.equal(u.args.filter(a => a === '-u').length, 1, 'one -u flag, its own argv element');

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

  // (d) the `-e` inherit path passes the flag and its value as TWO argv
  //     elements, which is what makes a leading dash in the value inert —
  //     docker consumes it as `-e`'s operand, never as an option of its own.
  //     Confirmed live: `docker exec -e '--chdir=/tmp=x' -w / -- <ctr> pwd` → `/`.
  //     Asserted on the pairs themselves: a mutant emitting `-eCC_REMOTE=r1` or
  //     `'-e CC_REMOTE=r1'` as one joined token reds all three of these.
  const e = plan({ env: null });
  assert.equal(e.args.filter(a => a === '-e').length, 2, 'two -e flags, each its own argv element');
  assert.deepEqual(e.args.filter(a => a.startsWith('-e') && a !== '-e'), [],
    'and never joined onto its value');
  assert.deepEqual(
    e.args.flatMap((a, k) => (a === '-e' ? [e.args[k + 1]] : [])),
    ['CC_REMOTE=r1', 'CC_EXEC_TOKEN=tok'],
    'each -e is followed by its whole NAME=VALUE pair');
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

// PINS THE FALL-THROUGH ITSELF, which the composition test above does not
// reach. A mutant that leaves `candidates()` correct and breaks the traversal —
// returning after the first probe regardless — reproduces the silent-skip
// hazard exactly: on a host whose bare `docker` cannot reach the socket, the
// live suite would skip while `npm test` stayed green.
test('the gate falls THROUGH a candidate that no daemon answers to the next one', async (t) => {
  const { firstReachable } = await import('./dockerFixture.mjs');
  const dead = await stubCli(t, { exitCode: 1, stderr: 'permission denied while trying to connect\n' });
  const alive = await stubCli(t, { stdout: '29.7.2\n' });

  const found = await firstReachable([dead.cli, alive.cli]);
  assert.ok(found, 'a dead first candidate must not end the search');
  assert.deepEqual(found.cli, alive.cli);
  assert.equal(found.serverVersion, '29.7.2');
  assert.equal((await dead.argv()).length > 0, true, 'and the dead one really was tried first');

  // It stops at the first ANSWER, so the fallback is not a second probe every
  // run pays for.
  const second = await stubCli(t, { stdout: '1.2.3\n' });
  assert.deepEqual((await firstReachable([alive.cli, second.cli])).serverVersion, '29.7.2');
  assert.deepEqual(await second.argv(), [], 'the second candidate is never probed once the first answers');

  // And nothing answering is null, not a lucky last value.
  const dead2 = await stubCli(t, { exitCode: 1 });
  assert.equal(await firstReachable([dead.cli, dead2.cli]), null);
  assert.equal(await firstReachable([]), null);
});

// PINS that the memo is keyed on the override, not global. A mutant memoising
// outright answers the first invocation for every later one, which on a host
// with a working fallback silently pins the whole suite to one CLI.
test('resolveDockerCli answers per CODE_SYSTEM_DOCKER value, not once for the process', async (t) => {
  const { resolveDockerCli } = await import('./dockerFixture.mjs');
  const a = await stubCli(t, { stdout: '29.7.2\n' });
  const b = await stubCli(t, { stdout: '28.0.1\n' });

  const first = await resolveDockerCli({ [DOCKER_ENV]: JSON.stringify(a.cli) });
  assert.deepEqual(first.cli, a.cli);
  assert.equal(first.serverVersion, '29.7.2');

  const second = await resolveDockerCli({ [DOCKER_ENV]: JSON.stringify(b.cli) });
  assert.deepEqual(second.cli, b.cli, 'a different override must be probed, not served from the memo');
  assert.equal(second.serverVersion, '28.0.1');
});
