// THE FAR-SIDE PTY TRAMPOLINE, shared by every kind's terminal: the script a
// pty exec runs ON ITS TARGET, under the terminal, ahead of the program.
//
// One script for `docker`, `ssh` and `host`, for the reason reapscript.mjs is
// one: the far side's obligations are identical whatever carried us there, and
// two copies of a script whose refusals cc branches on would drift. It needs
// only `/bin/sh` and the coreutils `stty`, `tty`, `id` and `head` the tooling
// baseline already requires.
//
// WHAT IT OWES, in order (systems-protocol.md §5, "pty exec"):
//  1. A TERMINAL, proved: ssh through a multiplexed master under `PermitTTY no`
//     runs the command with NO tty (measured), so `EPTY` is answered here,
//     whatever the transport.
//  2. The CWD, entered physically; a failure is ENOENT/ENOTDIR/EACCES.
//  3. THE ENVIRONMENT, IN-BAND. With the terminal raw and `-echo`, it prints
//     `<nonce> OVERLAY` and reads exactly <N> bytes from the terminal: the
//     launcher's `overlayBlob` — the overlay, the plumbing, then `TERM`, as
//     shell-quoted `export` lines. NOTHING OF THE OVERLAY IS EVER AN ARGV
//     ELEMENT, here or on the host: /proc/<pid>/cmdline is world-readable.
//  4. The PROGRAM, pre-checked the way execvp would resolve it — on the
//     overlay's PATH, read in a subshell so this script's own tools never run
//     under the overlay — so a missing one is ENOENT, a present but unrunnable
//     one EACCES, before anything counts as started. No argv means the target
//     user's login shell, from the passwd database.
//  5. The SIZE, set before the program starts.
//  6. THE MARKER — `<nonce> STARTED <tty> <sid>` — after which every byte is the
//     program's. The launcher discards everything up to and including it.
//  7. The blob applied — only now, and only where the program inherits it —
//     and the program EXEC'D AS GIVEN (`exec "$@"`): no `env(1)`, so an
//     `argv[0]` containing `=` is a program, never an assignment.
//
// Every refusal is ONE LINE, `<nonce> <CODE>`, so the nonce — the launcher's
// per-terminal secret — is what makes a marker ours and not something a login
// profile printed.

import { shellQuote } from '../fileops.mjs';
import { cdOperand } from './config.mjs';

// What the plumbing rides ahead of the trampoline on `ssh` and `host`.
export const PTY_ENV_BIN = '/usr/bin/env';

// cc's own rule for an environment name (`ENV_NAME_RE`, src/systems/execWrap.ts),
// and exactly what a POSIX shell can `export`.
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The codes the trampoline can answer before a start. EPTY is protocol-level,
// the rest are the spawn failure's FS code (§8).
export const MARKER_CODES = ['EPTY', 'ENOENT', 'ENOTDIR', 'EACCES'];

// Positional parameters: <nonce> <cwd> <cols> <rows> <mode> <N> <argv…>, where
// <N> is the blob's byte count — a length, never a value.
//
// Its own variables are `_ccp_`-prefixed and never exported. The blob is
// `eval`ed in exactly two places: inside the `$( )` that reads PATH for the
// pre-check (a subshell running only builtins), and right before the exec —
// in the program's own subshell in `child` mode, where the trampoline stays
// as its parent: `trap :` (a no-op handler, not `''`, which a child would
// inherit as an IGNORED signal) keeps ^C from ending it, and `exit $?` hands
// back the program's status — 128+n for a signal, which is all a shell can
// report.
const SCRIPT = [
  '_ccp_n=$1',
  '[ -t 0 ] || { printf \'%s EPTY\\n\' "$_ccp_n"; exit 1; }',
  'if ! { [ -n "$2" ] && cd -P -- "$2"; } 2>/dev/null; then',
  '  if [ -z "$2" ] || [ ! -e "$2" ]; then _ccp_e=ENOENT; elif [ ! -d "$2" ]; then _ccp_e=ENOTDIR; else _ccp_e=EACCES; fi',
  '  printf \'%s %s\\n\' "$_ccp_n" "$_ccp_e"; exit 1',
  'fi',
  '_ccp_c=$3 _ccp_r=$4 _ccp_m=$5 _ccp_v=$6',
  'shift 6',
  '_ccp_g=$(stty -g)',
  'stty raw -echo',
  'printf \'%s OVERLAY\\n\' "$_ccp_n"',
  '_ccp_b=$(head -c "$_ccp_v")',
  'stty "$_ccp_g"',
  '_ccp_p=$(eval "$_ccp_b"; printf \'%sx\' "$PATH"); _ccp_p=${_ccp_p%x}',
  'if [ "$#" -gt 0 ]; then',
  '  _ccp_0=$1 _ccp_e=',
  '  case $_ccp_0 in',
  '  */*) if [ ! -e "$_ccp_0" ]; then _ccp_e=ENOENT; elif [ -d "$_ccp_0" ] || [ ! -x "$_ccp_0" ]; then _ccp_e=EACCES; fi ;;',
  '  \'\') _ccp_e=ENOENT ;;',
  '  *) _ccp_e=ENOENT _ccp_rest=$_ccp_p',
  '    while :; do',
  '      _ccp_d=${_ccp_rest%%:*}; [ -n "$_ccp_d" ] || _ccp_d=.',
  '      if [ -f "$_ccp_d/$_ccp_0" ] && [ -x "$_ccp_d/$_ccp_0" ]; then _ccp_e=; break; fi',
  '      [ -e "$_ccp_d/$_ccp_0" ] && _ccp_e=EACCES',
  '      case $_ccp_rest in *:*) _ccp_rest=${_ccp_rest#*:} ;; *) break ;; esac',
  '    done ;;',
  '  esac',
  '  [ -z "$_ccp_e" ] || { printf \'%s %s\\n\' "$_ccp_n" "$_ccp_e"; exit 1; }',
  'else',
  '  _ccp_u=$(id -u) _ccp_s=',
  '  while IFS=: read -r _ccp_x _ccp_x _ccp_id _ccp_x _ccp_x _ccp_x _ccp_sh; do',
  '    [ "$_ccp_id" = "$_ccp_u" ] && { _ccp_s=$_ccp_sh; break; }',
  '  done < /etc/passwd',
  '  set -- "${_ccp_s:-${SHELL:-/bin/sh}}" -l',
  'fi',
  'stty cols "$_ccp_c" rows "$_ccp_r" 2>/dev/null',
  '_ccp_t=$(tty)',
  // The session id: field 4 after the LAST `)` of /proc/$$/stat (a comm may hold
  // one). Empty where there is no /proc, and the reap then falls back to the
  // whole token.
  '{ read -r _ccp_st < /proc/$$/stat; } 2>/dev/null || _ccp_st=',
  '_ccp_st=${_ccp_st##*\\)}; _ccp_st=${_ccp_st# }; _ccp_st=${_ccp_st#* }; _ccp_st=${_ccp_st#* }; _ccp_st=${_ccp_st#* }',
  'printf \'%s STARTED %s %s\\n\' "$_ccp_n" "$_ccp_t" "${_ccp_st%% *}"',
  'if [ "$_ccp_m" = child ]; then',
  '  trap : INT QUIT',
  '  ( eval "$_ccp_b"; exec "$@" )',
  '  exit $?',
  'fi',
  'eval "$_ccp_b"',
  'exec "$@"',
].join('\n');

/**
 * The far-side command a kind wraps in its transport. Carries the blob's
 * LENGTH only; the blob itself goes in-band when the trampoline asks.
 *
 * @param {{nonce:string, cwd:string, cols:number, rows:number, mode:'exec'|'child',
 *          blobBytes:number, argv:string[]|null}} o
 * @returns {string[]}
 */
export function ptyTrampolineArgv({ nonce, cwd, cols, rows, mode, blobBytes, argv }) {
  return ['/bin/sh', '-c', SCRIPT, 'sh', nonce, cdOperand(cwd), String(cols), String(rows), mode,
    String(blobBytes), ...(argv ?? [])];
}

/**
 * The environment the program gets, as the trampoline reads it in-band:
 * `export NAME='value'` lines, applied in order, so a later entry wins — the
 * caller puts the overlay first, then the plumbing, then `TERM`. Every name
 * must match ENV_NAME_RE; the caller has validated them.
 * @param {[string, string][]} entries
 * @returns {Buffer}
 */
export function overlayBlob(entries) {
  return Buffer.from(entries.map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join(''), 'utf8');
}

/**
 * The trampoline's next marker in what the terminal has printed so far, or
 * null. `end` is the offset just past it. `overlay` asks for the blob;
 * `started` means everything from `end` is the program's.
 * @returns {{kind:'started', tty:string, sid:string, end:number}
 *          |{kind:'overlay', end:number}|{kind:'error', code:string, end:number}|null}
 */
export function findMarker(text, nonce) {
  const re = new RegExp(`${nonce} (?:STARTED (\\S+) ?(\\d*)|(OVERLAY)|(${MARKER_CODES.join('|')}))\\r*\\n`);
  const m = re.exec(text);
  if (!m) return null;
  const end = m.index + m[0].length;
  if (m[3]) return { kind: 'overlay', end };
  return m[4] ? { kind: 'error', code: m[4], end } : { kind: 'started', tty: m[1], sid: m[2], end };
}

/**
 * The resize relay's far-side script: set the far terminal's size directly,
 * because docker's and ssh's own relay of a resize is asynchronous and loses
 * the race to the next keystroke (measured). The tty is the marker's own.
 */
export function buildResizeScript(tty, cols, rows) {
  return `stty -F ${shellQuote(tty)} cols ${Number(cols)} rows ${Number(rows)}`;
}
