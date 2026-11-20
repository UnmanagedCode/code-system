// The `agent` kind's PURE half: its plans, its config validation and its
// failure vocabulary. No broker, no agent — what these pin is what the core is
// handed, so a regression shows here before it shows on a live remote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTransport, readMarker } from '../src/launcher/kinds/agent.mjs';
import { keyIdOf } from '../src/agent/protocol.mjs';
import { BRIDGE_MAIN } from '../src/paths.mjs';
import { FS_ERROR_CODES } from '../src/launcher/protocol.mjs';

const SECRET = 'Q'.repeat(20) + '_-' + 'z'.repeat(21);
const CONFIG = { secret: SECRET };
const k = createAgentTransport();
const req = (over = {}) => ({
  argv: ['ls', '-la'], shell: null, cwd: '/srv', env: null, stdinMode: 'ignore', remoteId: 'box', token: 'tok123', ...over,
});
const afterDashes = args => args.slice(args.indexOf('--') + 1);

// PINS: the secret is in NO plan's argv — /proc/<pid>/cmdline is world-readable
// — and the key id that stands in for it is.
test('no plan carries the secret; every plan carries its key id', () => {
  const plans = [
    k.spawnPlan(CONFIG, req()),
    k.spawnPlan(CONFIG, req({ env: { A: 'b' }, stdinMode: 'pipe', shell: 'echo hi', argv: null })),
    k.channelPlan(CONFIG, { remoteId: 'box' }),
    k.ptyPlan(CONFIG, { command: ['/bin/sh', '-c', 'x'], token: 't', remoteId: 'box' }),
  ];
  for (const p of plans) {
    assert.equal(p.file, process.execPath);
    assert.equal(p.args[0], BRIDGE_MAIN);
    assert.equal(JSON.stringify(p).includes(SECRET), false);
    assert.equal(p.args[p.args.indexOf('--key') + 1], keyIdOf(SECRET));
    assert.equal(p.env, undefined, 'and no environment of its own to leak it through');
  }
});

// PINS the command composition, docker's: shell → bash -lc; argv verbatim;
// CC_REMOTE and CC_EXEC_TOKEN overlaid on the agent's environment; stdin only
// when piped.
test('an exec plan: argv verbatim, overlay env, --stdin only for a pipe', () => {
  const p = k.spawnPlan(CONFIG, req());
  assert.deepEqual(afterDashes(p.args), ['ls', '-la']);
  assert.equal(p.args.includes('--stdin'), false);
  const env = p.args.flatMap((a, i) => (a === '--env' ? [p.args[i + 1]] : []));
  assert.deepEqual(env, ['CC_REMOTE=box', 'CC_EXEC_TOKEN=tok123']);
  assert.equal(p.args[p.args.indexOf('--cwd') + 1], '/srv');
  assert.equal(p.args[p.args.indexOf('--remote') + 1], 'box');

  const s = k.spawnPlan(CONFIG, req({ shell: 'echo $HOME', argv: null, stdinMode: 'pipe' }));
  assert.deepEqual(afterDashes(s.args), ['/bin/bash', '-lc', 'echo $HOME']);
  assert.ok(s.args.includes('--stdin'));
});

// PINS: a frame env REPLACES, through `env -i --` on the far side — and the
// `--` is load-bearing (a key like `-C` would otherwise be an env option).
test('a frame env replaces through env -i --, with CC_REMOTE and the token last', () => {
  const p = k.spawnPlan(CONFIG, req({ env: { PATH: '/x', '-C': 'evil' } }));
  const cmd = afterDashes(p.args);
  assert.deepEqual(cmd.slice(0, 3), ['env', '-i', '--']);
  assert.deepEqual(cmd.slice(3), ['PATH=/x', '-C=evil', 'CC_REMOTE=box', 'CC_EXEC_TOKEN=tok123', 'ls', '-la']);
});

// PINS: the channel plan is INVARIANT across ops — the pool keys channels on
// its argv — so no cwd, no token; only the remote and its key.
test('channelPlan is invariant across ops and carries no token', () => {
  const a = k.channelPlan(CONFIG, { remoteId: 'box' });
  assert.deepEqual(k.channelPlan(CONFIG, { remoteId: 'box' }), a);
  assert.equal(a.args.some(x => x.startsWith('CC_EXEC_TOKEN=')), false);
  assert.deepEqual(afterDashes(a.args), ['/bin/sh']);
  assert.ok(a.args.includes('--stdin'));
  assert.notDeepEqual(k.channelPlan({ secret: 'R'.repeat(43) }, { remoteId: 'box' }), a,
    'a rotated secret is a different channel');
});

test('the pty plan runs the trampoline under --pty with the token, exec mode, no resize relay', () => {
  const p = k.ptyPlan(CONFIG, { command: ['/bin/sh', '-c', 'tramp'], token: 'tt', remoteId: 'box' });
  assert.ok(p.args.includes('--pty'));
  assert.deepEqual(afterDashes(p.args), ['/bin/sh', '-c', 'tramp']);
  assert.ok(p.args.includes('CC_EXEC_TOKEN=tt'));
  assert.equal(k.ptyMode, 'exec');
  assert.equal(k.ptyResizeRelay, false);
  assert.equal(k.processGroupSignal, false);
  assert.equal(k.remotes, true);
});

test('validateConfig accepts exactly a 43-character base64url secret', () => {
  assert.deepEqual(k.validateConfig({ secret: SECRET, junk: 1 }), { ok: true, config: { secret: SECRET } });
  for (const bad of [{}, { secret: '' }, { secret: 'a'.repeat(42) }, { secret: 'a'.repeat(44) },
    { secret: `${'a'.repeat(42)}=` }, { secret: `${'a'.repeat(42)}+` }, { secret: 42 }]) {
    const v = k.validateConfig(bad);
    assert.equal(v.ok, false, JSON.stringify(bad));
    if (typeof bad.secret === 'string' && bad.secret) assert.equal(v.error.includes(bad.secret), false, 'the refusal never echoes the value');
  }
});

const marker = (tag, msg) => `code-system-agent: ${tag} ${msg}\n`;
const FS_TOKEN = new RegExp(`\\b(${FS_ERROR_CODES.filter(c => c !== 'EUNKNOWN').join('|')})\\b`);

// PINS every row of the classifier, and that an ADMINISTRATIVE message carries
// no standalone errno token (cc re-parses messages:
// .wiki/gotchas/refusal-message-errno-tokens.md).
test('classifyFailure maps every bridge tag to its code, admin messages errno-free', () => {
  const rows = [
    [255, 'broker-down', 'the agent listener is not running', 'ENOREMOTE'],
    [255, 'not-connected', "no agent is connected for remote 'box'", 'ENOREMOTE'],
    [255, 'stale-key', 'a previous secret', 'ENOREMOTE'],
    [255, 'too-many-streams', 'the most one agent session carries', 'EUNKNOWN'],
    [255, 'lost', 'the agent disconnected while the command ran', 'ETRANSPORT'],
  ];
  for (const [code, tag, msg, want] of rows) {
    const v = k.classifyFailure(CONFIG, { code, stdout: '', stderr: marker(tag, msg) });
    assert.deepEqual(v, { code: want, message: msg }, tag);
    assert.equal(FS_TOKEN.test(v.message), false, `${tag}: no errno token`);
  }
  const ns = k.classifyFailure(CONFIG, { code: 127, stderr: marker('never-started', "ENOENT [Errno 2] No such file or directory: 'x'") });
  assert.deepEqual(ns, { code: 'ENOENT', message: "[Errno 2] No such file or directory: 'x'" });
});

// PINS: the marker counts only with ITS exit status and only as the LAST line;
// anything else is the command's own failure.
test('classifyFailure answers null for the command\'s own failures', () => {
  assert.equal(k.classifyFailure(CONFIG, { code: 1, stderr: marker('lost', 'x') }), null, 'wrong exit status');
  assert.equal(k.classifyFailure(CONFIG, { code: 127, stderr: marker('lost', 'x') }), null, '127 is never-started only');
  assert.equal(k.classifyFailure(CONFIG, { code: 255, stderr: `${marker('lost', 'x')}more output\n` }), null, 'not the last line');
  assert.equal(k.classifyFailure(CONFIG, { code: 255, stderr: 'ssh: connect refused\n' }), null);
  assert.equal(k.classifyFailure(CONFIG, { code: 255, stderr: marker('usage', 'bad flag') }), null, 'an unknown tag');
  assert.equal(k.classifyFailure(CONFIG, { code: 127, stderr: marker('never-started', 'lowercase message') }), null);
});

// PINS: a session lost after a lot of output is still recognised — the marker
// is past the 512-byte HEAD but inside the TAIL.
test('the stderr tail is read when the head lacks the marker', () => {
  const head = 'x'.repeat(512);
  const tail = `${'y'.repeat(300)}\n${marker('lost', 'gone mid-command')}`;
  assert.equal(k.classifyFailure(CONFIG, { code: 255, stderr: head }), null);
  assert.deepEqual(k.classifyFailure(CONFIG, { code: 255, stderr: head, stderrTail: tail }),
    { code: 'ETRANSPORT', message: 'gone mid-command' });
  // A terminal's head arrives with carriage returns.
  assert.deepEqual(readMarker(marker('not-connected', 'n').replace('\n', '\r\n')), { tag: 'not-connected', message: 'n' });
});
