# Roadmap

Items are worked top-down by the autonomous improvement loop. When an item lands, its PR checks it off here and links to it.

## Phase 1: Solid browser port
- [x] Replace `prompt()` folder picker with an in-app directory browser (via `/api/fs readdirSync`) ([#2](https://github.com/devtonic0/devtonic-web/pull/2))
- [x] Remove dead Electron-only code paths (desktop notifications for workers → Web Notifications API; `.desktop` launcher refs) ([#3](https://github.com/devtonic0/devtonic-web/pull/3))
- [x] Migrate the remaining compatibility-only `window.require("electron")` callers (third-party panels) and then drop the stand-in from the shim ([#4](https://github.com/devtonic0/devtonic-web/pull/4))
- [x] Make process listing panels (Tasks, Processes, Servers) cross-platform: they currently assume Linux `ps --sort` / `ss` ([#5](https://github.com/devtonic0/devtonic-web/pull/5))
- [x] Remove hard-coded `~/.local/bin/hermes`; resolve via `which hermes` / `DEVTONIC_HERMES` env ([#6](https://github.com/devtonic0/devtonic-web/pull/6))
- [x] Code-split heavy panels (Map3D/three.js, CodeMirror) and drop the main chunk below 800 kB ([#7](https://github.com/devtonic0/devtonic-web/pull/7))
- [x] Browser panel: detect frame-blocked sites and offer "open in new tab" ([#8](https://github.com/devtonic0/devtonic-web/pull/8))

## Phase 2: Quality
- [ ] ESLint + Prettier config and CI step
- [x] Unit tests for `store.js` config IO and `routing.js` tier selection (also fixes the config watcher, which never fired in the browser shim) ([#9](https://github.com/devtonic0/devtonic-web/pull/9))
- [ ] Playwright smoke test: boot server, load UI, assert each default panel renders without console errors
- [x] Async fs migration (first slice): add `fs.promises` to shim; async `fs.watch`; convert polling panels Tasks, Usage, Workers off sync XHR ([#10](https://github.com/devtonic0/devtonic-web/pull/10))
  - [x] Convert remaining panels (Hermes chat model/env reads, Notes, Config, Progress, Code file tree/open/save/replace) to `fs.promises`; async store helpers ([#11](https://github.com/devtonic0/devtonic-web/pull/11))
  - [x] Convert the mission readers in Architecture, Features, Flow, Map (incl. import scan) and Secrets (env discovery/edit via `secrets-model.js`) to `fs.promises`; shared `useMission()` hook
  - [ ] Convert settings IO (`loadSettings`/`saveSettings` — needs an in-memory cache primed at boot), `env-prompt.js`, the Code lint/fix helpers, and the remaining one-shot reads (Servers, Database, Autosetup, Workspace, App worker reports); then remove sync XHR from the shim

## Phase 3: Agent integration
- [ ] Structured streaming chat via devtonic-agent's API (replace log tailing)
- [ ] Session list and resume from agent API
- [ ] First-run onboarding: detect missing agent and show install instructions

## Phase 4: Distribution
- [ ] `npx devtonic-web` publish (npm), including build-on-install or prebuilt `dist/`
- [ ] Optional: bundle as the web frontend for the devtonic-agent standalone app
