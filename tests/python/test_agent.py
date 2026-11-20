# Unit tests for agent/agent.py, standard library only:
#   python3 -m unittest discover -s tests/python -v
# Run by tests/agent-python.test.mjs as part of `npm test`.

import ast
import importlib.util
import io
import os
import sys
import unittest
from contextlib import redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_PY = os.path.join(HERE, '..', '..', 'agent', 'agent.py')

spec = importlib.util.spec_from_file_location('agent', AGENT_PY)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

with open(AGENT_PY, encoding='utf-8') as f:
    SOURCE = f.read()
TREE = ast.parse(SOURCE)


class StdlibOnly(unittest.TestCase):
    # PINS: the agent is fetched as ONE file onto a machine where nothing else
    # can be assumed, so every import must be in the standard library.
    @unittest.skipUnless(hasattr(sys, 'stdlib_module_names'), 'needs Python 3.10+ to list the stdlib')
    def test_every_import_is_stdlib(self):
        names = set()
        for node in ast.walk(TREE):
            if isinstance(node, ast.Import):
                names.update(a.name.split('.')[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, 'no relative import in a single-file agent')
                names.add(node.module.split('.')[0])
        self.assertTrue(names)
        self.assertEqual(sorted(n for n in names if n not in sys.stdlib_module_names), [])


# Every module the agent may import: the standard library, named. Static, so it
# runs on every interpreter (sys.stdlib_module_names exists only from 3.10).
ALLOWED_IMPORTS = {
    'base64', 'binascii', 'errno', 'fcntl', 'hashlib', 'hmac', 'json', 'marshal', 'os', 'platform',
    'random', 'selectors', 'signal', 'socket', 'struct', 'subprocess', 'sys', 'termios', 'time',
}


class StdlibAllowlist(unittest.TestCase):
    # PINS: every import is on a fixed standard-library allowlist, checked on
    # every Python (3.9 included).
    def test_imports_are_on_the_allowlist(self):
        names = set()
        for node in ast.walk(TREE):
            if isinstance(node, ast.Import):
                names.update(a.name.split('.')[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                names.add((node.module or '').split('.')[0])
        self.assertEqual(sorted(names - ALLOWED_IMPORTS), [])


class PythonFloor(unittest.TestCase):
    # PINS the 3.9 floor STATICALLY: the file parses under the 3.9 grammar and
    # uses none of the later features ast's feature_version does not catch.
    def test_parses_as_python_3_9(self):
        ast.parse(SOURCE, feature_version=(3, 9))

    def test_no_later_constructs(self):
        match_cls = getattr(ast, 'Match', None)
        for node in ast.walk(TREE):
            if match_cls is not None:
                self.assertNotIsInstance(node, match_cls, 'match is 3.10+')
            if isinstance(node, (ast.FunctionDef, ast.arg, ast.AnnAssign)):
                ann = getattr(node, 'annotation', None) or getattr(node, 'returns', None)
                self.assertIsNone(ann, 'no annotations: X|Y in one is 3.10+')
            if isinstance(node, ast.Attribute):
                self.assertNotIn(node.attr, ('TaskGroup', 'removeprefix_', 'timeout_at'))
            if isinstance(node, ast.Name):
                self.assertNotIn(node.id, ('ExceptionGroup', 'TaskGroup'))
        self.assertNotIn('except*', SOURCE)

    def test_no_bitor_on_type_names(self):
        # `int | str` is a 3.10 type union even OUTSIDE an annotation (an
        # isinstance argument, a module-level alias); int flags stay allowed.
        types = {'int', 'str', 'bytes', 'float', 'bool', 'list', 'dict', 'tuple', 'set', 'type', 'None'}

        def is_type(n):
            return (isinstance(n, ast.Name) and n.id in types) or (
                isinstance(n, ast.Constant) and n.value is None)
        for node in ast.walk(TREE):
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
                self.assertFalse(is_type(node.left) or is_type(node.right),
                                 'a type union at line %d is 3.10+' % node.lineno)


class ConstantTime(unittest.TestCase):
    # PINS: the MAC check never compares with == (which leaks how many leading
    # characters matched); it goes through hmac.compare_digest only.
    def test_verify_mac_uses_compare_digest_only(self):
        fn = next(n for n in ast.walk(TREE) if isinstance(n, ast.FunctionDef) and n.name == 'verify_mac')
        calls = [n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)]
        self.assertIn('compare_digest', [c.func.attr for c in calls])
        for n in ast.walk(fn):
            if isinstance(n, ast.Compare):
                self.assertFalse(any(isinstance(op, (ast.Eq, ast.NotEq)) for op in n.ops), 'no == on a MAC')

    def test_verify_mac_accepts_only_the_mac(self):
        m = agent.mac('s', ['a', 'b'])
        self.assertTrue(agent.verify_mac('s', ['a', 'b'], m))
        self.assertFalse(agent.verify_mac('s', ['a', 'b'], m[:-1]))
        self.assertFalse(agent.verify_mac('t', ['a', 'b'], m))
        self.assertFalse(agent.verify_mac('s', ['a', 'b'], None))
        self.assertFalse(agent.verify_mac('s', ['a', 'b'], 'é' * 64))


class Clock(object):
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class BackoffSchedule(unittest.TestCase):
    # PINS the reconnect schedule with an injected rng and clock: the ceiling
    # doubles from base to cap, a delay lies in [min(base, ceiling), ceiling],
    # it resets only after a session that lived `stable`, and a refusal jumps
    # to the cap.
    def make(self, rng):
        clock = Clock()
        return agent.Backoff(0.5, 30.0, 10.0, rng=rng, clock=clock), clock

    def test_growth_and_cap_at_the_top_of_the_jitter(self):
        b, _ = self.make(lambda: 1.0)
        self.assertEqual([b.next_delay() for _ in range(9)], [0.5, 1, 2, 4, 8, 16, 30, 30, 30])

    def test_jitter_bounds(self):
        b, _ = self.make(lambda: 0.0)
        self.assertEqual([b.next_delay() for _ in range(4)], [0.5, 0.5, 0.5, 0.5])
        b2, _ = self.make(lambda: 0.5)
        self.assertEqual([b2.next_delay() for _ in range(3)], [0.5, 0.75, 1.25])

    def test_reset_only_after_a_stable_session(self):
        b, clock = self.make(lambda: 1.0)
        for _ in range(4):
            b.next_delay()
        b.session_started()
        clock.t += 9.5
        b.session_ended()
        self.assertEqual(b.next_delay(), 8, 'a short session does not reset')
        b.session_started()
        clock.t += 10.0
        b.session_ended()
        self.assertEqual(b.next_delay(), 0.5, 'a stable one does')

    def test_a_refusal_waits_at_least_the_cap_whatever_the_jitter(self):
        # rng 0.0 is the case that matters: a draw from [base, cap] would retry
        # after base.
        for r, want in ((0.0, 30.0), (0.5, 33.75), (1.0, 37.5)):
            b, _ = self.make(lambda r=r: r)
            b.next_delay()
            b.refusal()
            self.assertEqual(b.next_delay(), want)
            self.assertEqual(b.next_delay(), 0.5 + 0.5 * r, 'and only once: the schedule resumes where it was')


class Startup(unittest.TestCase):
    # PINS the refusals at startup: not Linux, Python < 3.9, a secret in argv,
    # and a missing secret.
    def test_refuses_off_linux_and_below_3_9(self):
        self.assertIsNone(agent.platform_refusal('linux', (3, 9)))
        self.assertRegex(agent.platform_refusal('darwin', (3, 12)), 'Linux only')
        self.assertRegex(agent.platform_refusal('win32', (3, 12)), 'Linux only')
        self.assertRegex(agent.platform_refusal('linux', (3, 8)), '3.9')

    def test_secret_is_never_accepted_in_argv(self):
        for argv in (['--secret', 'hunter2'], ['--secret=hunter2'], ['--key', 'hunter2']):
            with self.assertRaises(agent.UsageError):
                agent.parse_args(['--connect', 'h:1', '--remote', 'r'] + argv)
        err = io.StringIO()
        with redirect_stderr(err):
            rc = agent.main(['--connect', 'h:1', '--remote', 'r', '--secret', 'hunter2'], env={})
        self.assertEqual(rc, 2)
        self.assertNotIn('hunter2', err.getvalue())
        self.assertIn(agent.SECRET_ENV, err.getvalue())

    def test_a_missing_secret_is_refused_by_name(self):
        err = io.StringIO()
        with redirect_stderr(err):
            rc = agent.main(['--connect', 'h:1', '--remote', 'r'], env={})
        self.assertEqual(rc, 2)
        self.assertIn(agent.SECRET_ENV, err.getvalue())

    def test_connect_must_be_host_port(self):
        for bad in ('h', 'h:', ':1', 'h:0', 'h:70000', 'h:x'):
            with self.assertRaises(agent.UsageError):
                agent.parse_address(bad)
        self.assertEqual(agent.parse_address('[::1]:7420'), ('::1', 7420))


class GroupReuse(unittest.TestCase):
    # PINS: a process group is signalled only while it is still the one the
    # agent started — never a reused id, never pid 0/1 or the agent's own group.
    def test_group_is_ours(self):
        alive_group = lambda pgid, sig: None  # noqa: E731

        def gone(pgid, sig):
            raise ProcessLookupError()
        self.assertTrue(agent.group_is_ours(4242, 100, starttime=lambda p: 100, killpg=gone))
        self.assertFalse(agent.group_is_ours(4242, 100, starttime=lambda p: 101, killpg=alive_group),
                         'a live process with the id but another start time: reused')
        self.assertTrue(agent.group_is_ours(4242, 100, starttime=lambda p: None, killpg=alive_group),
                        'leader gone, members left: still ours')
        self.assertFalse(agent.group_is_ours(4242, 100, starttime=lambda p: None, killpg=gone))
        for pgid in (0, 1, os.getpgrp()):
            self.assertFalse(agent.group_is_ours(pgid, 100, starttime=lambda p: 100, killpg=alive_group))


class Framing(unittest.TestCase):
    # PINS the line cap and the strict shape check on the agent side.
    def test_line_cap(self):
        b = agent.LineBuffer(8)
        self.assertEqual(b.push(b'12345678\nab'), [b'12345678'])
        self.assertEqual(b.push(b'c\n'), [b'abc'])
        with self.assertRaises(agent.BadFrame):
            agent.LineBuffer(8).push(b'123456789')

    def test_shape(self):
        agent.check_shape({'t': 'ping'}, agent.WIRE)
        for bad in ({'t': 'ping', 'x': 1}, {'t': 'nope'}, {'t': 'eof'}, {'t': 'eof', 's': -1}, {'t': 'eof', 's': True}):
            with self.assertRaises(agent.BadFrame):
                agent.check_shape(bad, agent.WIRE)


if __name__ == '__main__':
    unittest.main()
