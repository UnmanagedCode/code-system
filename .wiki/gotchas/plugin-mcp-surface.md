# What the conductor's MCP bridge does with a plugin's tools

Everything here is a property of **code-conductor's** bridge
(`src/plugins/mcpBridge.ts`, `src/plugins/manifest.ts`, `src/mcp/content.ts`),
not of this repo — so nothing in this repo demonstrates it, and no test here
runs under a conductor. Written down because each item below is either invisible
until the plugin is mounted, or silently accepted and then ignored.

## 1. `mcp.scope` is accepted and dropped — so do not declare one

`validateMcp` lists `scope` among the keys it will not complain about, does
**not** normalise it onto the `PluginMcp` record, and does not enum-check its
value: a typo validates clean. `toolsFor()` takes **no caller argument** — every
enabled plugin's tools are visible to every caller — so there is no value that
could mean anything. A `scope` in a manifest is a claim about routing that
nothing implements. (The real, enforced scope enum is on manifest
`conventions`, not on `mcp`.)

## 2. `{text}` is the only raw-text channel, and it always arrives behind a `null` block

A success body may be `{result}` or `{text, meta?}`:

- `{result}` is **JSON-stringified into one block**. A multi-line rendering
  comes out with every newline escaped.
- `{text}` is unwrapped into raw, unescaped text blocks. `text` wins if both are
  sent.

`{text}` goes through `textPayload(meta ?? null, text)`, so **omitting `meta`
does not omit the block** — the caller sees the literal `null` as `content[0]`
and the rendering as `content[1]`. A single bare text block is **unreachable
from a plugin**: the one API that produces it (`textResult`) brands its return
with a `Symbol`, which cannot survive the JSON hop from a child process.

## 3. A schema outside the flat subset makes the plugin *invalid at load*

`checkSchemaSubset` runs at manifest load, and a failure marks the whole plugin
`invalid` — not the one tool. It is never startable, and the backend never runs,
so the failure looks nothing like a tool bug. The subset:

- `type` must be `'object'`;
- `$ref`, `oneOf`, `anyOf`, `allOf`, `not` are rejected outright;
- top-level keys may only be `type`, `properties`, `required`, `description`,
  `additionalProperties` (a boolean, accepted and ignored);
- property types are scalars — nested object validation would silently not
  happen, so it is refused rather than tolerated.

`tests/pluginManifest.test.mjs` pins that **this** manifest's schema is inside
that subset. It deliberately does not reimplement the checker: a local copy of
somebody else's validator drifts silently and then lies in both directions.

## 4. A tool-level failure is a 200; only a malformed envelope is not

The pinned child contract is HTTP 200 for **every well-formed tool invocation** —
unknown tool name, bad arguments and the tool's own failure alike, each as
`{error}`. A non-200 means a transport-level failure and maps to an HTTP-coded
error the caller reads very differently. A plugin that answered 500 for "that
remote does not exist" would be reporting itself broken.

## 5. The name a caller actually types is three names deep

The bridge namespaces a tool as `<plugin-id>__<tool>`, and Claude Code prefixes
the conductor's server, so `list_remotes` reaches a session as
`mcp__code-conductor__code-system__list_remotes`.

## 6. A manifest change is not live until the conductor restarts

The conductor reads `conductor.plugin.json` during plugin **discovery**, so a
newly declared or edited `mcp` block does not reach a running process: the tool
stays absent (or stale) and a call refuses as an unknown tool. Same mechanism as
item 2 of [host-environment.md](host-environment.md).

## 7. A tool `description` is system-prompt text

It loads into the system prompt of **every session** while the plugin is
enabled, so it is a recurring per-session cost, not documentation. The test the
workspace conventions apply to a system-prompt doc applies to it: would a reader
act differently — or read the output differently — knowing this clause? If not,
cut it.
