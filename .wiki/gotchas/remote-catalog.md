# The plugin lists every record; cc's enumeration lists only the configured set

**What:** cc's protocol carries `listRemotes` → `remoteList` (`systems-protocol.md`
"Remote enumeration"), both shipped providers answer it, and cc sends it: its
`enumerate_remotes` MCP tool and the project dialogs' Remote dropdown read the
answer. That list is configured, not necessarily reachable, and omits records
that are broken or switched off. The card UI and the `list_remotes` MCP tool
remain the only places a user can read every record.

**Three read surfaces, different membership, one writer.** All three read the
same store (`src/store.mjs`), and the card UI is the only writer — a remote is
added, edited, connected and deleted there alone.

| Surface | Lists | Why |
|---|---|---|
| cards (`GET /api/remotes`) | **every** record file, broken and switched-off ones included | a user must see a record that will not read, rather than a shorter list than they configured |
| `list_remotes` MCP tool (`src/mcp.mjs`) | the same set as the cards | an agent cannot read the cards — see [plugin-mcp-surface.md](plugin-mcp-surface.md) |
| `listRemotes` frame (`src/launcher/session.mjs`) | only the **configured set**: readable, current schema, this launcher's kind, `enabled: true` | §2.2's configured membership; one launcher per kind answers it |

**The frame's membership is the configuration refusal, inverted.**
`StoreRemoteSource`'s private `#configured` (`src/launcher/remotes.mjs`) is both
what `lookup` refuses `ENOREMOTE` with and what `list` filters with — so the two
cannot drift. Two things that also refuse are deliberately **outside** it and do
not drop an id from the list:

- **the tooling baseline** — an `unsupported` remote is listed, and refused
  `EUNKNOWN` per operation;
- **reachability** — a stopped container or an ssh exit 255 is a refusal the
  transport learns by attempting the target. The listing never attempts one
  (no `docker`, no `ssh` runs), so an unreachable configured remote stays listed.

**Don't "fix" the listing by consulting the probe.** A list of what is reachable
now is a reachability snapshot, and §2.2 says a provider that can only offer that
must not advertise `remoteListing` at all. `tests/listing.test.mjs` pins it: the
docker stub answers "No such container", the exec is refused `ENOREMOTE`, and
the id stays listed.

**How to apply:** `remoteId` values must be stable (never silently
renamed/regenerated once a project references one) and human-typable (something
a user can read off the UI and paste into cc, not an opaque token). Any UI flow
that lets a user rename or delete a remote needs to account for projects that
still reference its `remoteId` — nothing in cc will tell the user which projects
a delete stranded. The store's charset (`REMOTE_ID_RE`) must stay inside cc's
`remoteIdDefect`, or one listed id makes cc refuse the whole `remoteList`
(`tests/store.test.mjs` → "every id the store accepts is one cc accepts as a
Remote").

Related: [[gate-versus-probe]] for the two states a remote carries.
