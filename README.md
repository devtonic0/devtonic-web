# devtonic-web

**Devtonic in your browser.** A dockable mission-control workspace for building software with AI coding agents.

Point it at a project folder and you get a living view of the codebase and of the agent working on it:

- **⚡ Hermes chat**: drives a real [Hermes](https://github.com/NousResearch/hermes-agent) agent (or [devtonic-agent](https://github.com/devtonic0/devtonic-agent)) against your project, with a live tool-call feed and git diffs per turn
- **🏛 Architecture / 🧩 Features / 🗺 Flow / ▣ Progress**: living diagrams driven by `devtonic.config.json` at the project root; the agent edits it, panels update in real time
- **🌐 Map**: 3D import graph of the codebase
- **⌥ Code**: CodeMirror 6 editor with lint/typecheck
- **❯ Terminal, ⎇ Git, 🚀 Servers, ⚙ Processes, 🗄 Database, 🔑 Secrets, ✎ Notes**

This is the open-source, browser-based, integration-free edition of the Devtonic desktop app. There's no Notion, Gmail, or Calendar: just the dev workspace.

## Quick start

```bash
git clone https://github.com/devtonic0/devtonic-web && cd devtonic-web
npm install
npm run build
npm start          # prints http://127.0.0.1:4777/?token=… and opens it
```

You need Node ≥ 20 on Linux or macOS. For the chat panel, install Hermes first: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` (or devtonic-agent).

The bridge looks for the agent CLI in this order: the `DEVTONIC_HERMES` env var (e.g. `DEVTONIC_HERMES=/path/to/devtonic-agent npm start`), then `hermes` on `PATH`, then common install directories (`~/.local/bin`, `~/.hermes/bin`, `/opt/homebrew/bin`, `/usr/local/bin`). On startup the server prints which binary it picked. If no agent is found, the UI opens a first-run setup screen with copyable install steps for your platform (and can run the official installer for you); if you skip it, a banner stays at the top with a re-check button until the agent is installed.

**Structured streaming chat (recommended):** when the agent's API server is running (set a strong `API_SERVER_KEY` in the agent's `.env`, which enables it, then start the gateway with `hermes gateway`), the chat panel streams each turn over the agent's HTTP API instead of spawning the CLI and tailing `agent.log`. You get the reply token by token, per-tool start/finish steps, reasoning, a stop button that cancels the run, and **approval prompts for dangerous commands right in the chat**. The bridge proxies `/api/agent/*` to `http://127.0.0.1:8642` (override with `DEVTONIC_AGENT_URL`, or the agent's `API_SERVER_PORT`) and adds the API key itself (`DEVTONIC_AGENT_KEY`, else `API_SERVER_KEY` from the environment or `$HERMES_HOME/.env`), so the key never reaches the browser. The badge next to the model name shows `api` or `cli`; hover it to see why. Set `DEVTONIC_AGENT_API=0` to always use the CLI. If the API can't start a turn, the panel falls back to the CLI for that turn.

### Development

```bash
npm run serve   # bridge server on :4777 (prints the token URL)
npm run dev     # vite on :5173 with /api proxied; open http://localhost:5173/?token=<token>
npm run build && npm test   # unit + bridge integration tests, plus a headless-Chrome UI smoke test
```

The UI smoke test (`test/ui-smoke.test.mjs`) boots the bridge against `dist/` with a throwaway `HOME`, opens every panel in headless Chrome and fails on any console error, uncaught exception or failed request. It auto-detects Chrome/Chromium (override with `DEVTONIC_CHROME=/path/to/chrome`). Locally it is skipped when no browser or `dist/` is found; in CI a missing browser is a failure.

## How it works

The panels were written for an Electron renderer with Node integration. devtonic-web keeps them unchanged by adding a **local bridge**:

```
browser tab ──HTTP /api/fs, /api/exec──▶ server/index.mjs (127.0.0.1 only, token-guarded)
            ──WebSocket /api/proc─────▶   spawns git / hermes / rg / bash with streamed stdio
```

`src/platform/shim.js` installs `window.require("fs" | "path" | "os" | "child_process")` backed by that bridge. Browser-only features (opening links, clipboard, notifications, zoom, file pickers) come from `src/platform/web.js`; there is no `window.require("electron")`, so custom panels should import `web.js` directly. File IO is async only: use `await fs.promises.readFile(...)` etc.; the old `fs.*Sync()` methods throw `ERR_SYNC_FS_REMOVED`. For details, see [ARCHITECTURE.md](./ARCHITECTURE.md).

**Notifications:** to get a desktop notification when a background agent worker finishes while you're in another tab, open **⚙ Settings → notifications** and click **enable**.

## Security

The bridge gives the page **full local shell and filesystem access as your user**. That's the whole point, and it's also why:

- it binds to `127.0.0.1` only
- every request needs a per-launch random token (or `DEVTONIC_TOKEN`)
- you should never put it behind a reverse proxy or expose the port

## Roadmap

See [ROADMAP.md](./ROADMAP.md). This repo is improved continuously by an autonomous agent loop: each change lands as a documented PR that must pass CI.

## License

MIT
