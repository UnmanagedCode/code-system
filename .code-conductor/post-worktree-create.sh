#!/usr/bin/env bash
# post-worktree-create hook for code-system — IN-TREE, tracked and committed,
# because this project is itself a cc plugin and ships its own hook.
#
# Why: node_modules/ is gitignored, so a fresh worktree has no express and
# npm test cannot boot. A worktree is short-lived and disposable; the parent
# checkout is not. So we pay the npm install once in the parent and symlink
# it into every worktree, instead of every worker paying its own install.
#
# CAUTION: the worktree's node_modules is a symlink to the PARENT's. Running
# npm install/ci from inside any worktree writes through the symlink into the
# parent's node_modules, which every other worktree also shares. Only this
# hook is expected to install; don't reinstall from within a worktree.
#
# Contract: cwd is the new worktree; CC_WORKTREE_PATH / CC_PROJECT_NAME /
# CC_BRANCH / CC_BASE_BRANCH / CC_PARENT_PATH are exported by the caller.
# Failure never aborts the worktree create -- it only shows up in the spawn
# result's postWorktreeCreate.output. Timeout: ORCH_POST_WORKTREE_TIMEOUT_MS
# (default 120s). Kill-switch: ORCH_DISABLE_POST_WORKTREE_HOOK=1.

set -uo pipefail

worktree="${CC_WORKTREE_PATH:-$PWD}"

if [ -e "$worktree/node_modules" ] || [ -L "$worktree/node_modules" ]; then
  echo "node_modules already present in worktree, skipping"
  exit 0
fi

if [ -z "${CC_PARENT_PATH:-}" ] || [ ! -d "$CC_PARENT_PATH" ]; then
  echo "CC_PARENT_PATH is empty or not a directory, skipping"
  exit 0
fi

parent="$CC_PARENT_PATH"

if [ ! -d "$parent/node_modules" ]; then
  (
    cd "$parent" || exit 1
    # package-lock.json is tracked, so prefer the deterministic install;
    # fall back if the lock ever drifts out of sync with package.json
    # (npm ci hard-fails there).
    if [ -f package-lock.json ]; then
      npm ci --no-audit --no-fund || npm install --no-audit --no-fund
    else
      npm install --no-audit --no-fund
    fi
  )
fi

# The install above can fail (registry unreachable, disk full, lock broken
# past both `ci` and `install`) without `set -e` stopping this script. Never
# link to a parent node_modules that doesn't exist: a dangling symlink would
# pass the -L check above on every future run, poisoning the worktree
# permanently. Leaving no symlink here means the next run retries the install
# instead of silently "succeeding" against a missing target.
if [ ! -d "$parent/node_modules" ]; then
  echo "install into $parent failed (no node_modules produced), not creating a symlink"
  exit 0
fi

parent_abs="$(cd "$parent" && pwd)"
ln -s "$parent_abs/node_modules" "$worktree/node_modules"
echo "symlinked $worktree/node_modules -> $parent_abs/node_modules"
