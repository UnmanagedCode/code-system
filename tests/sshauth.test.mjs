// EXPLICIT CREDENTIALS on an ssh remote: a password or a private key file.
// Deterministic — no ssh, no docker: `spawnPlan` is pure and everything that
// would invoke ssh goes through a stub. The live proof is
// tests/ssh-auth-live.test.mjs.
//
// Every string quoted as ssh's own output was MEASURED against OpenSSH_10.0p2
// (.wiki/gotchas/ssh-controlmaster-transport.md §13).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ASKPASS_HELPER, controlPathFor, createSshTransport, sshAuth, sshBaseArgs,
} from '../src/launcher/kinds/ssh.mjs';
import { stubSshCli } from './helpers.mjs';

const PW = 'pa ss"w0rd\'$x ';
const PASSWORD_CONFIG = { host: '10.1.2.3', user: 'dev', password: PW };
const KEY_CONFIG = { host: '10.1.2.3', user: 'root', identityFile: '/keys/id' };
const AMBIENT = { host: 'box', user: 'me' };

const validate = (raw) => createSshTransport({ cli: ['ssh'] }).validateConfig(raw);
const req = () => ({
  argv: ['git', 'status'], shell: null, cwd: '/w', env: null, stdinMode: 'ignore', remoteId: 'r1', token: 'tok',
});

async function withTmpdir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-sshauth-'));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  t.after(async () => {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const runAskpass = (prompt, env) => new Promise((resolve) => {
  const c = spawn(ASKPASS_HELPER, [prompt], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  c.stdout.on('data', b => out.push(b));
  c.on('close', code => resolve({ code, stdout: Buffer.concat(out).toString('utf8') }));
});

// ── validateConfig ───────────────────────────────────────────────────

// PINS the accepted shapes, and that a password is kept VERBATIM — edge spaces are part of it.
test('validateConfig accepts a password or a key file, and keeps a password untrimmed', () => {
  assert.deepEqual(validate(PASSWORD_CONFIG).config, PASSWORD_CONFIG);
  assert.deepEqual(validate(KEY_CONFIG).config, KEY_CONFIG);
  assert.deepEqual(validate({ host: 'box' }).config, { host: 'box' }, 'no credentials: no new keys');
  assert.equal(validate({ host: 'h', password: '  lead and trail  ' }).config.password, '  lead and trail  ');
});

// PINS the refusals that keep a credential from becoming argv injection, an
// ssh-expanded path, or a multi-line askpass answer.
test('validateConfig refuses both credentials, a bad key path and a bad password', () => {
  const bad = (raw, re) => {
    const v = validate(raw);
    assert.equal(v.ok, false, JSON.stringify(raw));
    assert.match(v.error, re);
  };
  bad({ host: 'h', password: 'x', identityFile: '/k' }, /not both/);
  bad({ host: 'h', identityFile: 'relative/key' }, /absolute/);
  bad({ host: 'h', identityFile: '/k/%u' }, /'%' or '\$'/);
  bad({ host: 'h', identityFile: '/k/${HOME}' }, /'%' or '\$'/);
  bad({ host: 'h', identityFile: '/k/a\nb' }, /control/);
  bad({ host: 'h', password: 'a\nb' }, /newline/);
  bad({ host: 'h', password: 'a\rb' }, /newline/);
  bad({ host: 'h', password: 'a\0b' }, /newline|NUL/);
  bad({ host: 'h', password: '' }, /non-empty/);
  bad({ host: 'h', password: 5 }, /non-empty string/);
});

// ── argv and env ─────────────────────────────────────────────────────

// PINS that a record WITHOUT credentials spawns byte-identically to before this
// feature: no env, no auth args, BatchMode=yes.
test('no credentials: argv is the pre-existing one and env is undefined', async (t) => {
  await withTmpdir(t);
  const p = createSshTransport({ cli: ['ssh'] }).spawnPlan(AMBIENT, req());
  assert.deepEqual(p.args.slice(0, 11), [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', `ControlPath=${controlPathFor(AMBIENT)}`,
    '-o', 'ControlMaster=no', '-o', 'ControlPersist=600',
  ]);
  assert.equal(p.args[11], '--', 'no auth args between the shared block and the terminator');
  assert.equal(p.env, undefined);
  assert.deepEqual(sshAuth(AMBIENT, {}), { args: [], env: undefined });
});

// PINS the password transport: BatchMode off (it would disable askpass), one
// attempt, password-shaped methods only, askpass forced to an absolute
// executable helper — and THE PASSWORD NEVER IN ARGV, only in the child env.
test('password: BatchMode=no, askpass env with an executable helper, and no password in argv', async (t) => {
  await withTmpdir(t);
  const p = createSshTransport({ cli: ['ssh'], env: { PATH: '/bin' } }).spawnPlan(PASSWORD_CONFIG, req());
  assert.ok(p.args.includes('BatchMode=no'));
  assert.equal(p.args.includes('BatchMode=yes'), false);
  assert.ok(p.args.includes('NumberOfPasswordPrompts=1'));
  assert.ok(p.args.includes('PreferredAuthentications=password,keyboard-interactive'));
  assert.equal(p.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(p.env.CODE_SYSTEM_SSH_PASSWORD, PW);
  assert.equal(p.env.PATH, '/bin', 'the injected base environment is carried through');
  assert.ok(path.isAbsolute(p.env.SSH_ASKPASS));
  await fs.access(p.env.SSH_ASKPASS, fs.constants.X_OK);
  assert.equal(JSON.stringify(p.args).includes('pa ss'), false, 'the password never reaches argv');
  assert.equal(p.args.at(-1).includes('pa ss'), false, 'nor the remote command');
});

// PINS the key transport: only the card's key is offered, BatchMode stays on
// (an encrypted key fails fast instead of prompting), and no env is needed.
test('key file: -i, IdentitiesOnly, publickey only, BatchMode=yes, no env', async (t) => {
  await withTmpdir(t);
  const p = createSshTransport({ cli: ['ssh'] }).spawnPlan(KEY_CONFIG, req());
  const i = p.args.indexOf('-i');
  assert.equal(p.args[i + 1], '/keys/id');
  assert.ok(p.args.includes('IdentitiesOnly=yes'));
  assert.ok(p.args.includes('PreferredAuthentications=publickey'));
  assert.ok(p.args.includes('BatchMode=yes'));
  assert.equal(p.env, undefined);
  assert.ok(i < p.args.indexOf('--'), '-i is an option, before the terminator');
});

// PINS that BatchMode is emitted once, by the one builder, and only a password remote turns it off.
test('sshBaseArgs: BatchMode follows the credential', () => {
  const batch = (config) => sshBaseArgs('/s', { master: 'no', config }).filter(a => a.startsWith('BatchMode='));
  assert.deepEqual(batch(undefined), ['BatchMode=yes']);
  assert.deepEqual(batch(AMBIENT), ['BatchMode=yes']);
  assert.deepEqual(batch(KEY_CONFIG), ['BatchMode=yes']);
  assert.deepEqual(batch(PASSWORD_CONFIG), ['BatchMode=no']);
});

// ── the ControlPath ──────────────────────────────────────────────────

// PINS that an ambient master is never reused to "prove" a credential, that the
// no-credentials path is untouched, and that the password VALUE is not keyed.
test('controlPathFor: credentials split the identity, a password value does not', () => {
  const base = { host: 'h', user: 'u' };
  const ambient = controlPathFor(base);
  const pw1 = controlPathFor({ ...base, password: 'one' });
  const pw2 = controlPathFor({ ...base, password: 'two' });
  const key = controlPathFor({ ...base, identityFile: '/k/id' });
  assert.equal(new Set([ambient, pw1, key]).size, 3);
  assert.equal(pw1, pw2);
  assert.notEqual(key, controlPathFor({ ...base, identityFile: '/k/other' }));
  assert.match(ambient, /[0-9a-f]{20}$/);
});

// ── the askpass helper ───────────────────────────────────────────────

// PINS that the helper answers ONLY password prompts: a host-key confirmation
// or a key passphrase gets exit 1 and no output, so ssh fails instead of hanging.
test('askpass helper: answers a password prompt and declines every other', async () => {
  const env = { PATH: process.env.PATH, CODE_SYSTEM_SSH_PASSWORD: PW };
  const ok = await runAskpass("dev@1.2.3.4's password: ", env);
  assert.deepEqual(ok, { code: 0, stdout: `${PW}\n` });
  const hostkey = await runAskpass(
    "The authenticity of host '1.2.3.4 (1.2.3.4)' can't be established.\nED25519 key fingerprint is SHA256:x.\n"
    + 'This key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ', env);
  assert.deepEqual(hostkey, { code: 1, stdout: '' });
  assert.deepEqual(await runAskpass('Enter passphrase for key \'/k/id\': ', env), { code: 1, stdout: '' });
});

// ── through the stub: every invocation carries both halves ───────────

// PINS that connect, reachability, disconnect and reap each go through the one
// funnel — a call site that forgot the env or the options would silently fall
// back to BatchMode=yes and fail with no usable message.
test('every ssh invocation of a password remote carries the auth args and env', async (t) => {
  await withTmpdir(t);
  const stub = await stubSshCli(t, { master: true });
  const tr = createSshTransport({ cli: stub.cli, env: { PATH: '/bin' } });
  await tr.connect(PASSWORD_CONFIG);
  await tr.reachability(PASSWORD_CONFIG);
  await tr.reap(PASSWORD_CONFIG, { token: 'tok', remoteId: 'r' }).catch(() => {});
  await tr.disconnect(PASSWORD_CONFIG);

  const argv = await stub.argv();
  const [versionProbe, ...dials] = await stub.envs();
  // -V, then pre-check, master, proving check, reachability, reap, disconnect.
  assert.equal(dials.length, 6);
  assert.match(versionProbe, /REQUIRE= ASKPASS= PW=$/, 'the version probe needs no credential');
  const helper = ASKPASS_HELPER.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (const l of dials) assert.match(l, new RegExp(`^REQUIRE=force ASKPASS=${helper} PW=${PW.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.equal(argv.filter(a => a === 'BatchMode=no').length, 6, 'six ssh dials, each BatchMode=no');
  assert.equal(argv.filter(a => a === 'BatchMode=yes').length, 0);
  assert.equal(argv.filter(a => a === 'NumberOfPasswordPrompts=1').length, 6);
});

// PINS the version gate: an OpenSSH older than 8.4 would ignore
// SSH_ASKPASS_REQUIRE, so connect refuses in words and dials NOTHING.
test('connect refuses a password remote on OpenSSH older than 8.4, dialling nothing', async (t) => {
  await withTmpdir(t);
  for (const version of ['OpenSSH_8.2p1 Ubuntu-4', 'not ssh at all']) {
    const stub = await stubSshCli(t, { master: true, version });
    await assert.rejects(() => createSshTransport({ cli: stub.cli }).connect(PASSWORD_CONFIG), /8\.4|OpenSSH/);
    assert.deepEqual((await stub.argv()).filter(a => a === '-N' || a === 'check'), [], version);
  }
  const ok = await stubSshCli(t, { master: true, version: 'OpenSSH_8.4p1' });
  await createSshTransport({ cli: ok.cli }).connect(PASSWORD_CONFIG);
});

// PINS the key-file pre-check: a missing or group/world-readable key is refused
// in plain words before any dial (ssh's own banner is not actionable).
test('connect refuses a missing or too-open key file before any dial', async (t) => {
  const dir = await withTmpdir(t);
  const stub = await stubSshCli(t, { master: true });
  const tr = createSshTransport({ cli: stub.cli });
  await assert.rejects(() => tr.connect({ ...KEY_CONFIG, identityFile: path.join(dir, 'nokey') }), /cannot be read/);
  const open = path.join(dir, 'open');
  await fs.writeFile(open, 'k', { mode: 0o644 });
  await fs.chmod(open, 0o644);
  await assert.rejects(() => tr.connect({ ...KEY_CONFIG, identityFile: open }), /mode 0644/);
  assert.deepEqual(await stub.argv(), [], 'nothing was dialled');
  const good = path.join(dir, 'good');
  await fs.writeFile(good, 'k', { mode: 0o600 });
  await tr.connect({ ...KEY_CONFIG, identityFile: good });
});

// ── classifyFailure ──────────────────────────────────────────────────

// PINS the measured wrong-password bytes (CRLF, server's method list) as an
// auth refusal that names the CARD's credential, not ~/.ssh/config.
test('classifyFailure: a measured credential refusal is EUNKNOWN naming the card', () => {
  const stderr = 'dev@172.17.0.3: Permission denied (publickey,password).\r\n';
  const tr = createSshTransport({ cli: ['ssh'] });
  const pw = tr.classifyFailure(PASSWORD_CONFIG, { code: 255, stdout: '', stderr });
  assert.equal(pw.code, 'EUNKNOWN');
  assert.match(pw.message, /password stored on this remote/);
  assert.equal(pw.message.includes(PW), false, 'the password is never quoted');
  const key = tr.classifyFailure(KEY_CONFIG, { code: 255, stdout: '', stderr });
  assert.match(key.message, /key file '\/keys\/id'/);
  const ambient = tr.classifyFailure(AMBIENT, { code: 255, stdout: '', stderr: 'me@box: Permission denied (publickey).\n' });
  assert.match(ambient.message, /ssh config|agent/i);
  // A password-only server lists only `password`.
  assert.equal(tr.classifyFailure(AMBIENT, { code: 255, stdout: '', stderr: 'Permission denied (password).\n' }).code, 'EUNKNOWN');
});
