// THE LAUNCHER ENTRY POINT. This path is what goes in a cc System row's
// `launch` argv (see src/registration.mjs), so it must not move without
// updating src/paths.mjs — which is the only place it is spelled.
//
//   node src/launcher/main.mjs --kind <docker|ssh|host>
//                              [--no-process-group-signal]
//                              [--remote <id>=<absolute root>]…   (host only)
//                              [--mirror <[id=]absolute root>]…   (host only)
//                              [--exclude <[id=]absolute path>]…  (host only)
//
// cc spawns this with `spawn(argv[0], argv.slice(1))` — NO SHELL — carrying the
// ORCHESTRATOR's environment and no reliable cwd. Everything it needs is
// therefore either on the argv or computed from an absolute path.

import path from 'node:path';
import {
  NdjsonDecoder, ProtocolError, encodeFrame,
} from './protocol.mjs';
import { FlagRemoteSource, StoreRemoteSource } from './remotes.mjs';
import { createTransport, isKnownKind } from './kinds/index.mjs';
import { hostKindRefusal, hostUnfencedRefusal } from './kinds/host.mjs';
import { Session } from './session.mjs';

const VERSION = '0.1.0';

// The kinds whose targets come from the store rather than from flags. For them
// a `--remote` flag would be a lie about where configuration lives, so it is
// refused rather than ignored.
const STORE_BACKED = new Set(['docker', 'ssh']);

class UsageError extends Error {}

// `<id>=<path>`, or a bare `<path>` for the default target. Shared by --mirror
// and --exclude so the two cannot disagree on the spelling.
function parseTargeted(flag, spec) {
  const eq = spec.indexOf('=');
  const id = eq === -1 ? '' : spec.slice(0, eq);
  const value = eq === -1 ? spec : spec.slice(eq + 1);
  if (!path.isAbsolute(value)) {
    throw new UsageError(`${flag} wants <[id=]absolute path>, got ${JSON.stringify(spec)}`);
  }
  return { id, value };
}

export function parseArgs(argv) {
  const o = {
    kind: null,
    processGroupSignal: true,
    remotes: new Map(),
    mirrors: new Map(),
  };
  const mirrorFor = (id) => {
    let m = o.mirrors.get(id);
    if (!m) { m = { mirrorRoot: null, exclude: [] }; o.mirrors.set(id, m); }
    return m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') o.kind = argv[++i] ?? '';
    else if (a === '--no-process-group-signal') o.processGroupSignal = false;
    else if (a === '--remote') {
      const spec = argv[++i] ?? '';
      const eq = spec.indexOf('=');
      const id = eq === -1 ? '' : spec.slice(0, eq);
      const root = eq === -1 ? '' : spec.slice(eq + 1);
      if (!id || !path.isAbsolute(root)) {
        throw new UsageError(`--remote wants <id>=<absolute root>, got ${JSON.stringify(spec)}`);
      }
      o.remotes.set(id, path.resolve(root));
    } else if (a === '--mirror') {
      const { id, value } = parseTargeted('--mirror', argv[++i] ?? '');
      mirrorFor(id).mirrorRoot = value;
    } else if (a === '--exclude') {
      const { id, value } = parseTargeted('--exclude', argv[++i] ?? '');
      mirrorFor(id).exclude.push(value);
    } else {
      throw new UsageError(`unknown launcher option: ${a}`);
    }
  }
  if (!o.kind) throw new UsageError('--kind <docker|ssh|host> is required');
  if (!isKnownKind(o.kind) && o.kind !== 'fake') {
    throw new UsageError(`unknown kind '${o.kind}'`);
  }
  if (STORE_BACKED.has(o.kind) && (o.remotes.size > 0 || o.mirrors.size > 0)) {
    throw new UsageError(
      `--remote/--mirror/--exclude are not accepted for kind '${o.kind}':`
      + ' its targets come from the code-system config store, one file per remote');
  }
  return o;
}

// The test seam for tests/launcher-frames.test.mjs and
// tests/launcher-shutdown.test.mjs: a Transport supplied by a module path, so
// the frame loop and the shutdown path can be driven with no docker and no ssh.
async function resolveTransport(opts) {
  if (opts.kind === 'fake') {
    const modulePath = process.env.CODE_SYSTEM_FAKE_TRANSPORT?.trim();
    if (!modulePath) throw new UsageError("kind 'fake' requires CODE_SYSTEM_FAKE_TRANSPORT to name a module");
    const mod = await import(modulePath);
    return mod.createTransport(opts);
  }
  if (opts.kind === 'host') {
    // LOUD AND EARLY, before any frame, so cc's registration answers 502
    // quoting this rather than a row quietly serving arbitrary exec on cc's own
    // machine.
    const refusal = hostKindRefusal();
    if (refusal) throw new UsageError(refusal);
    // Two seams, because they fail differently: one says "this is a test
    // vehicle", the other says "and even then it is scoped to a named root".
    const unfenced = hostUnfencedRefusal(opts.remotes.size);
    if (unfenced) throw new UsageError(unfenced);
  }
  return createTransport(opts.kind, {
    processGroupSignal: opts.processGroupSignal,
    // DERIVED FROM THE FLAGS for a flag-backed kind — the shape cc's reference
    // provider uses. systems-protocol.md §10: each capability is advertised IFF
    // at least one of its flags is given, and the core fixtures pass none while
    // the remotes/mirror fixtures pass them, so a hardcoded value breaks one
    // group or the other.
    remotes: opts.remotes.size > 0,
    remoteDescriptors: opts.mirrors.size > 0,
  });
}

export async function runLauncher(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  let transport;
  try {
    opts = parseArgs(argv);
    transport = await resolveTransport(opts);
  } catch (e) {
    // Exit 2 BEFORE ANY FRAME. cc reports the launch failure with our stderr
    // tail quoted, which src/registration.mjs surfaces verbatim.
    stderr.write(`code-system launcher: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
    return;
  }

  const source = STORE_BACKED.has(opts.kind) || opts.kind === 'fake'
    ? new StoreRemoteSource(opts.kind)
    : new FlagRemoteSource(opts.remotes, opts.mirrors);

  // EXACTLY cc's `Capabilities` interface, no more: it reads these three and
  // ignores anything else, so a fourth key would be a field with no reader.
  const capabilities = {
    processGroupSignal: transport.processGroupSignal === true,
    remotes: transport.remotes === true,
    remoteDescriptors: transport.remoteDescriptors === true,
  };

  // NOTHING BUT FRAMES GOES TO STDOUT (MUST 1). Everything diagnostic goes to
  // stderr, of which cc keeps a bounded tail and which it never parses.
  const write = (frame) => { stdout.write(encodeFrame(frame)); };
  let exiting = false;
  const finish = async (code) => {
    if (exiting) return;
    exiting = true;
    await session.shutdown();
    process.exit(code);
  };

  // EPIPE means cc is gone and there is nobody left to tell — but it is still a
  // DISCONNECTION, so it takes the same shutdown path as stdin EOF. Exiting
  // straight from here would skip MUST 3 and leave live children behind
  // whenever cc dies reader-end-first.
  stdout.on('error', () => { void finish(0); });

  const session = new Session({
    transport,
    source,
    capabilities,
    write,
    version: VERSION,
    // Diagnostics the session must report but must not die of — a failed reap.
    warn: (msg) => { stderr.write(`${msg}\n`); },
    onFatal: (msg) => {
      stderr.write(`code-system launcher (${opts.kind}): ${msg}\n`);
      void finish(1);
    },
  });

  const decoder = new NdjsonDecoder();
  stdin.on('data', (chunk) => {
    let frames;
    try { frames = decoder.push(chunk); }
    catch (e) {
      // A malformed line is FATAL to the connection, not skipped, and the error
      // frame is ID-LESS because that is what "the whole connection failed"
      // spells.
      write({ type: 'error', code: e instanceof ProtocolError ? e.code : 'EPROTO', message: e?.message ?? String(e) });
      stderr.write(`code-system launcher (${opts.kind}): ${e?.message ?? e}\n`);
      void finish(1);
      return;
    }
    for (const f of frames) session.deliver(f);
  });

  // A PROVIDER EXITS WHEN ITS STDIN CLOSES, taking everything it started with
  // it (MUST 3).
  stdin.on('end', () => { void finish(0); });
  stdin.on('close', () => { void finish(0); });
  process.on('SIGTERM', () => { void finish(0); });
  process.on('SIGINT', () => { void finish(0); });
}

if (process.argv[1] === (await import('node:url')).fileURLToPath(import.meta.url)) {
  await runLauncher(process.argv.slice(2));
}
