// THE MIRROR ADVERTISEMENT'S ONE VALIDATOR, and the one home of its defaults.
//
// A mirror advertisement is what a remote tells cc about its own geometry:
// `root` — how much of the target's filesystem the session root is the local
// image of — and `exclude` — prefixes cc must not carry across
// (docs/systems-protocol.md §2.1). It is kind-agnostic OPERATOR POLICY, so it
// lives beside `enabled` on the record rather than inside the kind-owned
// `config`.
//
// VALIDATED AT THE STORE'S FRONT DOOR (src/api.mjs) AND NOWHERE ELSE. The
// backend is the only writer, so a bad path is a 400 in the operator's form
// rather than cc's MIRROR_ADVERTISEMENT_INVALID (502) at session start. The
// launcher passes what is stored through unvalidated, exactly as it already
// does for `config`: one validator, no divergence risk, and a hand-edited store
// file still gets a loud refusal from the authority that owns the rule.
//
// THE RULES MIRROR cc's OWN (`$CC_CHECKOUT/src/systems/mirror.ts`,
// `validateAdvertisement` / `normalAbsolute`) deliberately, plus exactly one of
// our own — see `coversRoot` below. Dependency-free, and `path.posix`
// throughout: the far side is POSIX wherever this backend happens to run.

import path from 'node:path';
import { MIRROR_EXCLUDE_MAX, MIRROR_PATH_MAX } from './launcher/protocol.mjs';

// cc's §11 `remoteDescriptors` row, verbatim: `/` to let a worker read and edit
// anywhere on the target, minus the target's pseudo-filesystems. SERVED OVER
// REST (GET /api/kinds, GET /api/remotes) rather than restated in the frontend,
// so the form's prefill and this list cannot drift.
//
// `/sys/fs/cgroup` is NOT here: containment is path.posix.relative, so a
// descendant of an excluded prefix is already excluded. `/run` and `/tmp` are
// not here either — they are tmpfs, not pseudo-filesystems, and a worker
// legitimately reads and writes there.
export const DEFAULT_MIRROR = Object.freeze({
  root: '/',
  exclude: Object.freeze(['/proc', '/dev', '/sys']),
});

// Is `p` an absolute POSIX path already in its own normal form? WE DO NOT
// NORMALISE ON THE OPERATOR'S BEHALF, for cc's reason: a normalised-away `..`
// is exactly how a hostile root gets past a containment test, and `/app/` vs
// `/app` are two spellings of one place that compare unequal downstream.
export function isNormalAbsolute(p) {
  // A NUL is INERT everywhere downstream — nothing splits on it — which is
  // precisely why it is dangerous: an exclude of `/proc\0` silently matches
  // nothing while reading as `/proc` in every refusal string.
  if (p.includes('\0')) return false;
  // cc's own ceiling, mirrored in launcher/protocol.mjs. Bounded here so the
  // operator learns it in the form rather than as a 502 at session start.
  if (p.length > MIRROR_PATH_MAX) return false;
  // `normalize` PRESERVES a trailing separator ('/app/' normalizes to itself),
  // so it is tested separately rather than left to the round trip. `/` is its
  // own normal form despite ending in one.
  if (p !== '/' && p.endsWith('/')) return false;
  return path.posix.isAbsolute(p) && p === path.posix.normalize(p);
}

// Does `entry` cover `root` — is it the root itself, or an ancestor of it?
// path.posix.relative, never a string prefix, which would claim a merely
// prefix-SHARING sibling (`/app-backup` under `/app`) is inside.
function coversRoot(entry, root) {
  const rel = path.posix.relative(entry, root);
  return rel === '' || !(path.posix.isAbsolute(rel) || rel === '..' || rel.startsWith('../'));
}

const bad = (error) => ({ ok: false, error: `mirror: ${error}` });

/**
 * @param {unknown} raw the record's `mirror` field, or a request body's
 * @returns {{ok:true, mirror:null|{root:string, exclude:string[]}} | {ok:false, error:string}}
 *
 * EVERY MESSAGE QUOTES THE OFFENDING VALUE, and an exclude entry's index with
 * it. The card UI has no per-field error display — a 400 reaches the operator
 * as one banner sentence — so the message is the whole feedback channel.
 */
export function validateMirror(raw) {
  // OPTED OUT, and it is a legal answer rather than a missing one: cc reads a
  // descriptor with neither field as "I advertise nothing" and takes the same
  // path as a provider that never heard of the frame.
  if (raw === undefined || raw === null) return { ok: true, mirror: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return bad(`must be an object with a root and an exclude list, got ${JSON.stringify(raw)}`);
  }

  const root = raw.root;
  if (typeof root !== 'string' || root.trim() === '') {
    return bad(`root must be a non-empty absolute path, got ${JSON.stringify(root)}`);
  }
  if (!isNormalAbsolute(root)) {
    return bad(`root ${JSON.stringify(root)} is not an absolute path in normal form`
      + ' — code-conductor does not normalise a provider\'s claim about its own layout');
  }

  const exclude = [];
  if (raw.exclude !== undefined && raw.exclude !== null) {
    if (!Array.isArray(raw.exclude)) {
      return bad(`exclude must be an array of absolute paths, got ${JSON.stringify(raw.exclude)}`);
    }
    if (raw.exclude.length > MIRROR_EXCLUDE_MAX) {
      return bad(`exclude has ${raw.exclude.length} entries, over code-conductor's ${MIRROR_EXCLUDE_MAX}-entry cap`);
    }
    for (let i = 0; i < raw.exclude.length; i++) {
      const e = raw.exclude[i];
      if (typeof e !== 'string' || e.trim() === '' || !isNormalAbsolute(e)) {
        return bad(`exclude[${i}] must be an absolute path in normal form, got ${JSON.stringify(e)}`);
      }
      // OUR ONE RULE BEYOND cc's SHAPE CHECK. cc accepts this shape and then
      // refuses the SESSION with MIRROR_EXCLUDE_COVERS_PROJECT (501) at spawn,
      // because every project on this remote is under the root. It can never be
      // useful for any project here, so refusing it in the form is strictly
      // better feedback and rejects nothing usable. An exclude OUTSIDE the root
      // stays accepted — cc calls that inert, not an error.
      if (coversRoot(e, root)) {
        return bad(`exclude[${i}] ${JSON.stringify(e)} covers the mirror root ${JSON.stringify(root)},`
          + ' so no file under it could be read or written — code-conductor would refuse every session on this remote');
      }
      exclude.push(e);
    }
  }

  // Order preserved: the operator typed this list, and reordering it would make
  // the form's text and the stored value two different things.
  return { ok: true, mirror: { root, exclude } };
}
