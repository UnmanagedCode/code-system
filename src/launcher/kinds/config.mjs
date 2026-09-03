// Shared validation for the kind-specific config fields that become ARGV.
//
// A `container`, `host` or `user` is interpolated into a command line by a
// kind's `spawnPlan` — `docker exec <container>`, `ssh <user>@<host>`. A value
// that begins with `-` is read by the far-side binary as an OPTION, not as an
// operand: `container: "-v /:/host"` or `host: "-oProxyCommand=..."` turns a
// stored remote into argument injection against docker or ssh.
//
// REFUSED HERE, at the store's front door, rather than defended against in each
// kind's spawnPlan. Cards 2026-0003 and 2026-0004 build argv from these values,
// so the rule has to hold before either exists — a validator that accepts an
// option-shaped value is a latent hole even while spawnPlan throws.
//
// Not a general shell-escaping scheme: nothing here reaches a shell (the core
// spawns argv directly, and fileops quotes everything it interpolates). This is
// specifically about the argv/option boundary.

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
