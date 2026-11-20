# The agent wire

How a dial-in agent (`agent/agent.py`) and the broker (`src/agent/broker.mjs`)
talk, and how a bridge (`src/agent/bridge.mjs`) reaches the broker. The cc-facing
contract of the `agent` kind is in [`protocol.md`](protocol.md#agent--what-goes-on-the-wire);
the processes and their lifetimes are in [`architecture.md`](architecture.md#the-agent-broker).

## The single source of truth

Every constant and every frame shape lives in the `PROTOCOL` JSON literal
between `# BEGIN PROTOCOL` / `# END PROTOCOL` in `agent/agent.py`. Python
`json.loads` it; `src/agent/protocol.mjs` reads the same block out of the same
file (`extractProtocol`). Nothing restates a value it owns —
`tests/agentprotocol.test.mjs` scans `src/agent/*.mjs` and the kind for that.

| Key | Meaning |
|---|---|
| `version` | the protocol version a `hello` carries; any other is `version_mismatch` |
| `labels.agent` / `labels.broker` | MAC domain labels, one per direction |
| `labels.keyId` | the prefix hashed into a key id |
| `nonceBytes`, `sessionBytes`, `keyIdHexChars` | sizes of the nonces, the session id and the key id |
| `maxPreauthLineBytes` | line cap before authentication |
| `maxHttpHeaderBytes` | header cap for the `GET /agent.py` sniff |
| `maxFrameBytes` | line cap after authentication, and on the broker's unix socket |
| `chunkBytes` | the most bytes one `out` / `in` frame carries |
| `windowBytes` | credit: the most unacknowledged bytes per stream per direction |
| `ptyInputWindowBytes` | a terminal bridge's stdin credit instead: cc credits terminal input as it reaches the host pty, so input absorbed in flight reads to cc as input the program took |
| `maxPendingHandshakes` | connections that may be mid-handshake at once |
| `maxStreamsPerSession` | concurrent commands per agent session |
| `timings.*` | `handshakeTimeoutMs`, `pingIntervalMs`, `keepaliveTimeoutMs`, `brokerTickMs`, `backoffBaseMs`, `backoffCapMs`, `backoffStableMs` |
| `refusalCodes`, `byeCodes` | the codes a `refused` / `bye` frame may carry |
| `wire` | frame shapes on the TCP connection |
| `control` | frame shapes a bridge or client sends on the unix socket |

**Test seam:** `CODE_SYSTEM_AGENT_TIMINGS` — a JSON object overriding any
`timings` key (positive numbers only), read by the agent, the broker and the
bridge. Tests only.

## Framing

- NDJSON: one JSON object per line; `t` names the frame; binary data is
  canonical base64 in `b64`.
- **Shapes are exact**: every key of `PROTOCOL.wire[t]` (a `?` suffix marks one
  optional), no other key, each of its type — `str`, `hex` (lower-case),
  `int` (non-negative), `bool`, `strlist`, `strmap`, `b64` (canonical: it must
  re-encode to itself), `size` (`{cols, rows}`), `int|null`, `str|null`.
  `check_shape` (Python) and `checkShape` (node) implement the same rules.
- An over-long line or a bad shape is `bad_frame`, and the connection closes.

## The handshake (the agent speaks first)

| # | dir | frame |
|---|---|---|
| 1 | agent → broker | `hello {v, remoteId, nonce: Na}` |
| 2 | broker → agent | `challenge {nonce: Nb}` — **always**, whether or not the remote exists |
| 3 | agent → broker | `auth {mac: H(secret, [labels.agent, remoteId, Nb, Na])}` |
| 4 | broker → agent | `welcome {session, mac: H(secret, [labels.broker, remoteId, Nb, Na, session])}` or `refused {code, message}`, then close |
| 5 | agent → broker | `info {host, python, pid, agentVersion}` — only after the agent verified the welcome MAC |

- `H` is HMAC-SHA256, hex, keyed by the secret's UTF-8, over the fields joined
  with `\n`. The two labels separate the directions; fresh nonces on both sides
  defeat replay; comparisons are constant-time (`hmac.compare_digest`,
  `timingSafeEqual` after a length check).
- **The secret never crosses the wire.** `tests/broker-auth.test.mjs` captures
  every byte of a real session through a proxy and searches it.
- **The agent authenticates the broker too.** A `welcome` whose MAC does not
  verify is a refusal: the agent runs nothing and redials at the backoff cap.
- The broker **re-reads the record's secret on every handshake** (no cache).
- **One refusal on the wire, three causes kept locally.** An unknown remote id,
  a record of another kind and a wrong MAC all answer the same
  `refused {code: auth_failed}`. The broker keeps the true reason:
  `wrong-secret` (or `no-secret`) per remote, shown on that card's probe;
  `unknown-remote` / `not-an-agent-remote` in a list of the last few, shown on
  the page's listener line (`GET /api/agent/broker` → `refusals`).
- `refused` codes: `auth_failed`, `version_mismatch` (names the fetch URL),
  `bad_frame`, `busy` (past `maxPendingHandshakes`), `timeout` (past
  `timings.handshakeTimeoutMs`).

### `GET /agent.py` on the same port

A first line matching `<METHOD> <path> HTTP/1.x` is answered as HTTP, under the
same pre-auth caps (headers capped at `maxHttpHeaderBytes`):

| Request | Answer |
|---|---|
| `GET /agent.py` | `200 text/x-python; charset=utf-8`: the agent bytes the broker read at startup (the same file its build id hashed) |
| `GET` any other path | `404` |
| any other method | `405` |
| headers too large | `431` |

## Session frames

`s` is a stream id the broker assigns. One session per remote; many streams per
session (`maxStreamsPerSession`).

| Frame | Dir | Meaning |
|---|---|---|
| `open {s, argv, cwd, env, stdin, pty?}` | B→A | `Popen(argv, cwd, env={**agent env, **env}, start_new_session=True)`. `env` is an **overlay**; a frame env that replaces rides argv as `env -i --` (the kind composes it). `stdin: false` is `/dev/null`. `pty: {cols, rows}` opens a pty, makes it the controlling terminal (`TIOCSCTTY`) and sets its size |
| `started {s, pid}` | A→B | the command runs; `pid` leads its own process group and session |
| `failed {s, errno, message}` | A→B | it never started (`ENOENT`, `EACCES`, `ENOTDIR`, …), for the program or the cwd |
| `out {s, fd, b64}` | A→B | stdout (`fd` 1) or stderr (2); a terminal has fd 1 only |
| `in {s, b64}` / `eof {s}` | B→A | stdin bytes / stdin end (not used for a terminal) |
| `ack {s, fd, n}` | both | credit returned for `n` bytes **written to their destination** (`fd` 0: stdin; 1/2: output) |
| `resize {s, cols, rows}` | B→A | `TIOCSWINSZ` on the pty master; the kernel sends SIGWINCH |
| `exit {s, code, signal}` | A→B | after the process is reaped AND its output drained; `signal` is a name (`SIGINT`) and then `code` is null |
| `close {s}` | B→A | the bridge went away. Non-pty: close stdin, keep draining output, **kill nothing**. Pty: close the master (a hang-up) |
| `ping` / `pong` | both | every `timings.pingIntervalMs`; a peer silent for `timings.keepaliveTimeoutMs` is dead. Plus `SO_KEEPALIVE` |
| `bye {code, message}` | both | `replaced`, `stale-key`, `shutdown`, `keepalive` |

### Credit

At most `windowBytes` unacknowledged per stream per direction. The **end
points** exchange it — agent and bridge — and the broker only rewrites `s`.
The agent stops reading a pipe or pty master while out of credit, so a launcher
that stops reading stops the far process, and every buffer between is bounded.

### When a session ends

| Cause | Broker | Agent |
|---|---|---|
| a newer session for the same remote authenticates | `bye replaced` to the old one; the card's replacement count goes up | the old agent ends its commands and redials |
| the record's secret changed, or the record is gone (broker tick, `timings.brokerTickMs`) | `bye stale-key` | ends its commands; its next `auth` is `wrong-secret` |
| TCP loss, keepalive timeout | — | ends its commands, redials |
| the broker stops (`stop`, SIGTERM/SIGINT, no agent record left) | `bye shutdown` | ends its commands, redials |
| the agent gets SIGTERM/SIGINT | — | ends its commands, sends `bye shutdown`, exits 0 |

**"Ends its commands"**: every process group the session started gets SIGKILL
(a terminal's gets SIGHUP first) — including groups whose leader already
exited, which is where a detached command's background jobs live. A job that
called `setsid` has left its group and survives. **An agent killed with
SIGKILL ends nothing**: its commands keep running.

Every bridge attached to an ending session gets `lost` (or `stale-key`) and
exits 255 with its marker line (below).

### Reconnect

Exponential backoff with jitter: the ceiling doubles from
`timings.backoffBaseMs` up to `timings.backoffCapMs`; a delay is drawn from
`[min(base, ceiling), ceiling]`. It resets to base only after a session that
lived at least `timings.backoffStableMs`. A refusal (`auth_failed`,
`version_mismatch`, an unproven broker) jumps to the cap. **The agent never
exits on a refusal**, so it can be started before its card exists.

### The agent refuses to start

| Condition | Exit |
|---|---|
| not Linux, or Python < 3.9 | 2 |
| `CODE_SYSTEM_AGENT_SECRET` unset or empty | 2 |
| `--secret…` / `--key…` on the command line (argv is world-readable) | 2 |
| `--connect` not `host:port` (`[v6]:port` allowed), `--remote` missing | 2 |

The secret is removed from the agent's own environment before any command
starts, so no command inherits it.

## Bridge ⇄ broker (the unix socket)

`<store>/agent/broker.sock`, in a directory of mode 0700 that is **refused, not
repaired**, when its owner or mode is wrong; a socket path past
`SOCKET_PATH_MAX` (`src/paths.mjs`) is refused naming `CODE_SYSTEM_STORE`.
Same codec, `maxFrameBytes` cap. The first frame chooses the mode:

| First frame | Answer |
|---|---|
| `open {remoteId, keyId, argv, cwd, env, stdin, pty?}` | the connection becomes ONE stream: `started`/`failed`/`out`/`ack`/`exit` arrive without `s`; the bridge sends `in`/`eof`/`ack`/`resize`. Or `refused {tag, message}` and close |
| `status {remoteId}` | `{t:'status', remoteId, connected, session?, keyId?, peer?, since?, host?, agentPid?, python?, lastRefusal, replacements}` — never the secret |
| `ping` | `{t:'pong', pid, listen, address, build}` |
| `stop` | `{t:'stopping'}`, then the broker shuts down |
| `refusals` | `{t:'refusals', items:[{remoteId, reason, peer, at}]}` |

`keyId` is `keyIdOf(secret)` — a prefix of `sha256(labels.keyId + "\n" + secret)`.
The bridge carries the key id derived from the **current** config; a session
authenticated with another is refused `stale-key`.

### The bridge's outcome line

When the outcome is the bridge's own, it writes one stderr line
`code-system-agent: <tag> <message>` and exits **127** (`never-started`) or
**255** (every other tag). Otherwise it exits as the far command did: its code,
or 128+n for a signal — in a terminal it re-raises the signal on itself instead.

| Tag | Meaning |
|---|---|
| `broker-down` | nothing answers on the socket; quotes `broker-error.json` when present |
| `not-connected` | no session for the remote; names the last refusal |
| `stale-key` | the session used a previous secret |
| `too-many-streams` | `maxStreamsPerSession` reached |
| `lost` | the session ended while the command ran |
| `never-started <ERRNO>` | the agent's `failed`, with its own message |
