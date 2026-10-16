# A record field used as a table key must be an own-property lookup

**What:** a stored record is a JSON file anyone can hand-edit, and the store
reader accepts any string `kind` (or baseline `state`). A plain object literal
inherits `constructor`, `__proto__`, `hasOwnProperty`, `valueOf` and `toString`
from `Object.prototype`, so `TABLE[record.kind]` on such a name returns a
function or `Object.prototype` instead of `undefined`.

**What it broke:**

- `createTransport('constructor')` built a truthy non-transport; `cardFor`
  skipped its `unknown kind` path and the client read
  `transport.reachability is not a function`. `'__proto__'` threw out of
  `cardFor` and turned `GET /api/remotes` into a 500.
- In the UI, `KIND_ICON.constructor` is `Object`, which React rendered as a
  component and threw on; with no boundary the whole page went blank.

**The rule:** every lookup keyed by a record field goes through an own-property
helper — `own` in `src/launcher/kinds/index.mjs` (backend) and `own` in
`frontend/src/lib/cardState.mjs` (UI) — the same guard `src/mcp.mjs` uses for
tool names. As a second line, each card renders inside `CardBoundary`
(`frontend/src/components/CardBoundary.tsx`), so a record that still cannot be
drawn costs one card, never the page.

**Pinned by:** `tests/api.test.mjs` ("a stored prototype-named kind degrades to
its own card…"), `tests/cardstate.test.mjs` ("a prototype-named kind gets the
defaults…"), `frontend/src/App.test.tsx` ("a record the UI cannot draw").
