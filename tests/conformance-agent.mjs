#!/usr/bin/env node
// THE BOUND RUN FOR THE agent KIND: code-conductor's own conformance suite,
// driven through the shipped launcher (`--kind agent`), a real broker and a
// real agent.py on this same machine.
//
//   CC_CHECKOUT=/path/to/code-conductor npm run conformance:agent
//
// Because the agent runs locally, the far side shares this machine's
// filesystem and PID namespace BY CONSTRUCTION — no bind mount and no shared
// namespace to prove, unlike the docker run (tests/conformance-docker.mjs).
//
// TWO ARMS, the held-open channel on and off, and one manifest
// (tests/agentConformanceExpectations.mjs) that both must match exactly: every
// unlisted row passes, every listed row produces exactly its recorded outcome.
//
// REFUSES TO RUN AS ROOT: cc's EACCES rows make a file unreadable and expect
// the far side to be refused; root reads it anyway.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROBE_SCRIPT, parseProbeOutput } from '../src/baseline.mjs';
import { queryBroker } from '../src/agent/client.mjs';
import { CHANNEL_ENV, channelEnabled } from '../src/launcher/channel.mjs';
import { createTransport } from '../src/launcher/kinds/index.mjs';
import { makeRunner } from '../src/launcher/run.mjs';
import { AGENT_PY, BROKER_MAIN, LAUNCHER_MAIN, agentSocketPath } from '../src/paths.mjs';
import { makeRecord, writeRemote } from '../src/store.mjs';
import {
  CC_FILE_KILL_MS, assertNoDrift, checkTally, checkoutOrSkip, parseSpecReport, spawnSuite,
} from './ccCheckout.mjs';
import { EXPECTED_AGENT, EXPECTED_AGENT_TOTAL } from './agentConformanceExpectations.mjs';
import { checkTotal, compareOutcomes } from './boundConformanceExpectations.mjs';
import { readLauncherDiagnostics } from './launcherDiagnostics.mjs';

const ARM_FLAG = '--arm';
const ARMS = [{ name: 'on', channel: '1' }, { name: 'off', channel: '0' }];
const armName = (() => {
  const i = process.argv.indexOf(ARM_FLAG);
  return i === -1 ? null : String(process.argv[i + 1] ?? '');
})();
const SCRIPT = armName === null ? 'conformance:agent' : `conformance:agent[channel=${armName}]`;
const REMOTE_ID = 'boundagent';
const PYTHON = process.env.CODE_SYSTEM_PYTHON?.trim() || 'python3';

const log = s => console.log(s);
const cleanups = [];
let suiteRun = null;

class SetupError extends Error {}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new SetupError(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

function startDetached(file, args, env, logPath) {
  return fs.open(logPath, 'a').then((fh) => {
    const child = spawn(file, args, { env, stdio: ['ignore', fh.fd, fh.fd], detached: true });
    void fh.close();
    return child;
  });
}

async function teardown() {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch (e) { console.error(`${SCRIPT}: cleanup failed: ${e?.message ?? e}`); }
  }
  cleanups.length = 0;
}

async function killSuiteRun() {
  const child = suiteRun;
  suiteRun = null;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('close', resolve);
    setTimeout(resolve, 5_000).unref?.();
    try { process.kill(-child.pid, 'SIGKILL'); } catch { resolve(); }
  });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`\n${SCRIPT}: ${sig} — stopping the battery, then tearing down`);
    void killSuiteRun().then(teardown).finally(() => {
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  });
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new SetupError('refusing to run as root: cc\'s EACCES rows make a path unreadable and expect a'
      + ' refusal, which root never gets — run as an ordinary user');
  }
  const checkout = checkoutOrSkip(SCRIPT);
  assertNoDrift(SCRIPT, checkout);

  const store = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-agentconf-'));
  cleanups.push(() => fs.rm(store, { recursive: true, force: true }));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-agentconf-scratch-'));
  cleanups.push(() => fs.rm(scratch, { recursive: true, force: true }));
  process.env.CODE_SYSTEM_STORE = store;

  const secret = randomBytes(32).toString('base64url');
  const record = makeRecord({ remoteId: REMOTE_ID, kind: 'agent', config: { secret }, enabled: true });
  await writeRemote(record);
  const env = { ...process.env, CODE_SYSTEM_STORE: store, TMPDIR: scratch };
  delete env.CONDUCTOR_URL;

  const brokerLog = path.join(store, 'broker.log');
  const broker = await startDetached(process.execPath, [BROKER_MAIN, '--listen', '127.0.0.1:0', '--store', store], env, brokerLog);
  const sock = agentSocketPath();
  cleanups.push(async () => {
    await queryBroker(sock, { t: 'stop' }).catch(() => {});
    try { process.kill(-broker.pid, 'SIGKILL'); } catch { /* gone */ }
  });
  const pong = await waitFor(() => queryBroker(sock, { t: 'ping' }, { timeoutMs: 500 }), 'the broker to answer');
  log(`${SCRIPT}: broker pid ${pong.pid} on ${pong.address}, store ${store}`);

  const agentLog = path.join(store, 'agent.log');
  const agent = await startDetached(PYTHON, [AGENT_PY, '--connect', pong.address, '--remote', REMOTE_ID],
    { ...env, CODE_SYSTEM_AGENT_SECRET: secret }, agentLog);
  cleanups.unshift(async () => {
    // SIGTERM first: an agent ends its session's commands on SIGTERM.
    try { process.kill(agent.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise(r => setTimeout(r, 300));
    try { process.kill(-agent.pid, 'SIGKILL'); } catch { /* gone */ }
  });
  const st = await waitFor(async () => {
    const s = await queryBroker(sock, { t: 'status', remoteId: REMOTE_ID });
    return s.connected && s.host ? s : null;
  }, 'the agent to connect');
  log(`${SCRIPT}: agent pid ${st.agentPid} (Python ${st.python}) connected, session ${st.session}`);

  const transport = createTransport('agent');
  const reach = await transport.reachability(record.config, { remoteId: REMOTE_ID });
  if (!reach.connected) throw new SetupError(`the card does not read connected: ${reach.detail}`);
  const verdict = parseProbeOutput(await makeRunner(transport, record.config, REMOTE_ID)({ script: PROBE_SCRIPT }));
  if (verdict.state !== 'ok') {
    throw new SetupError(`this machine fails cc's tooling baseline (${verdict.state}, missing`
      + ` ${JSON.stringify(verdict.missing)}): every derived row would fail for that reason`);
  }
  await writeRemote({ ...record, baseline: { ...verdict, fingerprint: reach.fingerprint, checkedAt: new Date().toISOString() } });
  log(`${SCRIPT}: tooling baseline ok`);

  const launcherLog = path.join(store, 'launcher-stderr.log');
  const provider = JSON.stringify([
    '/bin/sh', '-c', 'log=$1; shift; exec "$@" 2>>"$log"', 'sh', launcherLog,
    process.execPath, LAUNCHER_MAIN, '--kind', 'agent',
  ]);
  log(`${SCRIPT}: ${checkout}\n${SCRIPT}: provider ${provider}\n`);

  const started = Date.now();
  const child = suiteRun = spawnSuite(checkout, {
    CC_CONFORMANCE_PROVIDER: provider,
    CC_CONFORMANCE_REMOTE_ID: REMOTE_ID,
    TMPDIR: scratch,
    CODE_SYSTEM_STORE: store,
  }, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', (b) => { out += b; process.stdout.write(b); });
  child.stderr.on('data', b => process.stderr.write(b));
  const suiteExit = await new Promise(r => child.on('close', r));
  suiteRun = null;
  const elapsed = Date.now() - started;

  const after = await queryBroker(sock, { t: 'status', remoteId: REMOTE_ID }).catch(() => null);
  const report = parseSpecReport(out);
  const parseProblems = checkTally(report);
  const sizeProblems = checkTotal(report.tally, EXPECTED_AGENT_TOTAL);
  const problems = compareOutcomes(report.tests, EXPECTED_AGENT);
  const diag = readLauncherDiagnostics(await fs.readFile(launcherLog, 'utf8').catch(() => ''),
    { expectCensus: channelEnabled(process.env) });

  log('');
  log(`${SCRIPT}: ${report.tally.pass ?? '?'} pass / ${report.tally.fail ?? '?'} fail`
    + ` / ${report.tally.skipped ?? '?'} skip of ${report.tally.tests ?? '?'} (cc's runner exited ${suiteExit})`);
  log(`${SCRIPT}: wall clock ${elapsed}ms against the ${CC_FILE_KILL_MS}ms per-file hang guard`);
  log(`${SCRIPT}: agent session ${after?.session === st.session ? 'unchanged' : `CHANGED (${after?.session ?? 'gone'})`}`
    + ` across the run; replacements ${after?.replacements ?? '?'}`);
  log(`${SCRIPT}: launcher said — ${diag.sessions} session(s) reported a channel census:`
    + ` carried ${diag.carried} of ${diag.admitted} admitted ops on ${diag.channels} channels`
    + `; ${diag.drift.length} admission-drift alarm(s)`);
  for (const line of diag.other) log(`${SCRIPT}: launcher said — ${line}`);
  log(`${SCRIPT}: ${EXPECTED_AGENT.length} rows are expected not to pass — see`
    + ' tests/agentConformanceExpectations.mjs for each one\'s cause');

  for (const p of parseProblems) console.error(`${SCRIPT}: PARSE — ${p}`);
  for (const p of sizeProblems) console.error(`${SCRIPT}: SIZE — ${p}`);
  for (const p of problems) console.error(`${SCRIPT}: ${p.kind.toUpperCase()} — ${p.name}\n      ${p.message}`);
  for (const p of diag.problems) console.error(`${SCRIPT}: LAUNCHER — ${p}`);
  const sessionMoved = after?.session !== st.session;
  if (sessionMoved) console.error(`${SCRIPT}: SESSION — the agent session did not survive the run`);
  if (parseProblems.length || sizeProblems.length || problems.length || diag.problems.length || sessionMoved) {
    console.error(`\n${SCRIPT}: FAILED — the run did not match the manifest`);
    return 1;
  }
  log(`\n${SCRIPT}: OK — every unlisted row passed, every listed row produced exactly its recorded outcome`);
  return 0;
}

async function runArms() {
  let worst = 0;
  for (const arm of ARMS) {
    console.log(`\n================ conformance:agent — channel ${arm.name} (${CHANNEL_ENV}=${arm.channel}) ================\n`);
    const child = spawn(process.execPath, [process.argv[1], ARM_FLAG, arm.name], {
      stdio: 'inherit', env: { ...process.env, [CHANNEL_ENV]: arm.channel },
    });
    const status = await new Promise(r => child.on('close', (c, sg) => r(sg ? 1 : (c ?? 1))));
    console.log(`\nconformance:agent: channel ${arm.name} arm exited ${status}`);
    if (status !== 0) worst = status;
    if (status === 0 && !process.env.CC_CHECKOUT?.trim()) break;
  }
  return worst;
}

if (armName === null) {
  process.exitCode = await runArms();
} else {
  let code = 1;
  try { code = await main(); }
  catch (e) { console.error(`\n${SCRIPT}: ABORTED — ${e instanceof SetupError ? e.message : (e?.stack ?? e)}`); }
  finally { await teardown(); }
  process.exitCode = code;
}
