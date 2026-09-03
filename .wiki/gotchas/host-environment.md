# Two host-environment failure modes

**What:**

1. Any `Bash(...)` entry under `permissions.deny` or `permissions.ask` in the user's `~/.claude/settings.json` causes every remote spawn from this plugin to be refused with `BASH_RULES_NOT_ENFORCEABLE`.
2. A merged change to the plugin is not live in a running session until the orchestrator restarts — editing plugin code/config on disk has no effect on an in-flight orchestrator process.

**Why:** Both are easy to misdiagnose as provider bugs when they're actually host/orchestrator state. (1) is cc refusing to trust its own enforcement of Bash rules once any deny/ask rule exists, since it can't verify the provider's spawns went through the same rule surface. (2) is ordinary process-lifetime staleness, not a plugin defect.

**How to apply:** When debugging "provider won't spawn" reports, check the user's `~/.claude/settings.json` for `Bash` rules under `permissions.deny`/`permissions.ask` before assuming a provider bug. When a plugin change doesn't seem to take effect, check whether the orchestrator has been restarted since the change merged before debugging further.
