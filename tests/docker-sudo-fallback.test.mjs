// End to end through the real launcher: with CODE_SYSTEM_DOCKER unset and a PATH
// holding a stub `docker` (denied the socket unless privileged) and a stub `sudo`
// (drops -n, runs the rest privileged), the launcher must resolve `sudo -n
// docker` before serving and run per-command execs through it.
//
// The stub's `version` writes a `probe-started` marker, then blocks until a
// `release` file appears, so a test controls exactly how long the probe takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Launcher, record, tempStore, writeRecord } from './helpers.mjs';

const DOCKER_STUB = `#!/bin/sh
echo "priv=$FAKE_DOCKER_PRIV $*" >> "$STUB_LOG"
if [ "$1" = version ]; then
  : > "$STUB_DIR/probe-started"
  while [ ! -f "$STUB_DIR/release" ]; do sleep 0.05; done
fi
if [ "$FAKE_DOCKER_PRIV" != 1 ]; then
  echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2
  exit 1
fi
case "$1" in
  version) echo 27.0.0 ;;
  exec) shift; while [ "$1" != -- ]; do shift; done; shift; shift; exec "$@" ;;
esac
`;
const SUDO_STUB = `#!/bin/sh
[ "$1" = -n ] && shift
FAKE_DOCKER_PRIV=1 exec "$@"
`;

const exists = (p) => fs.access(p).then(() => true, () => false);
async function until(pred, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise(r => setTimeout(r, 20));
  }
}

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-sudo-bin-'));
  const release = path.join(dir, 'release');
  // Always release at the end, so no stub is left polling.
  t.after(async () => { await fs.writeFile(release, ''); await fs.rm(dir, { recursive: true, force: true }); });
  for (const [name, body] of [['docker', DOCKER_STUB], ['sudo', SUDO_STUB]]) {
    await fs.writeFile(path.join(dir, name), body, { mode: 0o755 });
  }
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('app', { kind: 'docker', config: { container: 'app' }, enabled: true }));
  // `undefined` UNSETS CODE_SYSTEM_DOCKER (the Launcher helper pins it otherwise).
  const l = new Launcher(['--kind', 'docker'], {
    CODE_SYSTEM_DOCKER: undefined,
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_CHANNEL: '0',
    PATH: `${dir}:${process.env.PATH}`,
    STUB_DIR: dir,
    STUB_LOG: path.join(dir, 'calls.log'),
  });
  t.after(() => l.kill());
  return { l, dir, release, marker: path.join(dir, 'probe-started'), log: path.join(dir, 'calls.log') };
}

const helloFrames = (l) => l.frames.filter(f => f.type === 'hello').length;

// Invariant: the launcher holds the hello until the resolve finishes (within the
// readiness budget) — `ready()` is awaited before frames are served — and every
// per-command exec then uses the resolved (sudo) invocation, not bare docker.
test('the launcher waits for the resolve before the hello, then execs through sudo -n docker', async (t) => {
  const { l, release, marker, log } = await setup(t);
  l.send({ type: 'hello', protocol: 1, client: 'code-conductor' });
  await until(() => exists(marker));

  await new Promise(r => setTimeout(r, 300));
  assert.equal(helloFrames(l), 0, 'no hello while the probe is still running');

  await fs.writeFile(release, '');
  await l.waitFor(f => f.type === 'hello');

  l.send({ type: 'exec', id: 'e1', remoteId: 'app', cwd: '/', argv: ['/bin/echo', 'hi'] });
  const exit = await l.waitFor(f => f.type === 'exit' && f.id === 'e1');
  assert.equal(exit.code, 0);
  const out = l.frames.filter(f => f.type === 'stdout' && f.id === 'e1')
    .map(f => Buffer.from(f.dataB64, 'base64').toString()).join('');
  assert.equal(out, 'hi\n');

  const lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
  assert.match(lines[0], /^priv= version/, 'the first call is the bare probe, denied');
  assert.ok(lines.some(x => x.startsWith('priv=1 version')), 'then the sudo probe answered');
  const execLine = lines.find(x => / exec /.test(x));
  assert.ok(execLine?.startsWith('priv=1 '), `the exec ran privileged: ${execLine}`);
});

// Invariant: a probe that hangs past the readiness budget does NOT hold the
// hello forever (cc's handshake deadline is 10 s) — the hello is answered while
// the probe is still blocked.
test('the hello is still answered when the probe outlasts the readiness budget', async (t) => {
  const { l, release, marker } = await setup(t);
  l.send({ type: 'hello', protocol: 1, client: 'code-conductor' });
  await until(() => exists(marker));
  await l.waitFor(f => f.type === 'hello', { timeoutMs: 6_000 });
  assert.equal(await exists(release), false, 'the probe was never released: the hello did not wait for it');
});
