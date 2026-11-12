// Loads src/store.js (and modules that import it) under node --test.
// store.js reads window.require("fs"|"path"|"os") at import time, so we
// install a minimal window.require backed by real Node modules, point HOME at
// a temp dir (settings live in ~/.hermes-mission-control.json), and replace
// fs.watch with a recorder so no real watchers keep the test process alive.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export async function loadStoreEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-store-"));
  const watches = [];
  const fakeFs = {
    ...fs,
    watch(p, cb) {
      const w = { path: p, cb, closed: false, close() { w.closed = true; } };
      watches.push(w);
      return w;
    },
  };
  const fakeOs = { ...os, homedir: () => home };
  const mods = { fs: fakeFs, path, os: fakeOs };
  globalThis.window = { require: name => mods[name] };
  const store = await import("../../src/store.js");
  const routing = await import("../../src/routing.js");
  const settingsFile = path.join(home, ".hermes-mission-control.json");
  return {
    home,
    store,
    routing,
    watches,
    settingsFile,
    readSettings: () => JSON.parse(fs.readFileSync(settingsFile, "utf8")),
    writeSettings: obj => fs.writeFileSync(settingsFile, JSON.stringify(obj)),
    project(name = "proj") {
      const dir = fs.mkdtempSync(path.join(home, `${name}-`));
      return dir;
    },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}
