import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadStoreEnv } from "./helpers/store-env.mjs";

const env = await loadStoreEnv();
const { store } = env;
after(env.cleanup);

test("loadSettings returns {} when the settings file is missing or corrupt", () => {
  assert.deepEqual(store.loadSettings(), {});
  fs.writeFileSync(env.settingsFile, "{not json");
  assert.deepEqual(store.loadSettings(), {});
  fs.rmSync(env.settingsFile);
});

test("saveSettings shallow-merges patches into the file", () => {
  store.saveSettings({ a: 1, nested: { x: 1 } });
  store.saveSettings({ b: 2, nested: { y: 2 } });
  assert.deepEqual(env.readSettings(), { a: 1, b: 2, nested: { y: 2 } });
  assert.deepEqual(store.loadSettings(), env.readSettings());
  fs.rmSync(env.settingsFile);
});

test("projectRoot defaults to the home directory", () => {
  assert.equal(store.projectRoot, env.home);
});

test("setProject persists lastProject, dedupes recents (max 8), emits and watches the config file", () => {
  const seen = [];
  const off = store.bus.on("project", r => seen.push(r));
  const roots = Array.from({ length: 10 }, (_, i) => env.project(`p${i}`));
  for (const r of roots) store.setProject(r);
  store.setProject(roots[3]); // revisit moves it to the front
  off();

  const s = env.readSettings();
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

test("loadMission returns defaults when the config is missing or invalid", () => {
  const root = env.project("empty");
  const m = store.loadMission(root);
  assert.deepEqual(m.todos, []);
  assert.equal(m.phases.find(p => p.status === "active").name, "Build");
  m.todos.push("mutated");
  assert.deepEqual(store.loadMission(root).todos, [], "defaults are not shared by reference");

  fs.writeFileSync(path.join(root, "devtonic.config.json"), "{oops");
  assert.deepEqual(store.loadMission(root).todos, []);
});

test("loadMission overlays the project file on the defaults", () => {
  const root = env.project("full");
  fs.writeFileSync(path.join(root, "devtonic.config.json"), JSON.stringify({ notes: "hi", features: [{ name: "f" }] }));
  const m = store.loadMission(root);
  assert.equal(m.notes, "hi");
  assert.deepEqual(m.features, [{ name: "f" }]);
  assert.equal(m.phases.length, 4);
});

test("loadMission migrates legacy .hermes/mission.json and leaves a pointer stub", () => {
  const root = env.project("legacy");
  fs.mkdirSync(path.join(root, ".hermes"));
  const legacy = path.join(root, ".hermes", "mission.json");
  fs.writeFileSync(legacy, JSON.stringify({ notes: "old notes" }));
  assert.equal(store.loadMission(root).notes, "old notes");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "devtonic.config.json"), "utf8")).notes, "old notes");
  assert.match(JSON.parse(fs.readFileSync(legacy, "utf8"))._moved, /devtonic\.config\.json/);

  // An existing new-style file is never overwritten by a legacy one.
  fs.writeFileSync(legacy, JSON.stringify({ notes: "stale" }));
  assert.equal(store.loadMission(root).notes, "old notes");
});

test("saveMission writes pretty JSON and emits the mission event", () => {
  const root = env.project("save");
  const got = [];
  const off = store.bus.on("mission", m => got.push(m));
  const mission = { notes: "n", todos: [{ id: "1", text: "a", done: true }] };
  store.saveMission(mission, root);
  off();
  const raw = fs.readFileSync(path.join(root, "devtonic.config.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), mission);
  assert.match(raw, /\n {2}"notes"/);
  assert.deepEqual(got, [mission]);
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

test("scanTree walks breadth-first, skips ignored dirs and respects maxNodes", () => {
  const root = env.project("tree");
  for (const sub of ["a", "b", "node_modules", ".git", ".hermes"]) fs.mkdirSync(path.join(root, sub));
  fs.mkdirSync(path.join(root, "a", "deep"));
  fs.writeFileSync(path.join(root, "a", "deep", "x.js"), "x");
  fs.writeFileSync(path.join(root, "b", "y.PY"), "y".repeat(10_000));
  fs.writeFileSync(path.join(root, "node_modules", "z.js"), "z");

  const { nodes, links } = store.scanTree(root);
  const names = nodes.map(n => n.name);
  assert.ok(names.includes(".hermes"));
  assert.ok(!names.includes("node_modules") && !names.includes(".git") && !names.includes("z.js"));
  assert.equal(nodes.find(n => n.name === "y.PY").ext, "py");
  assert.equal(nodes.find(n => n.name === "y.PY").size, 5);
  assert.equal(links.length, nodes.length - 1);

  const capped = store.scanTree(root, 6, 3);
  assert.deepEqual(capped.nodes.slice(1).map(n => n.name), [".hermes", "a", "b"], "siblings before children");
  assert.equal(store.scanTree(root, 1).nodes.some(n => n.name === "deep"), false);
});

test("readFileSafe truncates large files and reports errors inline", () => {
  const root = env.project("read");
  const f = path.join(root, "big.txt");
  fs.writeFileSync(f, "abcdef");
  assert.equal(store.readFileSafe(f), "abcdef");
  assert.match(store.readFileSafe(f, 3), /^abc\n\n… \(truncated\)$/);
  assert.match(store.readFileSafe(path.join(root, "missing")), /^⚠️ .*ENOENT/);
});

test("chatContext lists open todos and the active phase", () => {
  const root = env.project("ctx");
  store.setProject(root);
  store.saveMission({ todos: [{ text: "ship it", done: false }, { text: "old", done: true }] }, root);
  const ctx = store.chatContext();
  assert.match(ctx, /Target project: .*ctx-/);
  assert.match(ctx, /Active phase: Build/);
  assert.match(ctx, /- ship it/);
  assert.doesNotMatch(ctx, /- old/);
});
