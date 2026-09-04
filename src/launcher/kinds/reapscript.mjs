// THE KILL RELAY'S FAR-SIDE SCRIPT, shared by every kind whose children are not
// its OS descendants.
//
// `docker` and `ssh` need the identical relay for the identical reason — a
// `docker exec` child lives in the container and an `ssh` remote command lives
// on the far host, so neither dies when the host-side proxy does (measured:
// .wiki/gotchas/docker-exec-transport.md, .wiki/gotchas/ssh-controlmaster-transport.md).
// One implementation, imported by both, rather than a second copy of a script
// whose blindness detection is subtle.

// The token this exec's far-side processes carry, and the string `reap` scans
// /proc/<pid>/environ for. Children inherit an environment, so ONE pass reaches
// the whole subtree with no discovery step — and it survives a descendant that
// called setsid, which a process-group kill does not.
export const TOKEN_VAR = 'CC_EXEC_TOKEN';

export const REAP_TAG = 'CCREAP';

// SIGKILL every process on the far side whose environment carries this exec's
// token. Uses only `tr` (in §1's POSIX baseline) and shell built-ins — no
// `grep`, and no `ps`, which node:24-slim does not have.
//
// `"$t"` inside the case pattern makes the match LITERAL; unquoted it would be
// a glob. The reap invocation itself carries no token, so it cannot kill itself.
//
// The token is the core's own per-exec nonce (24 hex chars, session.mjs), so
// single-quoting it here is sound — nothing user- or frame-supplied reaches it.
//
// IT REPORTS WHETHER IT COULD SEE ANYTHING AT ALL, and that is the point.
// Without `tr`, or on a target whose `/proc/<pid>/environ` we cannot read, every
// `case` simply matches nothing and an unconditional `exit 0` would report a
// successful reap while the far-side subtree survived — the exact MUST-3 hazard
// the relay exists for, made invisible. The scanning process is itself in
// `/proc` and can always read its own environ, so `readable === 0` is an
// unambiguous "the mechanism is blind" rather than "there was nothing to see".
// Measured: with `tr` off PATH the script answers `CCREAP blind`, exit 3, on
// node:24-slim's dash, busybox's ash and debian:13-slim's dash.
export function buildReapScript(token) {
  return [
    'LC_ALL=C; export LC_ALL',
    `t='${TOKEN_VAR}=${token}'`,
    'readable=0; killed=0',
    'for d in /proc/[0-9]*; do',
    '  e=$(tr \'\\0\' \'\\n\' < "$d/environ" 2>/dev/null)',
    '  [ -n "$e" ] && readable=$((readable+1))',
    '  case "$e" in',
    '    *"$t"*) kill -9 "${d#/proc/}" 2>/dev/null; killed=$((killed+1)) ;;',
    '  esac',
    'done',
    `if [ "$readable" -eq 0 ]; then printf '${REAP_TAG} blind\\n'; exit 3; fi`,
    `printf '${REAP_TAG} ok %s %s\\n' "$killed" "$readable"`,
    'exit 0',
  ].join('\n');
}
