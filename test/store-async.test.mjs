// Async store helpers (loadMissionAsync / saveMissionAsync / scanTreeAsync /
// readFileSafeAsync). Each test runs twice: against real Node `fs.promises`,
// and against the browser shim's `createFsPromises` (fed by an in-process RPC
// that mirrors the bridge's sync allow-list), so panels using these helpers
// are proven to only need methods the bridge actually exposes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadStoreEnv } from "./helpers/store-env.mjs";
import { createFsPromises } from "../src/platform/fs-async.js";

const env = await loadStoreEnv();
const { store } = env;
after(env.cleanup);

// Minimal stand-in for server/index.mjs's /api/fs dispatcher.
const BRIDGE = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  copyFileSync: (a, b) => fs.copyFileSync(a, b),
  accessSync: (p, m) => fs.accessSync(p, m),
  existsSync: p => fs.existsSync(p),
  readdirSync: (p, o) => o?.withFileTypes
    ? fs.readdirSync(p, { withFileTypes: true }).map(d => ({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile() }))
    : fs.readdirSync(p),
  statSync: p => { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs, mtime: s.mtime.toISOString(), isDir: s.isDirectory(), isFile: s.isFile(), mode: s.mode }; },
};
const calls = [];
const shimPromises = createFsPromises(async (fn, args) => {
  calls.push(fn);
  if (!BRIDGE[fn]) return { ok: false, error: { message: `fs.${fn} not allowed`, code: "EPERM" } };
  try { return { ok: true, value: BRIDGE[fn](...args) }; }
  catch (e) { return { ok: false, error: { message: e.message, code: e.code } }; }
});

const fakeFs = globalThis.window.require("fs");
const nodePromises = fakeFs.promises;
const backends = { node: nodePromises, shim: shimPromises };

function withBackend(name, fn) {
  return async () => {
    fakeFs.promises = backends[name];
    try { await fn(); } finally { fakeFs.promises = nodePromises; }
  };
}

for (const name of Object.keys(backends)) {
  test(`[${name}] loadMissionAsync: defaults, overlay, invalid JSON`, withBackend(name, async () => {
    const root = env.project(`${name}-load`);
    const d = await store.loadMissionAsync(root);
    assert.deepEqual(d.todos, []);
    d.todos.push("mutated");
    assert.deepEqual((await store.loadMissionAsync(root)).todos, [], "defaults are not shared by reference");

    fs.writeFileSync(path.join(root, "devtonic.config.json"), JSON.stringify({ notes: "hi" }));
    const m = await store.loadMissionAsync(root);
    assert.equal(m.notes, "hi");
    assert.equal(m.phases.length, 4);

    fs.writeFileSync(path.join(root, "devtonic.config.json"), "{oops");
    assert.deepEqual((await store.loadMissionAsync(root)).todos, []);
  }));

  test(`[${name}] loadMissionAsync migrates legacy .hermes/mission.json once`, withBackend(name, async () => {
    const root = env.project(`${name}-legacy`);
    fs.mkdirSync(path.join(root, ".hermes"));
    const legacy = path.join(root, ".hermes", "mission.json");
    fs.writeFileSync(legacy, JSON.stringify({ notes: "old notes" }));
    assert.equal((await store.loadMissionAsync(root)).notes, "old notes");
    assert.match(JSON.parse(fs.readFileSync(legacy, "utf8"))._moved, /devtonic\.config\.json/);
    fs.writeFileSync(legacy, JSON.stringify({ notes: "stale" }));
    assert.equal((await store.loadMissionAsync(root)).notes, "old notes");
  }));

  test(`[${name}] saveMissionAsync writes pretty JSON, emits, and round-trips`, withBackend(name, async () => {
    const root = path.join(env.project(`${name}-save`), "nested", "dir");
    const got = [];
    const off = store.bus.on("mission", m => got.push(m));
    const mission = { notes: "n", todos: [{ id: "1", text: "a", done: true }] };
    await store.saveMissionAsync(mission, root);
    off();
    const raw = fs.readFileSync(path.join(root, "devtonic.config.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), mission);
    assert.match(raw, /\n {2}"notes"/);
    assert.deepEqual(got, [mission]);
    assert.deepEqual((await store.loadMissionAsync(root)).todos, mission.todos);
  }));

  test(`[${name}] scanTreeAsync matches scanTree exactly`, withBackend(name, async () => {
    const root = env.project(`${name}-tree`);
    for (const sub of ["a", "b", "node_modules", ".git", ".hermes"]) fs.mkdirSync(path.join(root, sub));
    fs.mkdirSync(path.join(root, "a", "deep"));
    fs.writeFileSync(path.join(root, "a", "deep", "x.js"), "x");
    fs.writeFileSync(path.join(root, "b", "y.PY"), "y".repeat(10_000));
    fs.writeFileSync(path.join(root, "node_modules", "z.js"), "z");
    for (const [depth, max] of [[6, 2000], [6, 3], [1, 2000], [6, 1]]) {
      assert.deepEqual(await store.scanTreeAsync(root, depth, max), store.scanTree(root, depth, max), `depth=${depth} max=${max}`);
    }
    assert.deepEqual(await store.scanTreeAsync(path.join(root, "missing")), store.scanTree(path.join(root, "missing")));
  }));

  test(`[${name}] readFileSafeAsync truncates and reports errors inline`, withBackend(name, async () => {
    const root = env.project(`${name}-read`);
    const f = path.join(root, "big.txt");
    fs.writeFileSync(f, "abcdef");
    assert.equal(await store.readFileSafeAsync(f), "abcdef");
    assert.match(await store.readFileSafeAsync(f, 3), /^abc\n\n… \(truncated\)$/);
    assert.match(await store.readFileSafeAsync(path.join(root, "missing")), /^⚠️ .*ENOENT/);
  }));
}

test("shim backend was exercised and never hit a non-allow-listed method", () => {
  assert.ok(calls.length > 10);
  assert.ok(calls.every(fn => fn in BRIDGE), [...new Set(calls)].join(","));
});
