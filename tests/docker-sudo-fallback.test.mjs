// End to end through the real launcher: with CODE_SYSTEM_DOCKER unset and a PATH
// holding a stub `docker` (denied the socket unless privileged) and a stub `sudo`
// (drops -n, runs the rest privileged), the launcher must resolve `sudo -n
// docker` before serving and run per-command execs through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Launcher, record, tempStore, writeRecord } from './helpers.mjs';

const DOCKER_STUB = `#!/bin/sh
echo "priv=$FAKE_DOCKER_PRIV $*" >> "$STUB_LOG"
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

// Invariant: main.mjs awaits Transport.ready() before reading frames, and every
// per-command exec uses the resolved (sudo) invocation, not bare docker.
test('the launcher resolves sudo -n docker before serving and execs through it', async (t) => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-sudo-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'calls.log');
  for (const [name, body] of [['docker', DOCKER_STUB], ['sudo', SUDO_STUB]]) {
    await fs.writeFile(path.join(bin, name), body, { mode: 0o755 });
  }
  const store = await tempStore();
  t.after(() => store.cleanup());
  await writeRecord(store.dir, record('app', { kind: 'docker', config: { container: 'app' }, enabled: true }));

  // `undefined` UNSETS it (the Launcher helper pins it otherwise).
  const l = new Launcher(['--kind', 'docker'], {
    CODE_SYSTEM_DOCKER: undefined,
    CODE_SYSTEM_STORE: store.dir,
    CODE_SYSTEM_CHANNEL: '0',
    PATH: `${bin}:${process.env.PATH}`,
    STUB_LOG: log,
  });
  t.after(() => l.kill());
  await l.hello();

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
