// Shared validation for the kind-specific config fields that become ARGV.
//
// A `container`, `host` or `user` is interpolated into a command line by a
// kind's `spawnPlan` — `docker exec <container>`, `ssh <user>@<host>`. A value
// that begins with `-` is read by the far-side binary as an OPTION, not as an
// operand: `container: "-v /:/host"` or `host: "-oProxyCommand=..."` turns a
// stored remote into argument injection against docker or ssh.
//
// REFUSED HERE, at the store's front door, rather than defended against in each
// kind's spawnPlan. `docker`'s spawnPlan places `container` after `--` and
// `ssh`'s interpolates `host`/`user`; the rule had to hold before
// either existed, because a validator that accepts an option-shaped value is a
// latent hole even while spawnPlan throws.
//
// Not a general shell-escaping scheme. This is specifically about the
// argv/option boundary, and the boundary is all it defends.
//
// BE PRECISE ABOUT WHERE A SHELL IS AND IS NOT IN PLAY, because it differs by
// kind. For `host` and `docker` nothing validated here reaches a shell at all:
// the core spawns argv directly, and fileops quotes everything it interpolates.
// For `ssh` that is FALSE — `ssh` takes a SHELL STRING, not an argv, so the
// remote command is tokenized by the target's login shell (measured; see
// .wiki/gotchas/ssh-controlmaster-transport.md). `kinds/ssh.mjs` therefore
// quotes every token it interpolates with fileops' `shellQuote` and hands ssh
// ONE argv element. None of that changes this file's job: a leading `-` in a
// stored `host`/`user` is an OPTION to the local ssh client, before any remote
// shell exists, which is why it is refused here.

/**
 * @returns {{ok:true, value:string}|{ok:false, error:string}}
 */
export function operand(raw, field, { required = true } = {}) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return required
      ? { ok: false, error: `'${field}' is required and must be a non-empty string` }
      : { ok: true, value: '' };
  }
  if (value.startsWith('-')) {
    return {
      ok: false,
      error: `'${field}' must not start with '-' (got ${JSON.stringify(value)})`
        + ' — it becomes a command-line operand, and a leading dash makes it an option instead',
    };
  }
  return { ok: true, value };
}

export function asObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// THE ENVIRONMENT A COMMAND RUNS WITH, composed once for every host-shaped kind.
//
// `frameEnv` is THE FRAME'S OWN `env`, and `null` means "inherit the FAR SIDE's
// environment" — which on cc's own host is `process.env` and inside a container
// is the container's own PATH/HOME/toolchain (see kinds/docker.mjs, which does
// not call this for the inherit case at all). session.mjs must not collapse the
// two: cc sends no `env` on ANY `exec` it issues — its own plumbing and a
// caller's command alike — so "every command therefore runs in the provider's
// own environment … the far side's PATH and toolchain, not cc's"
// (systems-protocol.md §7). A variable a command needs rides in argv via
// `env(1)`, which ADDS rather than replaces.
//
// CC_REMOTE is overlaid AFTER the frame's wholesale replacement, so THE
// PROVIDER'S BINDING BEATS A FRAME-SUPPLIED VALUE — §10's CC_REMOTE row, and
// the routing lie it exists to prevent. Pinned by tests/hostkind.test.mjs →
// "the provider's binding beats a frame-supplied value".
export function execEnv(frameEnv, remoteId, base = process.env) {
  const overlay = remoteId ? { CC_REMOTE: remoteId } : {};
  // Nothing to compose: let the child inherit, rather than materialising a copy.
  if (frameEnv === null && !remoteId) return null;
  return { ...(frameEnv ?? base), ...overlay };
}
