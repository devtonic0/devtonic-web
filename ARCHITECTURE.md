# Architecture

## Layers

| Layer | Path | Role |
|---|---|---|
| UI shell | `src/App.jsx` | rc-dock layout, toolbar, project picker, tab registry (`TABS`) |
| Panels | `src/panels/*.jsx` | Independent React components; talk to each other only through the event bus |
| Store / bus | `src/store.js`, `src/routing.js` | `projectRoot`, `devtonic.config.json` IO + watcher, settings, tiny pub/sub `bus`. The mission watcher watches the config file itself (the shim's polling `fs.watch` tracks the watched path's mtime, so a directory watch never fired on edits). Config IO, project switching and `routing.js` tier selection are unit-tested under `node --test` via `test/helpers/store-env.mjs`, which installs a Node-backed `window.require` with a temp `HOME` |
| Model routing | `src/routing.js`, `src/llm.js` | `⚡ auto` router: picks model tier per prompt; reads `~/.hermes/config.yaml` |
| Platform shim | `src/platform/shim.js`, `modules.js` | Browser stand-ins for `fs`, `os`, `path`, `child_process`, installed as `window.require`. There is no `electron` module: requiring it (or anything else) throws `MODULE_NOT_FOUND` with a migration hint pointing at `web.js`. Resolution logic lives in `modules.js` and is unit-tested. `fs.promises` (`fs-async.js`) is a fetch-based Node `fs/promises` subset over the same `/api/fs` RPC that never blocks the main thread; polling panels (Tasks, Usage, Workers) and the Hermes chat, Notes, Config, Progress, Code, Architecture, Features, Flow, Map and Secrets panels use it. Mission-backed panels share the `useMission()` hook (`src/panels/use-mission.js`: async load, reload on project switch, drops stale out-of-order loads). Secrets' env-file discovery and edits live in the DOM-free `src/panels/secrets-model.js`, tested against Node and the shim. `store.js` exposes async twins (`loadMissionAsync`, `saveMissionAsync`, `scanTreeAsync`, `readFileSafeAsync`) that use only standard `fs/promises` methods, so they are tested against both real Node and the shim. `fs.watch` polls the path's mtime every 2 s asynchronously (`createAsyncMtimePoller` in `watch-model.js`, overlapping ticks skipped) and reports Node-style `("change"|"rename", basename)` events; watch files, not directories |
| Web platform | `src/platform/web.js`, `web-model.js` | Browser-native replacements for the old Electron APIs: `openExternal` (new tab, falling back to the OS opener via the bridge), `copyText`, `reloadApp`, `setUiScale`, `pickFolder`/`pickFile`, and Web Notifications (`notify`, `requestNotifications`). Built-in panels import these directly. Pure logic (URL scheme allow-list, notify gating, scale clamping) is unit-tested |
| File/folder picker | `src/platform/picker.js`, `picker-model.js` | In-app directory browser behind `pickFolder()` / `pickFile()` in `web.js`; lists via the bridge's `readdirSync`. Pure path/filter logic lives in `picker-model.js` and is unit-tested |
| Process listing | `src/platform/procs.js`, `procs-model.js` | Cross-platform `listProcesses`, `processStat` and `listeningPorts` used by Tasks, Processes and Servers. It sticks to POSIX `ps -A/-U -o col=` flags and sorts in JS, because procps' `--sort` and `--no-headers` don't exist on macOS. Ports come from `ss -ltnp` on Linux and from `lsof -iTCP -sTCP:LISTEN -Fpn` on macOS (also the Linux fallback when `ss` is missing). Parsers are unit-tested, and one test runs the real `ps` |
| Hermes binary | `server/hermes.mjs`, `src/platform/hermes.js` | The bridge resolves the agent CLI (`DEVTONIC_HERMES` → `PATH` like `which` → `~/.local/bin`, `~/.hermes/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) and returns it as `hermes: {path, source, found}` in `/api/env`. Panels call `hermesPath()` at spawn time; Setup calls `refreshHermes()` after installing so new spawns pick up the binary. The resolver is unit-tested |
| Code splitting | `src/panels/lazy.jsx`, `src/panels/code-langs.js` | Heavy panels load as separate chunks. `lazyPanel()` wraps `React.lazy` with a Suspense placeholder and an error boundary that offers a reload if a chunk fetch fails. Map (force-graph/d3) and Code (CodeMirror) are lazy in `TABS`. Inside the editor, each CodeMirror language pack (plus emmet for HTML/JSX/TSX) is a dynamic import, swapped in through a `Compartment` once it arrives. `langKeyFor()` is unit-tested, and `test/bundle-budget.test.mjs` fails if any built JS chunk is over 800 kB |
| Browser panel | `src/panels/Browser.jsx`, `src/platform/frame-model.js`, `server/frame-check.mjs` | `<iframe>` preview with its own back/forward stack. Before framing a URL it asks the bridge (`/api/frame-check`) whether the response's `Content-Security-Policy: frame-ancestors` / `X-Frame-Options` headers forbid embedding by the UI's origin; blocked sites show an "Open in new tab" card (with "Try anyway"). URL normalisation, the nav stack and the header verdict are pure and unit-tested |
| Bridge server | `server/index.mjs` | Static host + `/api/env`, `/api/fs` (RPC), `/api/exec` (buffered), `/api/proc` (WS streaming spawn), `/api/frame-check` |

## Project contract: `devtonic.config.json`

Lives at the project root. Holds `phases`, `features`, `architecture`, `todos`, and `notes`. The agent is told about it through `chatContext()` in `store.js` on every turn. Architecture, Features, Flow and Progress all re-render on the `mission` bus event.

## Agent integration

The Chat panel shells out per turn:
`<hermesPath()> --cli -z <msg> --continue <session>` and tails `~/.hermes/logs/agent.log` for the live activity feed.
Planned: switch to a structured streaming API exposed by devtonic-agent (see ROADMAP).

## Bridge protocol

- `GET /api/env` returns `{homedir, hostname, platform, env, cwd, hermes: {path, source, found}}`
- `POST /api/fs {fn, args}` returns `{ok, value}` or `{ok:false, error}`. This is an allow-listed set of `fs` functions.
- `POST /api/exec {file, args, opts}` returns `{error, stdout, stderr}`
- `WS /api/proc`: client sends `spawn | stdin | end | kill`; server sends `pid | out | err | error | close`
- `GET /api/frame-check?url=<http(s) url>` fetches the page (6 s timeout, redirects followed) and returns `{ok, status, finalUrl, blocked, reason}` or `{ok:false, error}`

All endpoints require the `x-devtonic-token` header or a `?token=` query param.

## Notifications

Background fix-worker completions (`~/.hermes/fix-workers/*/report.json`) always post into the chat stream. They also raise a Web Notification when the user has enabled notifications in **Settings → notifications** and the tab is hidden or unfocused. Browsers only allow the permission prompt from a click, so it is never requested at startup. Users can turn worker notifications off with the `workerNotifications` setting.

## Known v0 compromises

- Sync `fs` calls still use synchronous XHR so legacy panels work unchanged. New and polling code should use `fs.promises`. Still sync: settings IO (`loadSettings`/`saveSettings`, read at import time by several modules), `env-prompt.js` target detection, the Code panel's lint/fix helpers, and a few one-shot reads (Servers registry, Database, Autosetup, Workspace, App's worker-report scan). Converting them and then removing sync XHR is tracked in ROADMAP.md.
- The Browser panel is an `<iframe>`, so sites that forbid framing (`X-Frame-Options` / CSP `frame-ancestors`) can't render inline. The panel detects this via the bridge and offers "Open in new tab"; pages that block framing by other means (JS frame-busting, cookie rules) aren't detected.
