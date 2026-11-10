# Roadmap

Items are worked top-down by the autonomous improvement loop. When an item lands, its PR checks it off here and links to it.

## Phase 1: Solid browser port
- [x] Replace `prompt()` folder picker with an in-app directory browser (via `/api/fs readdirSync`) ([#2](https://github.com/devtonic0/devtonic-web/pull/2))
- [x] Remove dead Electron-only code paths (desktop notifications for workers → Web Notifications API; `.desktop` launcher refs) ([#3](https://github.com/devtonic0/devtonic-web/pull/3))
- [x] Migrate the remaining compatibility-only `window.require("electron")` callers (third-party panels) and then drop the stand-in from the shim ([#4](https://github.com/devtonic0/devtonic-web/pull/4))
- [x] Make process listing panels (Tasks, Processes, Servers) cross-platform: they currently assume Linux `ps --sort` / `ss` ([#5](https://github.com/devtonic0/devtonic-web/pull/5))
- [x] Remove hard-coded `~/.local/bin/hermes`; resolve via `which hermes` / `DEVTONIC_HERMES` env ([#6](https://github.com/devtonic0/devtonic-web/pull/6))
- [x] Code-split heavy panels (Map3D/three.js, CodeMirror) and drop the main chunk below 800 kB ([#7](https://github.com/devtonic0/devtonic-web/pull/7))
- [ ] Browser panel: detect frame-blocked sites and offer "open in new tab"

## Phase 2: Quality
- [ ] ESLint + Prettier config and CI step
- [ ] Unit tests for `store.js` config IO and `routing.js` tier selection
- [ ] Playwright smoke test: boot server, load UI, assert each default panel renders without console errors
- [ ] Async fs migration: add `fs.promises` to shim and convert panels off sync XHR

## Phase 3: Agent integration
- [ ] Structured streaming chat via devtonic-agent's API (replace log tailing)
- [ ] Session list and resume from agent API
- [ ] First-run onboarding: detect missing agent and show install instructions

## Phase 4: Distribution
- [ ] `npx devtonic-web` publish (npm), including build-on-install or prebuilt `dist/`
- [ ] Optional: bundle as the web frontend for the devtonic-agent standalone app
