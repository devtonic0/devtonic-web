import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadStoreEnv } from "./helpers/store-env.mjs";

const env = await loadStoreEnv();
const { store } = env;
after(env.cleanup);

test("loadSettings returns {} when the settings file is missing or corrupt", async () => {
  assert.deepEqual(store.loadSettings(), {});
  fs.writeFileSync(env.settingsFile, "{not json");
  assert.deepEqual(await store.reloadSettings(), {});
  assert.deepEqual(store.loadSettings(), {});
  fs.rmSync(env.settingsFile);
});

test("saveSettings merges into memory now and the file in the background", async () => {
  store.saveSettings({ a: 1, nested: { x: 1 } });
  store.saveSettings({ b: 2, nested: { y: 2 } });
  assert.deepEqual(store.loadSettings(), { a: 1, b: 2, nested: { y: 2 } }, "visible synchronously");
  assert.deepEqual(await env.readSettings(), { a: 1, b: 2, nested: { y: 2 } });
  assert.deepEqual(store.loadSettings(), await env.readSettings());
});

test("reloadSettings picks up external edits to the file", async () => {
  fs.writeFileSync(env.settingsFile, JSON.stringify({ external: true }));
  assert.equal(store.loadSettings().external, undefined, "reads come from memory");
  assert.deepEqual(await store.reloadSettings(), { external: true });
  assert.equal(store.loadSettings().external, true);
  fs.rmSync(env.settingsFile);
  await store.reloadSettings();
});

test("projectRoot defaults to the home directory", () => {
  assert.equal(store.projectRoot, env.home);
});

test("setProject persists lastProject, dedupes recents (max 8), emits and watches the config file", async () => {
  const seen = [];
  const off = store.bus.on("project", r => seen.push(r));
  const roots = Array.from({ length: 10 }, (_, i) => env.project(`p${i}`));
  for (const r of roots) store.setProject(r);
  store.setProject(roots[3]); // revisit moves it to the front
  off();

  const s = await env.readSettings();
  assert.equal(s.lastProject, roots[3]);
  assert.equal(store.projectRoot, roots[3]);
  assert.equal(s.recentProjects.length, 8);
  assert.equal(s.recentProjects[0], roots[3]);
  assert.equal(new Set(s.recentProjects).size, 8);
  assert.deepEqual(store.recentProjects(), s.recentProjects);
  assert.equal(seen.length, 11);

  const last = env.watches.at(-1);
  assert.equal(last.path, path.join(roots[3], "devtonic.config.json"));
  assert.ok(env.watches.slice(0, -1).every(w => w.closed), "previous watchers are closed");
});

test("config watcher re-emits the mission (debounced) and ignores other files", async () => {
  const root = env.project("watch");
  store.setProject(root);
  fs.writeFileSync(path.join(root, "devtonic.config.json"), JSON.stringify({ todos: [{ id: "t", text: "x", done: false }] }));
  const got = [];
  const off = store.bus.on("mission", m => got.push(m));
  const w = env.watches.at(-1);
  w.cb("change", "other.json");
  w.cb("change", "devtonic.config.json");
  w.cb("change", "devtonic.config.json");
  await new Promise(r => setTimeout(r, 400));
  off();
  assert.equal(got.length, 1);
  assert.equal(got[0].todos[0].text, "x");
});

test("bus.on returns an unsubscribe function", () => {
  let n = 0;
  const off = store.bus.on("x", () => n++);
  store.bus.emit("x");
  off();
  store.bus.emit("x");
  store.bus.emit("never-registered");
  assert.equal(n, 1);
});

test("per-project chat sessions with legacy history fallback", () => {
  const root = "/work/my-app";
  assert.equal(store.defaultSessionName(root), "my-app-main");
  assert.equal(store.defaultSessionName(""), "project-main");
  assert.deepEqual(store.sessionsForProject(root), ["my-app-main"]);
  assert.equal(store.activeSessionForProject(root), "my-app-main");

  store.setProjectSessions(root, ["a", "b"], "b");
  assert.deepEqual(store.sessionsForProject(root), ["a", "b"]);
  assert.equal(store.activeSessionForProject(root), "b");
  store.setProjectSessions(root, ["a"], "gone");
  assert.equal(store.activeSessionForProject(root), "a", "unknown active session falls back to the first");

  assert.equal(store.historyForProject(root, "a"), null);
  store.saveSettings({ chatHistory: { a: [{ legacy: true }] } });
  assert.deepEqual(store.historyForProject(root, "a"), [{ legacy: true }]);
  store.saveSettings({ chatHistory: { a: [{ legacy: true }], [store.chatHistoryKey(root, "a")]: [{ scoped: true }] } });
  assert.deepEqual(store.historyForProject(root, "a"), [{ scoped: true }]);
});
