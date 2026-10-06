// THE `port` OF AN SSH REMOTE AGAINST A REAL SSHD listening on a non-22 port.
//
// The server port is asserted from the FAR side — the 4th field of
// $SSH_CONNECTION — so "it connected" can never mean "it connected on the wrong
// port". Gated and counted exactly like tests/ssh-auth-live.test.mjs: ALL ran or
// ALL skipped.
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
  authCount, bareSshConfig, controlPathProcs, resolveSshGate, setPassword, skipUnlessSsh,
  withSshTarget,
} from './sshFixture.mjs';

const PASSWORD = 'live port pw \'quoted\' $x';
// Well inside connect's own bound, so "fails cleanly" is not "waited out the timeout".
const FAST_MS = 10_000;

const ROSTER = [];
const live = (name, fn) => ROSTER.push({ name, fn });

const exec = (transport, config, script) => makeRunner(transport, config, 'alpha')({ script });
/** The port the SERVER accepted this connection on, read from the far side. */
async function serverPort(transport, config) {
  const res = await exec(transport, config, 'printf %s "$SSH_CONNECTION"');
  assert.equal(res.code, 0, res.stderr);
  return res.stdout.toString().trim().split(' ')[3];
}
const closing = (t, transport, config) => t.after(() => transport.disconnect(config).catch(() => {}));

// PINS the headline: an alias with NO Port plus a card port reaches an sshd that
// listens on that port only — one master, one key login, server port 2222.
live('a card port reaches an sshd on that port through an alias without a Port', async (t, g) => {
  const target = await withSshTarget(t, g, { ports: [2222] });
  const transport = target.transport();
  closing(t, transport, target.config);
  const before = await authCount(g.cli, target.name, 'publickey');
  await transport.connect(target.config);
  assert.equal(await serverPort(transport, target.config), '2222');
  assert.equal((await controlPathProcs(controlPathFor(target.config))).count, 1);
  assert.equal(await authCount(g.cli, target.name, 'publickey'), before + 1);
});

// PINS the default: with no card port ssh's own resolution stands, so the
// alias's `Port` is honoured, no `-p` reaches the master, and the ControlPath is
// the pre-port formula.
live('an unset port honours the alias Port and keeps the pre-port ControlPath', async (t, g) => {
  const target = await withSshTarget(t, g, { ports: [2222], extraConfig: ['  Port 2222'] });
  const config = { host: target.alias, user: 'root' };
  const transport = target.transport();
  closing(t, transport, config);
  const old = path.join(controlDir(), createHash('sha256').update(`root\0${target.alias}`).digest('hex').slice(0, 20));
  assert.equal(controlPathFor(config), old);
  await transport.connect(config);
  assert.equal(await serverPort(transport, config), '2222');
  const master = await controlPathProcs(old);
  assert.equal(master.count, 1);
  assert.equal(master.cmdlines[0].split(' ').includes('-p'), false, master.cmdlines[0]);
});

// PINS precedence: a card port overrides the alias's own `Port` (here one that
// nothing listens on).
live('a card port beats the alias Port', async (t, g) => {
  const target = await withSshTarget(t, g, { ports: [2222], extraConfig: ['  Port 1'] });
  const transport = target.transport();
  closing(t, transport, target.config);
  await transport.connect(target.config);
  assert.equal(await serverPort(transport, target.config), '2222');
});

// PINS key-file + port on a bare IP: the card's key and port are all there is,
// and no password acceptance happens.
live('a key file composes with a port', async (t, g) => {
  const target = await withSshTarget(t, g, { ports: [2222] });
  const bare = await bareSshConfig(target.dir, target.knownHosts);
  const transport = createSshTransport({ cli: [...g.ssh, '-F', bare] });
  const config = { host: target.ip, user: 'root', identityFile: target.key, port: 2222 };
  closing(t, transport, config);
  await transport.connect(config);
  assert.equal(await serverPort(transport, config), '2222');
  assert.equal(await authCount(g.cli, target.name, 'password'), 0);
});

// PINS password + port on a bare IP: sshd logs one password acceptance and the
// password is in no host process's argv.
live('a password composes with a port', async (t, g) => {
  const target = await withSshTarget(t, g, { ports: [2222], allowPassword: true });
  await setPassword(g.cli, target.name, 'dev', PASSWORD);
  const bare = await bareSshConfig(target.dir, target.knownHosts);
  const transport = createSshTransport({ cli: [...g.ssh, '-F', bare] });
  const config = { host: target.ip, user: 'dev', password: PASSWORD, port: 2222 };
  closing(t, transport, config);
  await transport.connect(config);
  assert.equal(await serverPort(transport, config), '2222');
  assert.equal(await authCount(g.cli, target.name, 'password for dev'), 1);
  for (const d of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let raw;
    try { raw = await fs.readFile(path.join('/proc', d, 'cmdline'), 'utf8'); } catch { continue; }
    assert.equal(raw.includes('live port pw'), false, `the password is in argv: ${raw.split('\0').join(' ')}`);
  }
});

// PINS a wrong port: connect rejects fast naming that port, leaves no process on
// the ControlPath, and an exec with no master is ENOREMOTE naming it too.
live('a wrong port fails fast, names the port and leaves nothing running', async (t, g) => {
  const target = await withSshTarget(t, g, { ports: [2222] });
  const transport = target.transport();
  const config = { ...target.config, port: 2223 };
  const started = Date.now();
  await assert.rejects(() => transport.connect(config), /port 2223: Connection refused/);
  assert.ok(Date.now() - started < FAST_MS, `took ${Date.now() - started} ms`);
  assert.equal((await controlPathProcs(controlPathFor(config))).count, 0);
  await assert.rejects(() => exec(transport, config, 'true'), (e) => {
    assert.equal(e.code, 'ENOREMOTE');
    assert.match(e.message, /port 2223/);
    return true;
  });
});

// PINS that the port splits the master: the same user@host unset (22) and on
// 2222 gets two ControlPaths, two masters, and each exec lands on its own port.
live('the same user@host on two ports gets two masters', async (t, g) => {
  const target = await withSshTarget(t, g, { ports: [22, 2222] });
  const transport = target.transport();
  const unset = { host: target.alias, user: 'root' };
  const set = { ...unset, port: 2222 };
  closing(t, transport, unset);
  closing(t, transport, set);
  assert.notEqual(controlPathFor(unset), controlPathFor(set));
  await transport.connect(unset);
  await transport.connect(set);
  assert.equal((await controlPathProcs(controlPathFor(unset))).count, 1);
  assert.equal((await controlPathProcs(controlPathFor(set))).count, 1);
  assert.equal(await serverPort(transport, unset), '22');
  assert.equal(await serverPort(transport, set), '2222');
});

// PINS how ssh keys known_hosts by port (MEASURED, not assumed): a `[host]:port`
// entry satisfies only that port, while a bare `host` entry satisfies any port.
live('known_hosts: a [host]:port entry covers only its port, a bare host entry any', async (t, g) => {
  const target = await withSshTarget(t, g, { ports: [22, 2222] });
  const only = path.join(target.dir, 'kh_port_only');
  await fs.writeFile(only, `[${target.ip}]:2222 ${target.hostKey}\n`);
  const portOnly = createSshTransport({ cli: [...g.ssh, '-F', await bareSshConfig(target.dir, only)] });
  const key = { host: target.ip, user: 'root', identityFile: target.key };
  closing(t, portOnly, { ...key, port: 2222 });
  await portOnly.connect({ ...key, port: 2222 });
  await assert.rejects(() => portOnly.connect(key), /Host key verification failed/);
  await assert.rejects(() => exec(portOnly, key, 'true'), (e) => {
    assert.equal(e.code, 'EUNKNOWN');
    assert.match(e.message, /host key/);
    return true;
  });

  const bareEntry = path.join(target.dir, 'kh_bare_entry');
  await fs.writeFile(bareEntry, `${target.ip} ${target.hostKey}\n`);
  const bareOnly = createSshTransport({ cli: [...g.ssh, '-F', await bareSshConfig(target.dir, bareEntry)] });
  closing(t, bareOnly, { ...key, port: 2222 });
  await bareOnly.connect({ ...key, port: 2222 });
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
test('the live ssh-port roster ALL ran or ALL skipped, and it is not empty', async () => {
  const g = await resolveSshGate();
  assert.ok(ROSTER.length > 0);
  assert.equal(new Set(ROSTER.map(r => r.name)).size, ROSTER.length, 'no duplicate roster names');
  assert.equal(ran, g ? ROSTER.length : 0, `ran ${ran}/${ROSTER.length}`);
});
