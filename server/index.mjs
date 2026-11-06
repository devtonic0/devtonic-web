#!/usr/bin/env node
// devtonic-web bridge server.
// Serves the built UI and exposes a token-guarded local bridge so the browser
// UI can reach the filesystem and spawn processes (git, hermes, rg, ...).
// Binds to 127.0.0.1 only. Never expose this port to a network.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "..", "dist");
const PORT = Number(process.env.DEVTONIC_PORT || 4777);
const HOST = "127.0.0.1";
const TOKEN = process.env.DEVTONIC_TOKEN || crypto.randomBytes(24).toString("hex");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon" };

// ---- fs RPC ---------------------------------------------------------------
const statOut = s => ({ size: s.size, mtimeMs: s.mtimeMs, mtime: s.mtime.toISOString(),
  isDir: s.isDirectory(), isFile: s.isFile(), mode: s.mode });
const FS = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc || "utf8"),
  writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
  existsSync: p => fs.existsSync(p),
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  statSync: p => statOut(fs.statSync(p)),
  readdirSync: (p, o) => o?.withFileTypes
    ? fs.readdirSync(p, { withFileTypes: true }).map(d => ({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile() }))
    : fs.readdirSync(p),
  copyFileSync: (a, b) => fs.copyFileSync(a, b),
  chmodSync: (p, m) => fs.chmodSync(p, m),
  accessSync: (p, m) => fs.accessSync(p, m),
  unlinkSync: p => fs.unlinkSync(p),
  renameSync: (a, b) => fs.renameSync(a, b),
  readTail: (p, n) => { const s = fs.statSync(p); const start = Math.max(0, s.size - n);
    const fd = fs.openSync(p, "r"); const b = Buffer.alloc(s.size - start); fs.readSync(fd, b, 0, b.length, start); fs.closeSync(fd); return b.toString("utf8"); },
  kill: (pid, sig) => process.kill(pid, sig),
};

function envInfo() {
  return { homedir: os.homedir(), hostname: os.hostname(), platform: process.platform,
    tmpdir: os.tmpdir(), env: process.env, cwd: process.cwd(), sep: path.sep };
}

function readBody(req) {
  return new Promise((res, rej) => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => res(b)); req.on("error", rej); });
}

function authed(req) {
  const h = req.headers["x-devtonic-token"];
  const u = new URL(req.url, "http://x");
  return h === TOKEN || u.searchParams.get("token") === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    if (!authed(req)) { res.writeHead(401); return res.end("bad token"); }
    if (url.pathname === "/api/env") {
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(envInfo()));
    }
    if (url.pathname === "/api/fs" && req.method === "POST") {
      const { fn, args } = JSON.parse(await readBody(req));
      try {
        if (!FS[fn]) throw Object.assign(new Error(`unsupported fs.${fn}`), { code: "ENOSYS" });
        const value = FS[fn](...(args || []));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true, value: value === undefined ? null : value }));
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: { message: e.message, code: e.code } }));
      }
    }
    if (url.pathname === "/api/exec" && req.method === "POST") {
      const { file, args, opts } = JSON.parse(await readBody(req));
      execFile(file, args || [], { maxBuffer: 16e6, ...(opts || {}), env: { ...process.env, ...(opts?.env || {}) } },
        (err, stdout, stderr) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err ? { message: err.message, code: err.code } : null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        });
      return;
    }
    res.writeHead(404); return res.end();
  }
  // static
  let p = path.join(DIST, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, "index.html");
  if (!fs.existsSync(p)) { res.writeHead(500); return res.end("dist/ missing — run `npm run build` first"); }
  res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});

// ---- process streaming over WebSocket --------------------------------------
// Client -> {t:"spawn", id, file, args, opts} | {t:"stdin", id, data} | {t:"end", id} | {t:"kill", id, sig}
// Server -> {t:"out"|"err", id, data} | {t:"close", id, code} | {t:"error", id, message}
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, sock, head) => {
  if (!authed(req) || !req.url.startsWith("/api/proc")) return sock.destroy();
  wss.handleUpgrade(req, sock, head, ws => wss.emit("connection", ws));
});
wss.on("connection", ws => {
  const procs = new Map();
  const send = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
  ws.on("message", raw => {
    const m = JSON.parse(raw);
    if (m.t === "spawn") {
      let p;
      try {
        const o = m.opts || {};
        p = spawn(m.file, m.args || [], { cwd: o.cwd, shell: o.shell, detached: o.detached,
          env: { ...process.env, ...(o.env || {}) } });
      } catch (e) { return send({ t: "error", id: m.id, message: e.message }); }
      procs.set(m.id, p);
      p.stdout?.on("data", d => send({ t: "out", id: m.id, data: d.toString() }));
      p.stderr?.on("data", d => send({ t: "err", id: m.id, data: d.toString() }));
      p.on("error", e => send({ t: "error", id: m.id, message: e.message }));
      p.on("close", code => { procs.delete(m.id); send({ t: "close", id: m.id, code }); });
      send({ t: "pid", id: m.id, pid: p.pid });
    } else if (m.t === "stdin") procs.get(m.id)?.stdin.write(m.data);
    else if (m.t === "end") procs.get(m.id)?.stdin.end();
    else if (m.t === "kill") { try { procs.get(m.id)?.kill(m.sig || "SIGTERM"); } catch {} }
  });
  ws.on("close", () => { for (const p of procs.values()) { try { p.kill(); } catch {} } });
});

server.listen(PORT, HOST, () => {
  const u = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log(`devtonic-web running → ${u}`);
  if (process.argv.includes("--open")) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(cmd, [u], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
  }
});
