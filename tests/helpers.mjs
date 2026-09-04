// Shared test fixtures. Nothing here touches docker, ssh or the network, and
// every store is a fresh mkdtemp so tests pass in any order.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NdjsonDecoder, encodeFrame } from '../src/launcher/protocol.mjs';

export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const LAUNCHER = path.join(REPO, 'src', 'launcher', 'main.mjs');
export const FAKE_TRANSPORT = path.join(REPO, 'tests', 'fakeTransport.mjs');

export async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-test-'));
  return { dir, async cleanup() { await fs.rm(dir, { recursive: true, force: true }); } };
}

// Drives the real launcher as a child over pipes, HOLDING STDIN OPEN — which is
// what cc does, and without which MUST 3 would fire before an async operation
// could answer.
export class Launcher {
  #child;
  #decoder = new NdjsonDecoder();
  #frames = [];
  #waiters = [];
  stderr = '';
  exited = null;

  constructor(args, env = {}) {
    this.#child = spawn(process.execPath, [LAUNCHER, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.on('data', (chunk) => {
      for (const f of this.#decoder.push(chunk)) {
        this.#frames.push(f);
        for (const w of this.#waiters.splice(0)) w();
      }
    });
    this.#child.stderr.on('data', (b) => { this.stderr += b.toString('utf8'); });
    this.exited = new Promise((resolve) => {
      this.#child.on('close', (code, signal) => {
        for (const w of this.#waiters.splice(0)) w();
        resolve({ code, signal });
      });
    });
  }

  get frames() { return this.#frames; }
  get pid() { return this.#child.pid; }

  send(frame) { this.#child.stdin.write(encodeFrame(frame)); }
  sendRaw(text) { this.#child.stdin.write(text); }
  closeStdin() { this.#child.stdin.end(); }
  kill(sig = 'SIGKILL') { try { this.#child.kill(sig); } catch { /* gone */ } }

  async hello() {
    this.send({ type: 'hello', protocol: 1, client: 'code-conductor' });
    return this.waitFor(f => f.type === 'hello');
  }

  // Waits for the first frame matching `pred`. Rejects if the child exits
  // first, so a hang surfaces as a named failure rather than a timeout.
  async waitFor(pred, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.#frames.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a frame; saw ${JSON.stringify(this.#frames)} stderr=${this.stderr}`);
      }
      const done = await Promise.race([
        new Promise(r => { this.#waiters.push(() => r('frame')); }),
        this.exited.then(() => 'exited'),
        new Promise(r => setTimeout(() => r('tick'), 50)),
      ]);
      if (done === 'exited' && !this.#frames.find(pred)) {
        throw new Error(`launcher exited before the expected frame; saw ${JSON.stringify(this.#frames)} stderr=${this.stderr}`);
      }
    }
  }
}

// A remote record on disk, at the current schema.
export async function writeRecord(storeDir, record) {
  const dir = path.join(storeDir, 'remotes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${record.remoteId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function record(remoteId, over = {}) {
  return {
    schema: 1,
    remoteId,
    kind: 'fake',
    label: remoteId,
    config: {},
    baseline: { state: 'unknown', fingerprint: null, missing: [], checkedAt: null },
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    ...over,
  };
}

// A scripted cc: an http server that records every request and answers from a
// per-path script. Asserted on the recorded log, never on timing.
export async function fakeConductor(handler) {
  const http = await import('node:http');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const entry = { method: req.method, url: req.url, body: body ? JSON.parse(body) : null };
    requests.push(entry);
    const out = handler(entry, requests) ?? { status: 500, body: { error: 'unscripted' } };
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() { await new Promise(r => server.close(r)); },
  };
}

// ── The stub CLIs, shared by the kind suites and the API suite ───────
//
// A real executable on disk is the cheapest way to make the REAL spawn path —
// argv, exit code, stream separation — part of what is under test. Both stubs
// log their argv one element per line, so a test can assert on exactly what was
// invoked, and `argv()` answers `[]` when the stub was never run at all.
//
// THE ANSWERS-FILE MODE models an OUT-OF-BAND CHANGE deterministically. Passing
// `answers` makes the reachability branch (docker `inspect`, ssh `-O check`)
// read its stdout/stderr/exit from files instead of baking them in, so a test
// can rewrite them BETWEEN two calls to the SAME server and prove the next
// probe re-asks rather than serving a cached verdict. That is the only way to
// model `docker stop` / `ssh -O exit` happening behind the plugin's back
// without a real daemon.

// Three files rather than one parsed blob: a `sh` stub reads them with `cat`
// and needs no parser, and stderr has to stay a separate stream to be asserted
// separately from stdout.
async function answersFiles(dir, initial) {
  const files = { out: path.join(dir, 'ans.out'), err: path.join(dir, 'ans.err'), code: path.join(dir, 'ans.code') };
  const set = async ({ stdout = '', stderr = '', exitCode = 0 } = {}) => {
    await fs.writeFile(files.out, stdout);
    await fs.writeFile(files.err, stderr);
    await fs.writeFile(files.code, String(exitCode));
  };
  await set(initial);
  return { files, set };
}

export async function stubDockerCli(t, {
  exitCode = 0, stdout = '', stderr = '',
  execStdout = 'CCREAP ok 0 7\n', execStderr = '', execExitCode = 0,
  answers = null,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-dockerstub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const argvLog = path.join(dir, 'argv.txt');
  const bin = path.join(dir, 'docker');
  const ans = answers ? await answersFiles(dir, answers) : null;
  const q = JSON.stringify;
  await fs.writeFile(bin, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> ${q(argvLog)}`,
    // `exec` and `inspect` answer differently: a reap that gets an inspect-shaped
    // answer must (and does) report failure, which would otherwise make every
    // stub-driven test that calls reap throw.
    `if [ "$1" = exec ]; then printf '%b' ${q(execStdout)};`
      + ` printf '%b' ${q(execStderr)} >&2; exit ${execExitCode}; fi`,
    ans
      ? `cat ${q(ans.files.out)}; cat ${q(ans.files.err)} >&2; exit "$(cat ${q(ans.files.code)})"`
      : [
        stdout ? `printf '%b' ${q(stdout)}` : ':',
        stderr ? `printf '%b' ${q(stderr)} >&2` : ':',
        `exit ${exitCode}`,
      ].join('\n'),
  ].join('\n'));
  await fs.chmod(bin, 0o755);
  return {
    cli: [bin],
    dir,
    // Rewrite what the next `inspect` answers. Only in answers mode.
    setAnswer: ans ? ans.set : null,
    // Empty when the stub was never invoked at all — every caller passes
    // arguments, so `[]` is unambiguously "never run" rather than "run bare".
    async argv() {
      try { return (await fs.readFile(argvLog, 'utf8')).split('\n').filter(Boolean); }
      catch { return []; }
    },
  };
}

/**
 * A stub `ssh`. `socket: true` makes it CREATE a file at the requested
 * ControlPath, so `reachability`'s fingerprint has a real inode and ctime to
 * read. `answers` puts the `-O check` branch on the answers files.
 */
export async function stubSshCli(t, {
  checkExit = 0, checkStdout = '', checkStderr = 'Master running (pid=4242)\n',
  exitExit = 0, exitStdout = '', exitStderr = 'Exit request sent.\n',
  connectExit = 0, connectStderr = '',
  execStdout = 'CCREAP ok 0 7\n', execStderr = '', execExit = 0,
  socket = false, answers = null,
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'code-system-sshstub-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const argvLog = path.join(dir, 'argv.txt');
  const bin = path.join(dir, 'ssh');
  const ans = answers ? await answersFiles(dir, answers) : null;
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
    ans
      ? `if [ "$verb" = check ]; then cat ${q(ans.files.out)}; cat ${q(ans.files.err)} >&2;`
        + ` exit "$(cat ${q(ans.files.code)})"; fi`
      : `if [ "$verb" = check ]; then printf '%b' ${q(checkStdout)}; printf '%b' ${q(checkStderr)} >&2; exit ${checkExit}; fi`,
    `if [ "$verb" = exit ]; then printf '%b' ${q(exitStdout)}; printf '%b' ${q(exitStderr)} >&2; exit ${exitExit}; fi`,
    // A master start: -N with no remote command.
    `case " $* " in *" -N "*) printf '%b' ${q(connectStderr)} >&2; exit ${connectExit} ;; esac`,
    `printf '%b' ${q(execStdout)}; printf '%b' ${q(execStderr)} >&2; exit ${execExit}`,
  ].join('\n'));
  await fs.chmod(bin, 0o755);
  return {
    cli: [bin],
    dir,
    setAnswer: ans ? ans.set : null,
    async argv() {
      try { return (await fs.readFile(argvLog, 'utf8')).split('\n').filter(Boolean); }
      catch { return []; }
    },
  };
}
