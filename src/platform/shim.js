// Browser shim: provides window.require("fs"|"path"|"os"|"child_process")
// backed by the devtonic-web bridge server (server/index.mjs). Panels written
// for a Node-integrated renderer keep working unchanged. Browser-only APIs
// (links, clipboard, zoom, pickers, notifications) live in ./web.js; there is
// no window.require("electron").
//
// All fs IO is async: `fs.promises` (fetch-based, see ./fs-async.js) over the
// bridge's /api/fs RPC. The old sync methods (readFileSync, ...) used
// synchronous XHR and blocked the main thread; they now throw
// ERR_SYNC_FS_REMOVED with a pointer to the async equivalent. fs.watch polls
// async. The /api/env snapshot is fetched once at startup (top-level await).
import pathMod from "path-browserify";
import { resolveModule } from "./modules.js";
import { createAsyncMtimePoller } from "./watch-model.js";
import { createFsPromises, fetchRpc, removedSyncFs } from "./fs-async.js";

if (!window.require) {
  const qs = new URLSearchParams(location.search);
  if (qs.get("token")) {
    localStorage.setItem("devtonic-token", qs.get("token"));
    history.replaceState(null, "", location.pathname);
  }
  const TOKEN = localStorage.getItem("devtonic-token") || "";

  const envRes = await fetch("/api/env", { headers: { "x-devtonic-token": TOKEN } });
  if (envRes.status === 401) throw new Error("devtonic-web: bad or missing token — open the URL printed by the server");
  const ENV = await envRes.json();

  // ---- fs ----
  const rpc = fetchRpc(TOKEN);
  const call = async (fn, ...args) => {
    const r = await rpc(fn, args);
    if (!r.ok) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
    return r.value;
  };
  const fs = {
    ...removedSyncFs(),
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    // Polling watcher: fs.watch over the bridge polls the path's mtime (async,
    // via fs.promises) and reports (eventType, basename) like Node does for a
    // watched file. Watch files, not directories — a directory's mtime doesn't
    // change on edits.
    watch: (p, cb) => {
      const poller = createAsyncMtimePoller(p, async () => (await fs.promises.stat(p)).mtimeMs, cb);
      poller.tick();
      const t = setInterval(poller.tick, 2000);
      return { close: () => clearInterval(t) };
    },
    promises: createFsPromises(rpc),
  };

  // ---- os ----
  const os = { homedir: () => ENV.homedir, hostname: () => ENV.hostname, platform: () => ENV.platform, tmpdir: () => ENV.tmpdir, EOL: "\n" };

  // ---- child_process (WebSocket) ----
  let ws, wsReady, nextId = 1;
  const handlers = new Map();
  function socket() {
    if (wsReady) return wsReady;
    wsReady = new Promise((res, rej) => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/proc?token=${TOKEN}`);
      ws.onopen = () => res(ws);
      ws.onerror = rej;
      ws.onclose = () => { wsReady = null; };
      ws.onmessage = ev => { const m = JSON.parse(ev.data); handlers.get(m.id)?.(m); };
    });
    return wsReady;
  }
  function emitter() {
    const ls = {};
    return { on(e, f) { (ls[e] ||= []).push(f); return this; }, once(e, f) { return this.on(e, f); },
      emit(e, ...a) { (ls[e] || []).forEach(f => f(...a)); } };
  }
  function spawn(file, args = [], opts = {}) {
    const id = nextId++;
    const p = emitter();
    p.stdout = emitter(); p.stderr = emitter();
    const queue = [];
    const send = m => (ws?.readyState === 1 ? ws.send(JSON.stringify(m)) : queue.push(m));
    p.stdin = { write: d => send({ t: "stdin", id, data: String(d) }), end: () => send({ t: "end", id }) };
    p.kill = sig => send({ t: "kill", id, sig });
    p.unref = () => {};
    handlers.set(id, m => {
      if (m.t === "out") p.stdout.emit("data", m.data);
      else if (m.t === "err") p.stderr.emit("data", m.data);
      else if (m.t === "pid") p.pid = m.pid;
      else if (m.t === "error") p.emit("error", new Error(m.message));
      else if (m.t === "close") { handlers.delete(id); p.emit("close", m.code); p.emit("exit", m.code); }
    });
    const { stdio, ...rest } = opts;
    socket().then(s => { s.send(JSON.stringify({ t: "spawn", id, file, args, opts: rest })); queue.splice(0).forEach(m => s.send(JSON.stringify(m))); })
      .catch(e => p.emit("error", e));
    return p;
  }
  function execFile(file, args, opts, cb) {
    if (typeof args === "function") { cb = args; args = []; opts = {}; }
    if (typeof opts === "function") { cb = opts; opts = {}; }
    const { maxBuffer, ...rest } = opts || {};
    fetch("/api/exec", { method: "POST", headers: { "content-type": "application/json", "x-devtonic-token": TOKEN },
      body: JSON.stringify({ file, args, opts: rest }) })
      .then(r => r.json())
      .then(r => { const err = r.error ? Object.assign(new Error(r.error.message), { code: r.error.code }) : null; cb?.(err, r.stdout, r.stderr); })
      .catch(e => cb?.(e, "", ""));
    return { kill: () => {} };
  }
  const exec = (cmd, opts, cb) => execFile("bash", ["-lc", cmd], opts, cb);
  const child_process = { spawn, execFile, exec };

  const MODS = { fs, path: pathMod, os, child_process };
  window.require = name => resolveModule(MODS, name);

  window.process = {
    env: ENV.env, platform: ENV.platform, cwd: () => ENV.cwd,
    // Hermes CLI location resolved by the bridge (see server/hermes.mjs).
    devtonicHermes: ENV.hermes || null,
    // Async (Promise) in the browser: resolves when the signal was delivered,
    // rejects like Node's process.kill otherwise (e.g. ESRCH). Await it.
    kill: (pid, sig) => call("kill", pid, sig),
  };
  window.__DEVTONIC_WEB__ = true;
}
