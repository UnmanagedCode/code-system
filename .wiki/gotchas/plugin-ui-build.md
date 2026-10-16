# The UI is built, and the build has sharp edges here

The card UI is React + Vite, built into `frontend/dist` by `npm install`'s
`prepare` script and never committed. What that means in this repo:

- **`.gitignore` says `node_modules`, not `node_modules/`.** A trailing slash
  matches a directory only, and git sees a symlink as a file. cc-created
  worktrees get `node_modules` as a symlink (below), so the slash form leaves it
  showing as untracked.
- **A worktree's `node_modules` is a symlink into the parent checkout**
  (`.code-conductor/post-worktree-create.sh`). `npm install` inside a worktree
  writes through it into the parent's tree, which every other worktree shares —
  including, for a Library-installed plugin, the live one. To install for real in
  a worktree, remove the link first (`rm node_modules`, never `rm -rf
  node_modules/`, which follows it).
- **The hook builds the worktree's UI** (`npm run prepare`) after linking. A
  parent `node_modules` from before the UI build has no `vite`; then the hook
  builds nothing and says to run `npm install` in the parent.
- **The build needs devDependencies.** A cc started with `NODE_ENV=production`
  or `npm_config_omit=dev` skips them; `prepare` fails and the backend answers
  503 `UI not built — run npm install`. The built check runs once, at backend
  start: restart after a hand build.
- **The CSP carries `style-src 'unsafe-inline'`** because Radix Dialog's scroll
  lock injects a `<style>` element. That makes "never a `style` from content" a
  hard rule: `tests/frontend.test.mjs` bans `style=`, `style={` and
  `.setProperty(` in every UI source.
- **Manual runs touch real state by default.** The store defaults to
  `~/.code-system` (the user's live remotes), and a shell's `CONDUCTOR_URL` may
  name the live orchestrator, where a standalone backend would register System
  rows. Run with `CODE_SYSTEM_STORE=<scratch dir>` under
  `env -u CONDUCTOR_URL -u PROJECTS_ROOT`.
- **The UI tests cannot import the backend.** Under vitest's happy-dom (web)
  transform, Vite rewrites `new URL('./askpass.sh', import.meta.url)` in
  `src/launcher/kinds/ssh.mjs` into an asset URL and the module throws. The real
  kind descriptors reach the tests through `vitest.config.ts`'s `provide`
  (`frontend/src/test/backend.ts`).
- **`allowJs` resolves a real `.js` over an ambient `declare module`.** That is
  why `frontend/src/lib/themeInit.test.ts` imports the classic script
  `public/theme-init.js` through a variable rather than a literal.
- **`userEvent.setup()` installs its own `navigator.clipboard`.** A Copy test
  defines its stub after `setup()`, or drives the click with `fireEvent`.
