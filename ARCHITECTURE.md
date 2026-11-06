# Architecture

## Layers

| Layer | Path | Role |
|---|---|---|
| UI shell | `src/App.jsx` | rc-dock layout, toolbar, project picker, tab registry (`TABS`) |
| Panels | `src/panels/*.jsx` | Independent React components; talk to each other only through the event bus |
| Store / bus | `src/store.js` | `projectRoot`, `devtonic.config.json` IO + watcher, settings, tiny pub/sub `bus` |
| Model routing | `src/routing.js`, `src/llm.js` | `⚡ auto` router: picks model tier per prompt; reads `~/.hermes/config.yaml` |
| Platform shim | `src/platform/shim.js` | Browser stand-ins for `fs`, `os`, `path`, `child_process`, `electron` |
| Bridge server | `server/index.mjs` | Static host + `/api/env`, `/api/fs` (RPC), `/api/exec` (buffered), `/api/proc` (WS streaming spawn) |

## Project contract: `devtonic.config.json`

Lives at the project root. Holds `phases`, `features`, `architecture`, `todos`, and `notes`. The agent is told about it through `chatContext()` in `store.js` on every turn. Architecture, Features, Flow and Progress all re-render on the `mission` bus event.

## Agent integration

The Chat panel shells out per turn:
`hermes --cli -z <msg> --continue <session>` and tails `~/.hermes/logs/agent.log` for the live activity feed.
Planned: switch to a structured streaming API exposed by devtonic-agent (see ROADMAP).

## Bridge protocol

- `GET /api/env` returns `{homedir, hostname, platform, env, cwd}`
- `POST /api/fs {fn, args}` returns `{ok, value}` or `{ok:false, error}`. This is an allow-listed set of `fs` functions.
- `POST /api/exec {file, args, opts}` returns `{error, stdout, stderr}`
- `WS /api/proc`: client sends `spawn | stdin | end | kill`; server sends `pid | out | err | error | close`

All endpoints require the `x-devtonic-token` header or a `?token=` query param.

## Known v0 compromises

- Sync `fs` calls use synchronous XHR so that panels didn't need rewriting. Migrating to async is on the roadmap.
- The folder/file pickers are `prompt()` dialogs.
- The Browser panel is an `<iframe>`, so sites that send `X-Frame-Options` won't render.
