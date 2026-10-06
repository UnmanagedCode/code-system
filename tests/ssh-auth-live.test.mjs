// EXPLICIT CREDENTIALS AGAINST A REAL SSHD: a card's own password or private
// key file, with NO ssh config identity and NO agent to fall back on.
//
// Every test builds its transport over `bareSshConfig` — a known_hosts and
// nothing else — and addresses the target by its bridge IP, so the only thing
// that can authenticate is the credential the card carries. Gated and counted
// exactly like tests/ssh-live.test.mjs: ALL ran or ALL skipped.
//
//   CODE_SYSTEM_DOCKER='["sudo","-n","docker"]' npm test    # runs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { controlDir, controlPathFor, createSshTransport } from '../src/launcher/kinds/ssh.mjs';
import { makeRunner } from '../src/launcher/run.mjs';
import {
  authCount, bareSshConfig, controlPathProcs, resolveSshGate, run, setPassword, skipUnlessSsh,
  withSshTarget,
} from './sshFixture.mjs';

const PASSWORD = 'live pw \'quoted\' $x';
// Well inside connect's own bound, so "fails cleanly" is not "waited out the timeout".
const FAST_MS = 10_000;

const ROSTER = [];
const live = (name, fn) => ROSTER.push({ name, fn });

/** A target that accepts passwords for `dev`, plus a transport that can use nothing but the card. */
async function credentialTarget(t, g) {
  const target = await withSshTarget(t, g, { allowPassword: true });
  await setPassword(g.cli, target.name, 'dev', PASSWORD);
  const bare = await bareSshConfig(target.dir, target.knownHosts);
  const transport = createSshTransport({ cli: [...g.ssh, '-F', bare] });
  const closing = (config) => t.after(() => transport.disconnect(config).catch(() => {}));
  return { target, bare, transport, closing };
}

const exec = (transport, config, script) => makeRunner(transport, config, 'alpha')({ script });

// Every host process whose argv contains `needle`. /proc is world-readable here,
// which is exactly why a password in argv would be a leak.
async function procsNaming(needle) {
  const hits = [];
  for (const d of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let raw;
    try { raw = await fs.readFile(path.join('/proc', d, 'cmdline'), 'utf8'); } catch { continue; }
    if (raw.includes(needle)) hits.push(raw.split('\0').join(' '));
  }
  return hits;
}

// PINS password-only login end to end: a card carrying {host: <ip>, user,
// password} connects and execs with no ssh config identity, sshd logs a PASSWORD
// acceptance (not a key), and the password is in no process's argv.
live('a password-only remote connects and runs, and the password is in no argv', async (t, g) => {
  const { target, transport, closing } = await credentialTarget(t, g);
  const config = { host: target.ip, user: 'dev', password: PASSWORD };
  closing(config);
  // The fixture's own readiness probe already logged one root publickey login.
  const keysBefore = await authCount(g.cli, target.name, 'publickey');
  const conn = await transport.connect(config);
  assert.ok(conn.controlPath);
  const res = await exec(transport, config, 'id -un');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.toString().trim(), 'dev');
  assert.equal(await authCount(g.cli, target.name, 'password for dev'), 1,
    'sshd accepted a PASSWORD, once, for the shared master');
  assert.equal(await authCount(g.cli, target.name, 'publickey'), keysBefore, 'and no key could have got in');
  const master = await controlPathProcs(controlPathFor(config));
  assert.equal(master.count, 1);
  assert.deepEqual(await procsNaming('live pw'), [], 'the password is never in a host process argv');
});

// PINS key-file-only login: the card's own key is offered and accepted while the
// config holds no IdentityFile and no agent.
live('a key-file-only remote connects and runs', async (t, g) => {
  const { target, transport, closing } = await credentialTarget(t, g);
  const config = { host: target.ip, user: 'root', identityFile: target.key };
  closing(config);
  const keysBefore = await authCount(g.cli, target.name, 'publickey for root');
  await transport.connect(config);
  const res = await exec(transport, config, 'id -un');
  assert.equal(res.stdout.toString().trim(), 'root');
  assert.equal(await authCount(g.cli, target.name, 'publickey for root'), keysBefore + 1,
    'one key login, for the shared master');
  assert.equal(await authCount(g.cli, target.name, 'password'), 0);
});

// PINS clean failure for a wrong password: connect rejects well inside its
// bound with the refusal, leaves no process on the ControlPath, and an exec
// with no master classifies as the credential-aware EUNKNOWN.
live('a wrong password fails fast, leaves nothing running, and classifies as an auth refusal', async (t, g) => {
  const { target, transport } = await credentialTarget(t, g);
  const config = { host: target.ip, user: 'dev', password: 'definitely wrong' };
  const started = Date.now();
  await assert.rejects(() => transport.connect(config), /Permission denied/);
  assert.ok(Date.now() - started < FAST_MS, `took ${Date.now() - started} ms`);
  assert.equal((await controlPathProcs(controlPathFor(config))).count, 0);
  await assert.rejects(() => exec(transport, config, 'true'), (e) => {
    assert.equal(e.code, 'EUNKNOWN');
    assert.match(e.message, /password stored on this remote/);
    return true;
  });
});

// PINS the same for a key the server does not know — and that an encrypted /
// unauthorized key never prompts.
live('an unauthorized key fails fast, leaves nothing running, and names the key file', async (t, g) => {
  const { target, transport } = await credentialTarget(t, g);
  const other = path.join(target.dir, 'other');
  assert.equal((await run(['ssh-keygen', '-t', 'ed25519', '-N', '', '-f', other, '-q'])).code, 0);
  const config = { host: target.ip, user: 'root', identityFile: other };
  const started = Date.now();
  await assert.rejects(() => transport.connect(config), /Permission denied/);
  assert.ok(Date.now() - started < FAST_MS);
  assert.equal((await controlPathProcs(controlPathFor(config))).count, 0);
  await assert.rejects(() => exec(transport, config, 'true'), (e) => {
    assert.equal(e.code, 'EUNKNOWN');
    assert.match(e.message, /key file/);
    return true;
  });
});

// PINS that an unknown host key on the password path fails FAST with ssh's own
// refusal wording and leaves nothing running. (That the askpass helper declines
// non-password prompts is pinned in tests/sshauth.test.mjs, not here.)
live('on the password path an unknown host key fails fast with the host-key refusal', async (t, g) => {
  const { target } = await credentialTarget(t, g);
  const empty = path.join(target.dir, 'empty_known_hosts');
  await fs.writeFile(empty, '');
  const bare = await bareSshConfig(target.dir, empty);
  const transport = createSshTransport({ cli: [...g.ssh, '-F', bare] });
  const config = { host: target.ip, user: 'dev', password: PASSWORD };
  const started = Date.now();
  await assert.rejects(() => transport.connect(config), /Host key verification failed/);
  assert.ok(Date.now() - started < FAST_MS);
  assert.equal((await controlPathProcs(controlPathFor(config))).count, 0);
});

// PINS that a remote with NO credentials keys its master exactly as before this
// feature (user NUL host), and still connects through the operator's alias.
live('an alias-only remote keeps the pre-credentials ControlPath', async (t, g) => {
  const target = await withSshTarget(t, g);
  const old = path.join(controlDir(), createHash('sha256')
    .update(`${target.config.user}\0${target.config.host}`).digest('hex').slice(0, 20));
  assert.equal(controlPathFor(target.config), old);
  const transport = target.transport();
  await transport.connect(target.config);
  await fs.lstat(old);
});

// ── registration, and the count proof ────────────────────────────────

let ran = 0;
for (const item of ROSTER) {
  test(`live: ${item.name}`, async (t) => {
    const g = await skipUnlessSsh(t);
    if (!g) return;
    await item.fn(t, g);
    ran += 1;
  });
}

// PINS that a closed gate cannot masquerade as a green run, in both directions
// (the same proof as tests/ssh-live.test.mjs).
test('the live ssh-auth roster ALL ran or ALL skipped, and it is not empty', async () => {
  const g = await resolveSshGate();
  assert.ok(ROSTER.length > 0);
  assert.equal(new Set(ROSTER.map(r => r.name)).size, ROSTER.length, 'no duplicate roster names');
  assert.equal(ran, g ? ROSTER.length : 0, `ran ${ran}/${ROSTER.length}`);
});
