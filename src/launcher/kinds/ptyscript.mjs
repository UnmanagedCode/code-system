// THE FAR-SIDE PTY TRAMPOLINE, shared by every kind's terminal: the script a
// pty exec runs ON ITS TARGET, under the terminal, ahead of the program.
//
// One script for `docker`, `ssh` and `host`, for the reason reapscript.mjs is
// one: the far side's obligations are identical whatever carried us there, and
// two copies of a script whose refusals cc branches on would drift. It needs
// only `/bin/sh` and the coreutils `stty`, `tty`, `id` and `env` the tooling
// baseline already requires.
//
// WHAT IT OWES, in order (systems-protocol.md §5, "pty exec"):
//  1. A TERMINAL, proved: ssh through a multiplexed master under `PermitTTY no`
//     runs the command with NO tty (measured), so `EPTY` is answered here,
//     whatever the transport.
//  2. The CWD, entered physically; a failure is ENOENT/ENOTDIR/EACCES.
//  3. The PROGRAM, pre-checked the way execvp would resolve it — on the
//     overlay's PATH when it sets one — so a missing one is ENOENT before
//     anything counts as started. No argv means the target user's login shell,
//     from the passwd database.
//  4. The SIZE, set before the program starts.
//  5. THE MARKER — `<nonce> STARTED <tty> <sid>` — after which every byte is the
//     program's. The launcher discards everything up to and including it.
//  6. The program, under `env` with the assignments (the overlay, the
//     plumbing, `TERM` last). The overlay is in the PROGRAM's environment only:
//     this script, the client that carried it and the host pty never see it.
//
// Every refusal is ONE LINE, `<nonce> <CODE>`, so the nonce — the launcher's
// per-terminal secret — is what makes a marker ours and not something a login
// profile printed.

import { shellQuote } from '../fileops.mjs';
import { cdOperand } from './config.mjs';

export const PTY_ENV_BIN = '/usr/bin/env';

// The codes the trampoline can answer before a start. EPTY is protocol-level,
// the rest are the spawn failure's FS code (§8).
export const MARKER_CODES = ['EPTY', 'ENOENT', 'ENOTDIR', 'EACCES'];

// Positional parameters: <nonce> <cwd> <cols> <rows> <mode> <k> <k assignments…> <argv…>.
// Its own variables are `_ccp_`-prefixed and never exported, so nothing of the
// script's reaches the program's environment.
//
// `child` mode stays as the program's parent: `trap :` (a no-op handler, not
// `''`, which an `env` child would inherit as an IGNORED signal) keeps ^C from
// ending the trampoline, and `exit $?` hands back the program's status — 128+n
// for a signal, which is all a shell can report.
const SCRIPT = [
  '_ccp_n=$1',
  '[ -t 0 ] || { printf \'%s EPTY\\n\' "$_ccp_n"; exit 1; }',
  'if ! { [ -n "$2" ] && cd -P -- "$2"; } 2>/dev/null; then',
  '  if [ -z "$2" ] || [ ! -e "$2" ]; then _ccp_e=ENOENT; elif [ ! -d "$2" ]; then _ccp_e=ENOTDIR; else _ccp_e=EACCES; fi',
  '  printf \'%s %s\\n\' "$_ccp_n" "$_ccp_e"; exit 1',
  'fi',
  '_ccp_c=$3 _ccp_r=$4 _ccp_m=$5 _ccp_k=$6',
  'shift 6',
  '_ccp_p=$PATH _ccp_i=0',
  'for _ccp_a do',
  '  [ "$_ccp_i" -lt "$_ccp_k" ] || break',
  '  case $_ccp_a in PATH=*) _ccp_p=${_ccp_a#PATH=} ;; esac',
  '  _ccp_i=$((_ccp_i+1))',
  'done',
  'if [ "$#" -gt "$_ccp_k" ]; then',
  '  eval "_ccp_0=\\${$((_ccp_k+1))}"',
  '  _ccp_e=ENOENT',
  '  case $_ccp_0 in',
  '  */*) if [ -e "$_ccp_0" ]; then { [ -f "$_ccp_0" ] && [ -x "$_ccp_0" ]; } && _ccp_e= || _ccp_e=EACCES; fi ;;',
  '  ?*) _ccp_rest=$_ccp_p',
  '    while :; do',
  '      _ccp_d=${_ccp_rest%%:*}; [ -n "$_ccp_d" ] || _ccp_d=.',
  '      if [ -f "$_ccp_d/$_ccp_0" ]; then [ -x "$_ccp_d/$_ccp_0" ] && { _ccp_e=; break; }; _ccp_e=EACCES; fi',
  '      case $_ccp_rest in *:*) _ccp_rest=${_ccp_rest#*:} ;; *) break ;; esac',
  '    done ;;',
  '  esac',
  '  [ -z "$_ccp_e" ] || { printf \'%s %s\\n\' "$_ccp_n" "$_ccp_e"; exit 1; }',
  'else',
  '  _ccp_u=$(id -u) _ccp_s=',
  '  while IFS=: read -r _ccp_x _ccp_x _ccp_id _ccp_x _ccp_x _ccp_x _ccp_sh; do',
  '    [ "$_ccp_id" = "$_ccp_u" ] && { _ccp_s=$_ccp_sh; break; }',
  '  done < /etc/passwd',
  '  set -- "$@" "${_ccp_s:-${SHELL:-/bin/sh}}" -l',
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
  `  ${PTY_ENV_BIN} -- "$@"`,
  '  exit $?',
  'fi',
  `exec ${PTY_ENV_BIN} -- "$@"`,
].join('\n');

/**
 * The far-side command a kind wraps in its transport.
 *
 * @param {{nonce:string, cwd:string, cols:number, rows:number, mode:'exec'|'child',
 *          assignments:string[], argv:string[]|null}} o
 *   `assignments` are `KEY=VALUE` words, applied by the final `env` in order —
 *   the caller puts `TERM` last so it beats an overlay `TERM`.
 * @returns {string[]}
 */
export function ptyTrampolineArgv({ nonce, cwd, cols, rows, mode, assignments, argv }) {
  return ['/bin/sh', '-c', SCRIPT, 'sh', nonce, cdOperand(cwd), String(cols), String(rows), mode,
    String(assignments.length), ...assignments, ...(argv ?? [])];
}

/**
 * The trampoline's marker in what the terminal has printed so far, or null.
 * `end` is the offset just past it: everything from there is the program's.
 * @returns {{kind:'started', tty:string, sid:string, end:number}|{kind:'error', code:string, end:number}|null}
 */
export function findMarker(text, nonce) {
  const re = new RegExp(`${nonce} (?:STARTED (\\S+) ?(\\d*)|(${MARKER_CODES.join('|')}))\\r*\\n`);
  const m = re.exec(text);
  if (!m) return null;
  const end = m.index + m[0].length;
  return m[3] ? { kind: 'error', code: m[3], end } : { kind: 'started', tty: m[1], sid: m[2], end };
}

/**
 * The resize relay's far-side script: set the far terminal's size directly,
 * because docker's and ssh's own relay of a resize is asynchronous and loses
 * the race to the next keystroke (measured). The tty is the marker's own.
 */
export function buildResizeScript(tty, cols, rows) {
  return `stty -F ${shellQuote(tty)} cols ${Number(cols)} rows ${Number(rows)}`;
}
