#!/usr/bin/env python3
# code-system agent: dials code-system's agent listener over TCP, proves it
# knows its remote's secret, and runs the commands cc sends it.
#
# ONE FILE, STANDARD LIBRARY ONLY, PYTHON >= 3.9, LINUX ONLY. It is fetched with
#   curl -fsS http://<dial>/agent.py | CODE_SYSTEM_AGENT_SECRET='<s>' python3 - --connect <dial> --remote <id>
# so nothing beside this file can be assumed on the machine it runs on.
#
# THE SECRET IS READ FROM THE ENVIRONMENT ONLY, and it is removed from this
# process's environment before any command starts: every command this agent
# runs inherits its environment, and a secret left there would be readable by
# all of them (and by anyone who can read their /proc/<pid>/environ).
#
# Wire protocol: docs/agent-wire.md in the code-system repository. Its
# constants live in the PROTOCOL block below, which the code-system side reads
# from this very file, so the two cannot drift.
#
# Copyright (c) 2026 UnmanagedCode. AGPL-3.0-or-later.

import base64
import binascii
import errno
import fcntl
import hashlib
import hmac
import json
import marshal
import os
import platform
import random
import selectors
import signal
import socket
import struct
import subprocess
import sys
import termios
import time

# BEGIN PROTOCOL
PROTOCOL_JSON = r'''
{
  "version": 1,
  "labels": {
    "agent": "code-system-agent/1 agent",
    "broker": "code-system-agent/1 broker",
    "keyId": "code-system-agent key"
  },
  "nonceBytes": 32,
  "sessionBytes": 16,
  "keyIdHexChars": 16,
  "maxPreauthLineBytes": 4096,
  "maxHttpHeaderBytes": 8192,
  "maxFrameBytes": 131072,
  "chunkBytes": 65536,
  "windowBytes": 262144,
  "ptyInputWindowBytes": 65536,
  "maxPendingHandshakes": 32,
  "maxStreamsPerSession": 256,
  "timings": {
    "handshakeTimeoutMs": 5000,
    "pingIntervalMs": 5000,
    "keepaliveTimeoutMs": 15000,
    "brokerTickMs": 1000,
    "backoffBaseMs": 500,
    "backoffCapMs": 30000,
    "backoffStableMs": 10000
  },
  "refusalCodes": ["auth_failed", "version_mismatch", "bad_frame", "busy", "timeout"],
  "byeCodes": ["replaced", "stale-key", "shutdown", "keepalive", "credit"],
  "wire": {
    "hello": {"v": "int", "remoteId": "str", "nonce": "hex"},
    "challenge": {"nonce": "hex"},
    "auth": {"mac": "hex"},
    "welcome": {"session": "hex", "mac": "hex"},
    "refused": {"code": "str", "message": "str"},
    "info": {"host": "str", "python": "str", "pid": "int", "agentVersion": "str"},
    "open": {"s": "int", "argv": "argv", "cwd": "str", "env": "strmap", "stdin": "bool", "pty?": "size"},
    "started": {"s": "int", "pid": "int"},
    "failed": {"s": "int", "errno": "str", "message": "str"},
    "out": {"s": "int", "fd": "int", "b64": "b64"},
    "in": {"s": "int", "b64": "b64"},
    "eof": {"s": "int"},
    "ack": {"s": "int", "fd": "int", "n": "int"},
    "resize": {"s": "int", "cols": "int", "rows": "int"},
    "exit": {"s": "int", "code": "int|null", "signal": "str|null"},
    "close": {"s": "int"},
    "ping": {},
    "pong": {},
    "bye": {"code": "str", "message": "str"}
  },
  "control": {
    "open": {"remoteId": "str", "keyId": "hex", "argv": "argv", "cwd": "str", "env": "strmap", "stdin": "bool", "pty?": "size"},
    "status": {"remoteId": "str"},
    "ping": {},
    "stop": {},
    "refusals": {},
    "in": {"b64": "b64"},
    "eof": {},
    "ack": {"fd": "int", "n": "int"},
    "resize": {"cols": "int", "rows": "int"}
  },
  "toBridge": {
    "started": {"pid": "int"},
    "failed": {"errno": "str", "message": "str"},
    "out": {"fd": "int", "b64": "b64"},
    "ack": {"fd": "int", "n": "int"},
    "exit": {"code": "int|null", "signal": "str|null"},
    "lost": {"tag": "str", "message": "str"},
    "refused": {"tag": "str", "message": "str"}
  }
}
'''
# END PROTOCOL
PROTOCOL = json.loads(PROTOCOL_JSON)

# This module's own code object, so the agent can re-execute ITSELF even when it
# was read from stdin (`curl … | python3 -`) and no file holds its source.
_MODULE_CODE = sys._getframe().f_code

SECRET_ENV = 'CODE_SYSTEM_AGENT_SECRET'
# INTERNAL: the agent re-executes itself once at startup (see
# `reexec_without_secret`); the bootstrap hands the secret to the new process's
# module namespace under this name, and `main` takes it out again.
INHERITED_SECRET = '_inherited_secret'
TIMINGS_ENV = 'CODE_SYSTEM_AGENT_TIMINGS'
AGENT_VERSION = str(PROTOCOL['version'])
TAG = 'code-system-agent'

USAGE = """usage: agent.py --connect <host:port> --remote <remoteId>

Dials code-system's agent listener at <host:port> and serves the remote
<remoteId>. The remote's secret is read from the environment variable
%s and never from the command line.

  --connect HOST:PORT   the agent listener's address, as seen from this machine
  --remote ID           the remote's id, as shown on its card
  --help                show this text

Linux only; Python 3.9 or later; standard library only. It reconnects on its
own, with backoff, and keeps running when its card does not exist yet.
""" % SECRET_ENV


def log(msg):
    try:
        sys.stderr.write('%s: %s\n' % (TAG, msg))
        sys.stderr.flush()
    except Exception:
        pass


# ── protocol helpers (mirrored by src/agent/protocol.mjs) ────────────────

def timings(env=None):
    """The timing constants, with the test-only override applied."""
    env = os.environ if env is None else env
    out = dict(PROTOCOL['timings'])
    raw = env.get(TIMINGS_ENV, '').strip()
    if raw:
        over = json.loads(raw)
        for k, v in over.items():
            if k in out and isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                out[k] = v
    return out


def mac(secret, fields):
    msg = '\n'.join(fields).encode('utf-8')
    return hmac.new(secret.encode('utf-8'), msg, hashlib.sha256).hexdigest()


def verify_mac(secret, fields, got):
    if not isinstance(got, str):
        return False
    return hmac.compare_digest(mac(secret, fields).encode('ascii'), got.encode('utf-8', 'replace'))


def key_id_of(secret):
    digest = hashlib.sha256(('%s\n%s' % (PROTOCOL['labels']['keyId'], secret)).encode('utf-8')).hexdigest()
    return digest[:PROTOCOL['keyIdHexChars']]


class BadFrame(Exception):
    pass


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _check_value(v, typ):
    if typ == 'str':
        return isinstance(v, str)
    if typ == 'hex':
        return isinstance(v, str) and len(v) > 0 and all(c in '0123456789abcdef' for c in v)
    if typ == 'int':
        return _is_int(v)
    if typ == 'bool':
        return isinstance(v, bool)
    if typ == 'strlist':
        return isinstance(v, list) and all(isinstance(x, str) for x in v)
    if typ == 'argv':
        return isinstance(v, list) and len(v) > 0 and all(isinstance(x, str) for x in v)
    if typ == 'strmap':
        return isinstance(v, dict) and all(isinstance(k, str) and isinstance(x, str) for k, x in v.items())
    if typ == 'b64':
        if not isinstance(v, str):
            return False
        try:
            raw = base64.b64decode(v.encode('ascii'), validate=True)
        except (binascii.Error, ValueError, UnicodeEncodeError):
            return False
        return base64.b64encode(raw).decode('ascii') == v
    if typ == 'size':
        return (isinstance(v, dict) and set(v.keys()) == {'cols', 'rows'}
                and _is_int(v['cols']) and _is_int(v['rows']))
    if typ == 'int|null':
        return v is None or _is_int(v)
    if typ == 'str|null':
        return v is None or isinstance(v, str)
    raise ValueError('unknown type %r' % typ)


def check_shape(frame, table):
    """Exact keys and types, or BadFrame. `table` maps frame name → spec."""
    if not isinstance(frame, dict) or not isinstance(frame.get('t'), str):
        raise BadFrame('a frame is an object with a string `t`')
    spec = table.get(frame['t'])
    if spec is None:
        raise BadFrame('unknown frame %r' % frame['t'])
    keys = set(frame.keys()) - {'t'}
    for name, typ in spec.items():
        optional = name.endswith('?')
        key = name[:-1] if optional else name
        if key not in frame:
            if optional:
                continue
            raise BadFrame('frame %r lacks %r' % (frame['t'], key))
        keys.discard(key)
        if not _check_value(frame[key], typ):
            raise BadFrame('frame %r: %r is not %s' % (frame['t'], key, typ))
    if keys:
        raise BadFrame('frame %r has unexpected keys %s' % (frame['t'], sorted(keys)))
    return frame


def encode(frame):
    return (json.dumps(frame, separators=(',', ':')) + '\n').encode('utf-8')


class LineBuffer(object):
    """Splits a byte stream into lines, refusing one longer than `cap`."""

    def __init__(self, cap):
        self.cap = cap
        self.buf = bytearray()

    def push(self, data):
        self.buf += data
        lines = []
        while True:
            i = self.buf.find(b'\n')
            if i < 0:
                break
            if i > self.cap:
                raise BadFrame('a line is longer than %d bytes' % self.cap)
            lines.append(bytes(self.buf[:i]))
            del self.buf[:i + 1]
        if len(self.buf) > self.cap:
            raise BadFrame('a line is longer than %d bytes' % self.cap)
        return lines


def decode_line(line, table):
    try:
        frame = json.loads(line.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        raise BadFrame('a line is not JSON')
    return check_shape(frame, table)


# ── reconnect backoff ───────────────────────────────────────────────────

class Backoff(object):
    """Exponential backoff with full jitter.

    The ceiling doubles from `base` up to `cap` on each failed or short-lived
    attempt; a delay is drawn uniformly from [min(base, ceiling), ceiling]. It
    returns to `base` only after a session that lived at least `stable`
    seconds, so an agent that connects and is dropped at once cannot reconnect
    in a tight loop. A refusal (wrong secret, wrong version) waits AT LEAST
    the cap, jittered upward to at most a quarter more: retrying sooner cannot
    succeed.
    """

    def __init__(self, base, cap, stable, rng=None, clock=None):
        self.base = base
        self.cap = cap
        self.stable = stable
        self.rng = rng or random.random
        self.clock = clock or time.monotonic
        self.attempt = 0
        self.started = None
        self.refused = False

    def ceiling(self):
        return min(self.cap, self.base * (2 ** self.attempt))

    def session_started(self):
        self.started = self.clock()

    def session_ended(self):
        if self.started is not None and self.clock() - self.started >= self.stable:
            self.attempt = 0
        self.started = None

    def refusal(self):
        self.refused = True

    def next_delay(self):
        if self.refused:
            self.refused = False
            return self.cap * (1 + 0.25 * self.rng())
        top = self.ceiling()
        low = min(self.base, top)
        delay = low + (top - low) * self.rng()
        self.refused = False
        if self.base * (2 ** self.attempt) < self.cap:
            self.attempt += 1
        return delay


# ── startup checks ──────────────────────────────────────────────────────

class UsageError(Exception):
    pass


def platform_refusal(plat=None, version=None):
    plat = sys.platform if plat is None else plat
    version = sys.version_info if version is None else version
    if not plat.startswith('linux'):
        return 'the code-system agent runs on Linux only (this is %s)' % plat
    if tuple(version[:2]) < (3, 9):
        return 'the code-system agent needs Python 3.9 or later (this is %d.%d)' % tuple(version[:2])
    return None


def parse_args(argv):
    out = {'connect': None, 'remote': None, 'help': False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ('--help', '-h'):
            out['help'] = True
        elif a == '--connect' or a == '--remote':
            if i + 1 >= len(argv):
                raise UsageError('%s needs a value' % a)
            out[a[2:]] = argv[i + 1]
            i += 1
        elif a.startswith('--secret') or a.startswith('--key'):
            raise UsageError('the secret is never accepted on the command line (anyone on this machine can'
                             ' read a process\'s arguments) - set %s instead' % SECRET_ENV)
        else:
            raise UsageError('unknown argument %r' % a)
        i += 1
    if out['help']:
        return out
    if not out['connect'] or not out['remote']:
        raise UsageError('--connect <host:port> and --remote <remoteId> are both required')
    parse_address(out['connect'])
    return out


def parse_address(spec):
    host, sep, port = spec.rpartition(':')
    if not sep or not host or not port.isdigit() or not (0 < int(port) < 65536):
        raise UsageError('--connect wants <host:port>, got %r' % spec)
    if host.startswith('[') and host.endswith(']'):
        host = host[1:-1]
    return host, int(port)


# ── the session ─────────────────────────────────────────────────────────

class Refused(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, '%s: %s' % (code, message))
        self.code = code


class Lost(Exception):
    pass


class Shutdown(Exception):
    pass


WIRE = PROTOCOL['wire']
CHUNK = PROTOCOL['chunkBytes']
WINDOW = PROTOCOL['windowBytes']


class Stream(object):
    def __init__(self, s, proc, pty_master=None):
        self.s = s
        self.proc = proc
        self.pgid = proc.pid
        self.master = pty_master
        # output fd number (1 or 2) → os-level fd, while open
        self.outs = {}
        self.stdin_fd = None
        self.stdin_queue = []
        self.stdin_eof = False
        self.credit = WINDOW
        self.orphaned = False
        self.code = None
        self.signal = None
        self.reaped = False
        self.done = False
        # The leader's start time, which tells our process group from a later
        # one that reused its id.
        self.started = proc_starttime(proc.pid)


def _signal_name(n):
    try:
        return signal.Signals(n).name
    except ValueError:
        return 'SIG%d' % n


def proc_starttime(pid):
    """Field 22 of /proc/<pid>/stat (clock ticks since boot), or None."""
    try:
        with open('/proc/%d/stat' % pid, 'rb') as f:
            stat = f.read()
    except OSError:
        return None
    try:
        return int(stat[stat.rindex(b')') + 2:].split()[19])
    except (ValueError, IndexError):
        return None


def group_is_ours(pgid, started, starttime=proc_starttime, killpg=os.killpg):
    """Whether process group `pgid` is still the one we started.

    A pid in use as a process group id is never handed out again, so: a live
    process with pid == pgid is our leader only if its start time is the one
    we recorded; with no such process, a group that still has members is ours
    (its leader died, its background jobs did not).
    """
    if not isinstance(pgid, int) or pgid <= 1 or pgid == os.getpgrp():
        return False
    now = starttime(pgid)
    if now is not None:
        return now == started
    try:
        killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _set_nonblocking(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


def _set_winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))


def _make_controlling_tty():
    # Runs in the child after setsid (start_new_session): the pty slave on fd 0
    # becomes this new session's controlling terminal, which is what makes ^C
    # and a hang-up reach the program.
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


class Session(object):
    """One authenticated connection: a stream multiplexer over the socket."""

    def __init__(self, sock, remote_id, session_id, tim):
        self.sock = sock
        self.remote_id = remote_id
        self.session_id = session_id
        self.tim = tim
        self.sel = selectors.DefaultSelector()
        self.outbuf = bytearray()
        self.lines = LineBuffer(PROTOCOL['maxFrameBytes'])
        self.streams = {}
        # Every process group this session started, while it may still have
        # members — including groups whose leader has exited, which is where a
        # detached command's background jobs live.
        self.groups = {}
        now = time.monotonic()
        self.last_rx = now
        self.next_ping = now + tim['pingIntervalMs'] / 1000.0
        self.sock_events = 0
        sock.setblocking(False)
        self._sock_interest(selectors.EVENT_READ)

    # ── socket ──

    def _sock_interest(self, events):
        if events == self.sock_events:
            return
        if self.sock_events == 0:
            self.sel.register(self.sock, events, ('sock', None))
        else:
            self.sel.modify(self.sock, events, ('sock', None))
        self.sock_events = events

    def send(self, frame):
        self.outbuf += encode(frame)
        self._flush()

    def _flush(self):
        while self.outbuf:
            try:
                n = self.sock.send(self.outbuf)
            except (BlockingIOError, InterruptedError):
                break
            except OSError as e:
                raise Lost('the connection failed while sending: %s' % e)
            del self.outbuf[:n]
        want = selectors.EVENT_READ | (selectors.EVENT_WRITE if self.outbuf else 0)
        self._sock_interest(want)

    def _on_sock(self, mask):
        if mask & selectors.EVENT_WRITE:
            self._flush()
        if mask & selectors.EVENT_READ:
            try:
                data = self.sock.recv(1 << 16)
            except (BlockingIOError, InterruptedError):
                return
            except OSError as e:
                raise Lost('the connection failed: %s' % e)
            if not data:
                raise Lost('the listener closed the connection')
            self.last_rx = time.monotonic()
            self.feed(data)

    def feed(self, data):
        try:
            for line in self.lines.push(data):
                self._on_frame(decode_line(line, WIRE))
        except BadFrame as e:
            self.send({'t': 'bye', 'code': 'shutdown', 'message': 'bad frame: %s' % e})
            raise Lost('the listener sent a bad frame: %s' % e)

    # ── frames from the broker ──

    def _on_frame(self, f):
        t = f['t']
        if t == 'ping':
            self.send({'t': 'pong'})
        elif t == 'pong':
            pass
        elif t == 'bye':
            raise Lost('the listener ended the session (%s: %s)' % (f['code'], f['message']))
        elif t == 'open':
            self._open(f)
        elif t in ('in', 'eof', 'ack', 'resize', 'close'):
            st = self.streams.get(f['s'])
            if st is None:
                return
            getattr(self, '_on_' + t)(st, f)
        else:
            raise Lost('the listener sent %r, which it never sends' % t)

    def _open(self, f):
        s = f['s']
        if s in self.streams:
            self.send({'t': 'failed', 's': s, 'errno': 'EEXIST', 'message': 'stream %d is already open' % s})
            return
        env = dict(os.environ)
        env.update(f['env'])
        try:
            self._spawn(s, f, env, f.get('pty'))
        except (Shutdown, Lost):
            raise
        except Exception as e:  # noqa: BLE001 — one stream's failure is never the agent's
            if isinstance(e, OSError) and e.errno:
                name = errno.errorcode.get(e.errno, 'EUNKNOWN')
            elif isinstance(e, OSError):
                name = 'EUNKNOWN'
            else:
                name = 'EINVAL'
            self.send({'t': 'failed', 's': s, 'errno': name, 'message': str(e) or type(e).__name__})

    def _spawn(self, s, f, env, pty):
        """Start one stream, or raise; nothing it opened outlives a raise."""
        master = slave = None
        proc = None
        try:
            if pty is not None:
                master, slave = os.openpty()
                _set_winsize(slave, max(1, pty['cols']), max(1, pty['rows']))
                proc = subprocess.Popen(
                    f['argv'], cwd=f['cwd'], env=env, stdin=slave, stdout=slave, stderr=slave,
                    start_new_session=True, preexec_fn=_make_controlling_tty)
            else:
                proc = subprocess.Popen(
                    f['argv'], cwd=f['cwd'], env=env,
                    stdin=subprocess.PIPE if f['stdin'] else subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            st = Stream(s, proc, master)
            if master is not None:
                os.close(slave)
                slave = None
                _set_nonblocking(master)
                st.outs[1] = master
                st.stdin_fd = master
            else:
                st.outs[1] = proc.stdout.fileno()
                st.outs[2] = proc.stderr.fileno()
                _set_nonblocking(st.outs[1])
                _set_nonblocking(st.outs[2])
                if proc.stdin is not None:
                    st.stdin_fd = proc.stdin.fileno()
                    _set_nonblocking(st.stdin_fd)
        except BaseException:
            for fd in (master, slave):
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            if proc is not None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
                try:
                    proc.wait(timeout=1)
                except Exception:  # noqa: BLE001
                    pass
            raise
        self.groups[proc.pid] = st.started
        self.streams[s] = st
        self.send({'t': 'started', 's': s, 'pid': proc.pid})
        self._interest(st)

    def _on_in(self, st, f):
        data = base64.b64decode(f['b64'])
        if st.stdin_fd is None or st.stdin_eof:
            # Nowhere to write it: acknowledged, so the sender is not stalled.
            if data and not st.orphaned:
                self.send({'t': 'ack', 's': st.s, 'fd': 0, 'n': len(data)})
            return
        st.stdin_queue.append(data)
        self._write_stdin(st)

    def _on_eof(self, st, f):
        st.stdin_eof = True
        if st.master is None and not st.stdin_queue:
            self._close_stdin(st)

    def _on_ack(self, st, f):
        if f['fd'] in (1, 2):
            st.credit = min(WINDOW, st.credit + f['n'])
            self._interest(st)

    def _on_resize(self, st, f):
        if st.master is not None:
            try:
                _set_winsize(st.master, max(1, f['cols']), max(1, f['rows']))
            except OSError:
                pass

    def _on_close(self, st, f):
        # The host side went away. KILL NOTHING: the command may have been
        # detached on purpose, and a kill is the reap's job. Stop sending its
        # frames, close its stdin, and keep draining its output so a survivor
        # still writing is neither blocked nor killed by SIGPIPE.
        st.orphaned = True
        st.stdin_queue = []
        if st.master is not None:
            # A terminal's host side is gone: hang the terminal up, which is what
            # closing a terminal means.
            self._drop_fd(st, 1)
            st.stdin_fd = None
        else:
            self._close_stdin(st)
        st.credit = WINDOW
        self._interest(st)

    # ── far-side fds ──

    def _close_stdin(self, st):
        fd = st.stdin_fd
        st.stdin_fd = None
        st.stdin_queue = []
        if fd is not None and st.master is None:
            self._unregister(fd)
            try:
                st.proc.stdin.close()
            except OSError:
                pass

    def _write_stdin(self, st):
        while st.stdin_queue and st.stdin_fd is not None:
            chunk = st.stdin_queue[0]
            try:
                n = os.write(st.stdin_fd, chunk)
            except (BlockingIOError, InterruptedError):
                break
            except OSError:
                # The far side closed its stdin: what remains is acknowledged
                # unwritten, so the sender is not stalled on credit.
                dropped = sum(len(c) for c in st.stdin_queue)
                if not st.orphaned:
                    self.send({'t': 'ack', 's': st.s, 'fd': 0, 'n': dropped})
                st.stdin_queue = []
                if st.master is None:
                    self._close_stdin(st)
                break
            if n < len(chunk):
                st.stdin_queue[0] = chunk[n:]
            else:
                st.stdin_queue.pop(0)
            if not st.orphaned:
                self.send({'t': 'ack', 's': st.s, 'fd': 0, 'n': n})
        if not st.stdin_queue and st.stdin_eof and st.master is None:
            self._close_stdin(st)
        self._interest(st)

    def _unregister(self, fd):
        try:
            self.sel.unregister(fd)
        except (KeyError, ValueError):
            pass

    def _interest(self, st):
        """Register exactly what this stream can act on now."""
        wants = {}
        if st.credit > 0:
            for fd in st.outs.values():
                wants[fd] = wants.get(fd, 0) | selectors.EVENT_READ
        if st.stdin_fd is not None and st.stdin_queue:
            wants[st.stdin_fd] = wants.get(st.stdin_fd, 0) | selectors.EVENT_WRITE
        mine = set(list(st.outs.values()) + ([st.stdin_fd] if st.stdin_fd is not None else []))
        for fd in mine:
            ev = wants.get(fd, 0)
            try:
                key = self.sel.get_key(fd)
            except (KeyError, ValueError):
                key = None
            if ev == 0:
                if key is not None:
                    self.sel.unregister(fd)
            elif key is None:
                self.sel.register(fd, ev, ('fd', st))
            elif key.events != ev:
                self.sel.modify(fd, ev, ('fd', st))

    def _drop_fd(self, st, num):
        fd = st.outs.pop(num, None)
        if fd is None:
            return
        self._unregister(fd)
        if st.master is not None and fd == st.master:
            try:
                os.close(fd)
            except OSError:
                pass
            st.master = None
            st.stdin_fd = None
        else:
            pipe = st.proc.stdout if num == 1 else st.proc.stderr
            try:
                pipe.close()
            except OSError:
                pass

    def _on_fd(self, st, fd, mask):
        if mask & selectors.EVENT_WRITE and fd == st.stdin_fd:
            self._write_stdin(st)
        if not mask & selectors.EVENT_READ:
            return
        num = None
        for k, v in st.outs.items():
            if v == fd:
                num = k
        if num is None:
            return
        want = CHUNK if st.orphaned else min(CHUNK, st.credit)
        if want <= 0:
            self._interest(st)
            return
        try:
            data = os.read(fd, want)
        except (BlockingIOError, InterruptedError):
            return
        except OSError as e:
            # EIO is how a pty master reports that every slave fd is closed.
            if e.errno != errno.EIO:
                log('reading stream %d failed: %s' % (st.s, e))
            data = b''
        if not data:
            self._drop_fd(st, num)
            self._settle(st)
            return
        if not st.orphaned:
            st.credit -= len(data)
            self.send({'t': 'out', 's': st.s, 'fd': num, 'b64': base64.b64encode(data).decode('ascii')})
        self._interest(st)

    def _reap(self, st):
        """Reap the direct child as soon as it exits: no zombie waits on EOF."""
        if st.reaped:
            return True
        rc = st.proc.poll()
        if rc is None:
            return False
        st.reaped = True
        if rc < 0:
            st.code, st.signal = None, _signal_name(-rc)
        else:
            st.code, st.signal = rc, None
        return True

    def _settle(self, st):
        """Send `exit` once the process is reaped AND its output is drained.

        A background job still holding the output keeps the stream open (and
        counting toward maxStreamsPerSession) after its parent is reaped, as a
        docker or ssh client would stay; `exit` waits for the output to close.
        """
        if st.done:
            return
        if not self._reap(st) or st.outs:
            return
        st.done = True
        self._close_stdin(st)
        if st.master is not None:
            try:
                os.close(st.master)
            except OSError:
                pass
            st.master = None
        del self.streams[st.s]
        if not st.orphaned:
            self.send({'t': 'exit', 's': st.s, 'code': st.code, 'signal': st.signal})

    # ── lifetime ──

    def kill_all(self):
        """Decision 9: a dropped session ends every command it started.

        A terminal is hung up first (SIGHUP, as closing a terminal does), then
        every process group this session started is SIGKILLed — background jobs
        a detached command left behind included. A job that called setsid has
        left its group and survives; nothing here can find it.
        """
        for st in list(self.streams.values()):
            if st.master is not None and group_is_ours(st.pgid, st.started):
                try:
                    os.killpg(st.pgid, signal.SIGHUP)
                except OSError:
                    pass
        for pgid, started in list(self.groups.items()):
            # Checked immediately before the signal: a group id whose group
            # emptied may have been reused by an unrelated process.
            if not group_is_ours(pgid, started):
                continue
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass
        for st in list(self.streams.values()):
            for num in list(st.outs.keys()):
                self._drop_fd(st, num)
            self._close_stdin(st)
            try:
                st.proc.wait(timeout=1)
            except Exception:
                pass
        self.streams = {}
        self.groups = {}

    def _prune_groups(self):
        for pgid, started in list(self.groups.items()):
            if any(st.pgid == pgid for st in self.streams.values()):
                continue
            if not group_is_ours(pgid, started):
                del self.groups[pgid]

    def run(self, stop_flag):
        last_prune = time.monotonic()
        keepalive = self.tim['keepaliveTimeoutMs'] / 1000.0
        interval = self.tim['pingIntervalMs'] / 1000.0
        while True:
            now = time.monotonic()
            # A process that exited with its output already drained is noticed
            # by polling; one still holding its output open is settled on EOF.
            waiting = [st for st in self.streams.values() if not st.outs and not st.done]
            unreaped = [st for st in self.streams.values() if not st.reaped]
            timeout = max(0.0, min(self.next_ping, self.last_rx + keepalive) - now)
            if waiting:
                timeout = min(timeout, 0.02)
            elif unreaped:
                timeout = min(timeout, 0.25)
            for key, mask in self.sel.select(timeout):
                kind, st = key.data
                if kind == 'sock':
                    self._on_sock(mask)
                elif self.streams.get(st.s) is st:
                    self._on_fd(st, key.fd, mask)
            for st in unreaped:
                if self.streams.get(st.s) is st:
                    self._reap(st)
            for st in waiting:
                if self.streams.get(st.s) is st:
                    self._settle(st)
            now = time.monotonic()
            if now - self.last_rx > keepalive:
                raise Lost('no frame from the listener for %.1f s' % keepalive)
            if now >= self.next_ping:
                self.send({'t': 'ping'})
                self.next_ping = now + interval
            if now - last_prune > 5:
                self._prune_groups()
                last_prune = now
            if stop_flag():
                raise Shutdown()


class HandshakeReader(object):
    """Reads whole lines off a blocking socket until a deadline."""

    def __init__(self, sock, cap, deadline):
        self.sock = sock
        self.buf = LineBuffer(cap)
        self.deadline = deadline
        self.pending = []

    def line(self):
        while not self.pending:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise Lost('the listener did not answer in time')
            self.sock.settimeout(remaining)
            try:
                data = self.sock.recv(4096)
            except socket.timeout:
                raise Lost('the listener did not answer in time')
            if not data:
                raise Lost('the listener closed the connection during the handshake')
            self.pending.extend(self.buf.push(data))
        return self.pending.pop(0)

    def leftover(self):
        """Bytes read past the last handshake line, for the session to parse."""
        return b''.join(line + b'\n' for line in self.pending) + bytes(self.buf.buf)


def handshake(sock, remote_id, secret, tim, nonce=None):
    """Steps 1–5 of the handshake. Returns (session id, unread bytes), or raises.

    The broker must PROVE it knows the secret (the welcome MAC) before this
    agent will run anything it sends.
    """
    reader = HandshakeReader(sock, PROTOCOL['maxPreauthLineBytes'],
                             time.monotonic() + tim['handshakeTimeoutMs'] / 1000.0)
    na = nonce or os.urandom(PROTOCOL['nonceBytes']).hex()
    sock.sendall(encode({'t': 'hello', 'v': PROTOCOL['version'], 'remoteId': remote_id, 'nonce': na}))
    f = decode_line(reader.line(), WIRE)
    if f['t'] == 'refused':
        raise Refused(f['code'], f['message'])
    if f['t'] != 'challenge':
        raise BadFrame('expected a challenge, got %r' % f['t'])
    nb = f['nonce']
    labels = PROTOCOL['labels']
    sock.sendall(encode({'t': 'auth', 'mac': mac(secret, [labels['agent'], remote_id, nb, na])}))
    f = decode_line(reader.line(), WIRE)
    if f['t'] == 'refused':
        raise Refused(f['code'], f['message'])
    if f['t'] != 'welcome':
        raise BadFrame('expected welcome, got %r' % f['t'])
    if not verify_mac(secret, [labels['broker'], remote_id, nb, na, f['session']], f['mac']):
        raise Refused('broker_unproven', 'the listener could not prove it knows this remote\'s secret'
                      ' - nothing will run; check --connect points at code-system')
    sock.sendall(encode({'t': 'info', 'host': socket.gethostname(), 'python': platform.python_version(),
                         'pid': os.getpid(), 'agentVersion': AGENT_VERSION}))
    return f['session'], reader.leftover()


def run_forever(address, remote_id, secret, tim, stop_flag, sleep=time.sleep):
    backoff = Backoff(tim['backoffBaseMs'] / 1000.0, tim['backoffCapMs'] / 1000.0,
                      tim['backoffStableMs'] / 1000.0)
    host, port = address
    while not stop_flag():
        sess = None
        try:
            sock = socket.create_connection((host, port), timeout=tim['handshakeTimeoutMs'] / 1000.0)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            # Frames are small and interactive (a keystroke, an ack): no Nagle delay.
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            try:
                session_id, leftover = handshake(sock, remote_id, secret, tim)
                log('connected to %s:%d as %r (session %s)' % (host, port, remote_id, session_id))
                backoff.session_started()
                sess = Session(sock, remote_id, session_id, tim)
                sess.feed(leftover)
                sess.run(stop_flag)
            finally:
                if sess is not None:
                    sess.kill_all()
                    if stop_flag():
                        try:
                            sock.setblocking(True)
                            sock.settimeout(0.5)
                            sock.sendall(encode({'t': 'bye', 'code': 'shutdown', 'message': 'the agent is stopping'}))
                        except OSError:
                            pass
                try:
                    sock.close()
                except OSError:
                    pass
        except Shutdown:
            break
        except Refused as e:
            log('refused: %s' % e)
            backoff.refusal()
        except (Lost, BadFrame) as e:
            log('disconnected: %s' % e)
        except OSError as e:
            log('cannot reach %s:%d: %s' % (host, port, e))
        backoff.session_ended()
        if stop_flag():
            break
        delay = backoff.next_delay()
        log('reconnecting in %.1f s' % delay)
        end = time.monotonic() + delay
        while not stop_flag() and time.monotonic() < end:
            sleep(min(0.1, max(0.0, end - time.monotonic())))


# The bootstrap the agent re-executes into. Python's -c argv is
# ['-c', <code fd>, <secret fd>, <the agent's own arguments>...].
#
# ITS FIRST STATEMENT READS AND CLOSES THE SECRET'S FD, before it imports
# anything but the two built-ins that needs: an inherited memfd is readable by
# any same-user process through /proc/<pid>/fd for as long as it is open, so it
# is open only for that one read. Then the process makes itself non-dumpable
# (best-effort), so the secret it now holds in memory is not readable through
# /proc/<pid>/mem by the commands it runs either.
BOOT = (
    'import os,sys\n'
    's=int(sys.argv[2]);secret=os.pread(s,1<<16,0).decode();os.close(s)\n'
    'try:\n'
    ' import ctypes;ctypes.CDLL(None,use_errno=True).prctl(4,0,0,0,0)\n'
    'except Exception:\n'
    ' pass\n'
    'import marshal\n'
    'c=int(sys.argv[1]);code=marshal.loads(os.pread(c,os.fstat(c).st_size,0));os.close(c)\n'
    "sys.argv=['agent.py']+sys.argv[3:]\n"
    "exec(code,{'__name__':'__main__','__builtins__':__builtins__,'%s':secret})\n" % INHERITED_SECRET
)

# prctl(2) option: PR_SET_DUMPABLE.
PR_SET_DUMPABLE = 4


def no_dump():
    """Make this process non-dumpable, best-effort: /proc/<pid>/environ, /mem
    and /fd then refuse other non-root processes, its own commands included.
    Needs ctypes, which a minimal Python may lack; failing changes nothing else."""
    try:
        import ctypes
        ctypes.CDLL(None, use_errno=True).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)
        return True
    except Exception:  # noqa: BLE001
        return False


def reexec_without_secret(argv, env, secret):
    """Replace this process with one whose environment never held the secret.

    Removing the variable from os.environ is not enough: /proc/<pid>/environ
    shows the environment block the process was EXECUTED with, and every
    command this agent runs, as the same user, can read its parent's. So the
    agent puts the secret (and its own code, which may have come from stdin)
    into two memfds — anonymous files, never on disk — and execve()s the same
    interpreter with a clean environment, the fds inherited and only their
    numbers on the command line. The new process reads the secret and closes
    the fd before it connects. Never returns.
    """
    if not hasattr(os, 'memfd_create'):
        raise UsageError('this Python has no os.memfd_create, which the agent needs to keep its secret'
                         ' out of its environment (Linux 3.17 or later)')
    code_fd = os.memfd_create('code-system-agent-code', 0)
    os.write(code_fd, marshal.dumps(_MODULE_CODE))
    secret_fd = os.memfd_create('code-system-agent-secret', 0)
    os.write(secret_fd, secret.encode('utf-8'))
    for fd in (code_fd, secret_fd):
        os.set_inheritable(fd, True)
    clean = {k: v for k, v in env.items() if k != SECRET_ENV}
    sys.stderr.flush()
    os.execve(sys.executable, [sys.executable, '-I', '-c', BOOT, str(code_fd), str(secret_fd)] + list(argv), clean)


def main(argv, env=None, reexec=None):
    """`reexec` is a seam for tests; it defaults to `reexec_without_secret`."""
    env = os.environ if env is None else env
    reexec = reexec_without_secret if reexec is None else reexec
    if env.get(SECRET_ENV):
        # FIRST: until the re-exec below, the secret IS in this process's
        # exec-time environment, which a non-dumpable process keeps from other
        # same-user processes. The window before this line is a documented limit.
        no_dump()
    refusal = platform_refusal()
    if refusal:
        log(refusal)
        return 2
    try:
        opts = parse_args(argv)
    except UsageError as e:
        log(str(e))
        sys.stderr.write(USAGE)
        return 2
    if opts['help']:
        sys.stdout.write(USAGE)
        return 0
    inherited = globals().pop(INHERITED_SECRET, None)
    if inherited is not None:
        secret = inherited
    else:
        secret = env.get(SECRET_ENV, '')
        if not secret:
            log('%s is not set - the remote\'s secret is read from it and never from the command line'
                % SECRET_ENV)
            return 2
        try:
            reexec(argv, env, secret)
        except (UsageError, OSError) as e:
            log('cannot start without the secret in the environment: %s' % e)
            return 2
    if not secret:
        log('the inherited secret is empty')
        return 2
    try:
        tim = timings(env)
    except ValueError as e:
        log('%s is not valid JSON: %s' % (TIMINGS_ENV, e))
        return 2
    stopping = []

    def on_signal(signum, _frame):
        stopping.append(signum)
        raise Shutdown()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        run_forever(parse_address(opts['connect']), opts['remote'], secret, tim, lambda: bool(stopping))
    except Shutdown:
        pass
    log('stopped')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
