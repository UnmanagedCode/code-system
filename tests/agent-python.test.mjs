// Runs the agent's own Python unit tests (tests/python/test_agent.py) as part
// of `npm test`, and PROVES BY COUNT that they ran: a discover that found
// nothing, or a runner that skipped a class, would otherwise pass as green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO } from './helpers.mjs';
import { NEEDS_PYTHON, PY } from './agentFixture.mjs';

test('the agent\'s Python unit tests pass, and all of them ran', { skip: NEEDS_PYTHON }, () => {
  const r = spawnSync(PY.python, ['-I', '-m', 'unittest', 'discover', '-s', path.join(REPO, 'tests', 'python'), '-v'],
    { encoding: 'utf8', cwd: REPO });
  assert.equal(r.status, 0, r.stderr);
  const ran = Number(/Ran (\d+) tests?/.exec(r.stderr)?.[1]);
  const skipped = (r.stderr.match(/ \.\.\. skipped/g) ?? []).length;
  // The roster: every test method in the file. Only the stdlib listing may
  // skip, and only on a Python without sys.stdlib_module_names (3.9).
  assert.equal(ran, 18, r.stderr);
  assert.ok(skipped <= (PY.version === '3.9' ? 1 : 0), r.stderr);
});
