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

### Development

```bash
npm run serve   # bridge server on :4777 (prints the token URL)
npm run dev     # vite on :5173 with /api proxied; open http://localhost:5173/?token=<token>
npm test        # bridge integration tests
```

## How it works

The panels were written for an Electron renderer with Node integration. devtonic-web keeps them unchanged by adding a **local bridge**:

```
browser tab ──HTTP /api/fs, /api/exec──▶ server/index.mjs (127.0.0.1 only, token-guarded)
            ──WebSocket /api/proc─────▶   spawns git / hermes / rg / bash with streamed stdio
```

`src/platform/shim.js` installs `window.require("fs" | "path" | "os" | "child_process")` backed by that bridge. Browser-only features (opening links, clipboard, notifications, zoom, file pickers) come from `src/platform/web.js`; there is no `window.require("electron")`, so custom panels should import `web.js` directly. For details, see [ARCHITECTURE.md](./ARCHITECTURE.md).

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
