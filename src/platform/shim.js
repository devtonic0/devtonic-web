// Browser shim: provides window.require("fs"|"path"|"os"|"child_process"|"electron")
// backed by the devtonic-web bridge server (server/index.mjs). Panels written
// for Electron's nodeIntegration renderer keep working unchanged.
//
// Sync fs calls use synchronous XHR to 127.0.0.1. That is deliberate for v0
// (zero panel rewrites) — see ROADMAP.md "async fs migration".
import pathMod from "path-browserify";
import * as web from "./web.js";

if (!window.require) {
  const qs = new URLSearchParams(location.search);
  if (qs.get("token")) {
    localStorage.setItem("devtonic-token", qs.get("token"));
    history.replaceState(null, "", location.pathname);
  }
  const TOKEN = localStorage.getItem("devtonic-token") || "";

  function syncReq(method, url, body) {
    const x = new XMLHttpRequest();
    x.open(method, url, false);
    x.setRequestHeader("x-devtonic-token", TOKEN);
    if (body) x.setRequestHeader("content-type", "application/json");
    x.send(body ? JSON.stringify(body) : null);
    if (x.status === 401) throw new Error("devtonic-web: bad or missing token — open the URL printed by the server");
    return JSON.parse(x.responseText);
  }

  const ENV = syncReq("GET", "/api/env");

  // ---- fs ----
  const call = (fn, ...args) => {
    const r = syncReq("POST", "/api/fs", { fn, args });
    if (!r.ok) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
    return r.value;
  };
  const dirent = d => ({ name: d.name, isDirectory: () => d.isDir, isFile: () => d.isFile });
  const stat = s => ({ ...s, mtime: new Date(s.mtime), isDirectory: () => s.isDir, isFile: () => s.isFile });
  const fs = {
    readFileSync: (p, enc) => call("readFileSync", p, typeof enc === "string" ? enc : enc?.encoding || "utf8"),
    writeFileSync: (p, d, o) => call("writeFileSync", p, String(d), o),
    existsSync: p => call("existsSync", p),
    mkdirSync: (p, o) => call("mkdirSync", p, o),
    statSync: p => stat(call("statSync", p)),
    readdirSync: (p, o) => o?.withFileTypes ? call("readdirSync", p, o).map(dirent) : call("readdirSync", p),
    copyFileSync: (a, b) => call("copyFileSync", a, b),
    chmodSync: (p, m) => call("chmodSync", p, m),
    accessSync: (p, m) => call("accessSync", p, m),
    unlinkSync: p => call("unlinkSync", p),
    renameSync: (a, b) => call("renameSync", a, b),
    readTail: (p, n) => call("readTail", p, n),
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
    // Polling watcher (mtime of the watched path's files is not cheap remotely,
    // so we just tick; callers re-read what they need).
    watch: (p, cb) => {
      let last = null;
      const t = setInterval(() => {
        try { const s = call("statSync", p).mtimeMs; if (last !== null && s !== last) cb("change", null); last = s; } catch {}
      }, 2000);
      return { close: () => clearInterval(t) };
    },
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

  // ---- electron compatibility stand-ins ----
  // Built-in panels import src/platform/web.js directly. This object is kept
  // only so third-party or legacy panels that still call
  // window.require("electron") don't crash. Prefer web.js in new code.
  const electron = {
    ipcRenderer: {
      invoke: async (ch, ...a) => {
        if (ch === "pick-folder") return web.pickFolder();
        if (ch === "pick-file") return web.pickFile(a[0]);
        if (ch === "open-external") return web.openExternal(a[0]);
        if (ch === "app-restart") return web.reloadApp();
        return null;
      },
      on: () => {}, send: () => {},
    },
    clipboard: { writeText: t => { web.copyText(t); }, readText: () => "" },
    shell: { openExternal: u => web.openExternal(u) },
    webFrame: { setZoomFactor: f => { web.setUiScale(f * 100); } },
  };

  const MODS = { fs, path: pathMod, os, child_process, electron };
  window.require = name => {
    if (MODS[name]) return MODS[name];
    throw new Error(`devtonic-web: module "${name}" is not available in the browser build`);
  };

  window.process = {
    env: ENV.env, platform: ENV.platform, cwd: () => ENV.cwd,
    kill: (pid, sig) => call("kill", pid, sig),
  };
  window.__DEVTONIC_WEB__ = true;
}
