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
- [ ] ESLint + Prettier config and CI step (needs new devDependencies; the unattended loop's package-install guard blocks this, so it needs a maintainer-run `npm i -D`)
- [x] Unit tests for `store.js` config IO and `routing.js` tier selection (also fixes the config watcher, which never fired in the browser shim) ([#9](https://github.com/devtonic0/devtonic-web/pull/9))
- [x] UI smoke test: boot server, load UI, assert each default panel renders without console errors (headless Chrome over CDP instead of Playwright, no new dependency) ([#17](https://github.com/devtonic0/devtonic-web/pull/17))
- [x] Async fs migration (first slice): add `fs.promises` to shim; async `fs.watch`; convert polling panels Tasks, Usage, Workers off sync XHR ([#10](https://github.com/devtonic0/devtonic-web/pull/10))
  - [x] Convert remaining panels (Hermes chat model/env reads, Notes, Config, Progress, Code file tree/open/save/replace) to `fs.promises`; async store helpers ([#11](https://github.com/devtonic0/devtonic-web/pull/11))
  - [x] Convert the mission readers in Architecture, Features, Flow, Map (incl. import scan) and Secrets (env discovery/edit via `secrets-model.js`) to `fs.promises`; shared `useMission()` hook ([#12](https://github.com/devtonic0/devtonic-web/pull/12))
  - [x] Settings IO: in-memory cache primed at boot (`settings-model.js`), coalesced async writes via `fs.promises` ([#13](https://github.com/devtonic0/devtonic-web/pull/13))
  - [x] Convert `env-prompt.js` (async, injectable `fsp`/`home`, tested on node + shim), the Code lint/fix helpers, and the one-shot reads in Servers, Database, Autosetup and Workspace ([#14](https://github.com/devtonic0/devtonic-web/pull/14))
  - [x] Convert `llm.js` env/config reads (async `llmClient`), the Tasks output reader, and the picker's `platform/web.js` directory listing (stale-listing guard) to `fs.promises` ([#15](https://github.com/devtonic0/devtonic-web/pull/15))
  - [x] Convert the remaining sync callers (App worker reports + project open, `store.js` mission/legacy-migrate/scan helpers, Git's `gh` lookup); then remove sync XHR from the shim ([#16](https://github.com/devtonic0/devtonic-web/pull/16))

## Phase 3: Agent integration
- [x] Structured streaming chat via devtonic-agent's API (replace log tailing): bridge `/api/agent/*` proxy (key stays server-side), SSE turn reducer, streamed replies, tool steps, in-chat approvals, run stop; CLI + log tail kept as fallback ([#19](https://github.com/devtonic0/devtonic-web/pull/19))
  - [x] Show a one-click "enable the agent API" hint (generates `API_SERVER_KEY` into the agent's `.env`) when the badge says `cli` because the API is off; also explains restart / rejected-key states (PR_LINK)
    - [ ] Optionally restart the agent gateway from the hint (`hermes gateway restart` via the bridge) instead of copy-paste
  - [ ] Pin the session's model with `POST /api/sessions/{id}/model` when smart routing picks a different tier, instead of passing `model` per turn
- [ ] Session list and resume from agent API
- [x] First-run onboarding: detect missing agent and show install instructions (wizard with per-platform steps + broken `DEVTONIC_HERMES` detection, persistent banner after skip) ([#18](https://github.com/devtonic0/devtonic-web/pull/18))

## Phase 4: Distribution
- [ ] `npx devtonic-web` publish (npm), including build-on-install or prebuilt `dist/`
- [ ] Optional: bundle as the web frontend for the devtonic-agent standalone app
