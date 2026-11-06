# Roadmap

Items are worked top-down by the autonomous improvement loop. When an item lands, its PR checks it off here and links to it.

## Phase 1: Solid browser port
- [ ] Replace `prompt()` folder picker with an in-app directory browser (via `/api/fs readdirSync`)
- [ ] Remove dead Electron-only code paths (desktop notifications for workers → Web Notifications API; `.desktop` launcher refs)
- [ ] Make process listing panels (Tasks, Processes, Servers) cross-platform: they currently assume Linux `ps --sort` / `ss`
- [ ] Remove hard-coded `~/.local/bin/hermes`; resolve via `which hermes` / `DEVTONIC_HERMES` env
- [ ] Code-split heavy panels (Map3D/three.js, CodeMirror) and drop the main chunk below 800 kB
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
