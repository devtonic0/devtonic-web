// Minimal headless-Chrome driver over the DevTools Protocol, used by the UI
// smoke test. Dependency-free apart from `ws` (already a runtime dependency):
// finds a local Chrome/Chromium, launches it headless with a throwaway
// profile, and exposes send()/on() over the page target's WebSocket.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import WebSocket from "ws";

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

export function findChrome() {
  const fromEnv = process.env.DEVTONIC_CHROME || process.env.CHROME_PATH;
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : null;
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const p = execFileSync("which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (p) return p;
    } catch { /* not on PATH */ }
  }
  return null;
}

async function waitForFile(file, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const txt = fs.readFileSync(file, "utf8");
      if (txt.includes("\n")) return txt;
    } catch { /* not written yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${file}`);
}

export async function launchChrome(bin, { width = 1600, height = 1000 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-chrome-"));
  const args = [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions",
    "--disable-background-networking", "--disable-dev-shm-usage", `--window-size=${width},${height}`,
    "about:blank",
  ];
  // GitHub's Ubuntu runners restrict unprivileged user namespaces.
  if (process.platform === "linux") args.unshift("--no-sandbox");
  const proc = spawn(bin, args, { stdio: "ignore" });
  const portFile = path.join(profile, "DevToolsActivePort");
  const [port] = (await waitForFile(portFile, 15000)).split("\n");

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  ws.on("message", raw => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message} (${msg.error.code})`)) : res(msg.result);
    } else if (msg.method) {
      (handlers.get(msg.method) ?? []).forEach(fn => fn(msg.params));
    }
  });

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const on = (method, fn) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(fn);
  };
  // Evaluate an expression in the page and return its (JSON-serialisable) value.
  const evaluate = async expression => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const close = async () => {
    try { ws.close(); } catch { /* already closed */ }
    proc.kill("SIGKILL");
    await new Promise(r => setTimeout(r, 200));
    fs.rmSync(profile, { recursive: true, force: true });
  };
  return { send, on, evaluate, close };
}

export async function waitFor(fn, { timeout = 15000, interval = 150, label = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${label}`);
}
