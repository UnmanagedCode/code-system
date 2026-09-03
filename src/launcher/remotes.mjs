// WHERE THE LAUNCHER'S TARGETS COME FROM. Two sources, one interface, so
// session.mjs never learns which one it has:
//
//   StoreRemoteSource — production. Reads <store>/remotes/<id>.json FRESH on
//                       every request frame, with no cache (see src/store.mjs).
//   FlagRemoteSource  — `--remote id=root` on the argv, which is the shape cc's
//                       conformance suite drives a provider in.
//
// A source answers three things: which targets exist, what a named one resolves
// to, and what it advertises as a mirror.

import path from 'node:path';
import { readRemote } from '../store.mjs';

/**
 * @typedef {{remoteId:string|null, config:object, root:string|null}} ResolvedRemote
 *
 * `root` is a FENCE — a path outside it is refused EACCES — and is null for a
 * target that is not fenced. It is not the mirror advertisement, which is a
 * claim about geometry cc consumes; keeping the two apart is what lets a test
 * advertise a mirror wider than the fence.
 */

// Is `p` the root, or inside it? path.relative rather than a string prefix,
// which would claim a merely prefix-SHARING sibling (`<root>-backup`) is
// inside. Resolved first so `<root>/../elsewhere` cannot walk out.
export function withinRoot(root, p) {
  const rel = path.relative(root, path.resolve(p));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

export class FlagRemoteSource {
  #remotes;
  #mirrors;

  /**
   * @param {Map<string,string>} remotes  id → absolute fenced root
   * @param {Map<string,{mirrorRoot:string|null, exclude:string[]}>} mirrors
   *   keyed by id, or '' for the default target
   */
  constructor(remotes = new Map(), mirrors = new Map()) {
    this.#remotes = remotes;
    this.#mirrors = mirrors;
  }

  hasRemotes() { return this.#remotes.size > 0; }
  hasMirrors() { return this.#mirrors.size > 0; }
  ids() { return [...this.#remotes.keys()]; }

  async lookup(remoteId) {
    // With no --remote flags this endpoint serves exactly ONE target and does
    // not advertise `remotes`, so cc never sends the field and there is nothing
    // to route: the default target is unfenced.
    if (!this.hasRemotes()) {
      return { ok: true, remote: { remoteId: null, config: {}, root: null } };
    }
    if (remoteId === null) {
      return {
        ok: false,
        code: 'ENOREMOTE',
        message: `this provider serves named remotes (${this.ids().join(', ')}) and the request named none`,
      };
    }
    const root = this.#remotes.get(remoteId);
    if (root === undefined) {
      return {
        ok: false,
        code: 'ENOREMOTE',
        message: `no such remote '${remoteId}' — this provider serves ${this.ids().join(', ')}`,
      };
    }
    return { ok: true, remote: { remoteId, config: {}, root } };
  }

  mirrorFor(remoteId) {
    return this.#mirrors.get(remoteId ?? '') ?? { mirrorRoot: null, exclude: [] };
  }
}

export class StoreRemoteSource {
  #kind;

  constructor(kind) { this.#kind = kind; }

  // CONSTANT TRUE, never derived from what happens to be in the store: cc
  // memoises the handshake per connection generation, so a capability that
  // flapped as remotes were added would be memoised wrong, and the launch argv
  // is a function of (install path, kind) only so no re-registration happens
  // when a remote appears.
  hasRemotes() { return true; }
  hasMirrors() { return false; }
  ids() { return []; }

  async lookup(remoteId) {
    if (remoteId === null) {
      return {
        ok: false,
        code: 'ENOREMOTE',
        message: `this provider serves named ${this.#kind} remotes and the request named none`
          + ' — set the project\'s Remote field to a remote id from the code-system UI',
      };
    }
    const r = await readRemote(remoteId);
    if (!r.ok) {
      // Every failure to resolve a target is ENOREMOTE and ID-ADDRESSED. An
      // id-less error frame is connection-level and would fail every OTHER
      // target's in-flight work (docs/systems-protocol.md:598).
      return { ok: false, code: 'ENOREMOTE', message: `${r.message} (${this.#kind} launcher)` };
    }
    const rec = r.record;
    if (rec.kind !== this.#kind) {
      return {
        ok: false,
        code: 'ENOREMOTE',
        message: `remote '${remoteId}' is a '${rec.kind}' remote — this launcher serves '${this.#kind}' remotes`,
      };
    }
    const gate = baselineRefusal(rec);
    if (gate) return gate;
    return {
      ok: true,
      remote: { remoteId, config: rec.config ?? {}, root: null },
    };
  }

  mirrorFor() { return { mirrorRoot: null, exclude: [] }; }
}

// THE TOOLING-BASELINE GATE, launcher side.
//
// `unsupported` refuses the target WHOLE. Refusing whole is deliberate: the
// busybox case is PARTLY working — four of cc's seven derivations are fine and
// `stat` succeeds while silently losing sub-second precision — and a
// half-working system is exactly what a clear refusal is worth more than.
//
// `unknown` SERVES. The launcher can be spawned before the backend has ever
// probed, and absence of evidence is not evidence: blocking on it would make a
// cold launcher useless.
//
// EUNKNOWN is the right code by the taxonomy — the catch-all that carries raw
// stderr verbatim and IS SURFACED TO THE USER (docs/systems-protocol.md:579).
export function baselineRefusal(rec) {
  const b = rec?.baseline;
  if (!b || b.state !== 'unsupported') return null;
  const missing = Array.isArray(b.missing) ? b.missing : [];
  const names = missing.map(m => m.capability).join(', ') || 'the POSIX/GNU tooling baseline';
  return {
    ok: false,
    code: 'EUNKNOWN',
    message: `remote '${rec.remoteId}' does not meet the tooling baseline cc's derived operations need:`
      + ` ${names}. Fix the target's toolchain (GNU coreutils + findutils) or point this project elsewhere.`,
    stderr: missing.map(m => `${m.capability}: ${m.probe}: ${m.detail}`).join('\n'),
  };
}
