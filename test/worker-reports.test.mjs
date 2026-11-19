// Worker report scanner (App's background-worker poller) and the sync-fs
// removal stand-ins. The scanner runs against real Node fs/promises and against
// the shim's createFsPromises fed by an in-process bridge stand-in.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanWorkerReports, formatWorkerReport } from "../src/platform/worker-reports.js";
import { createFsPromises, removedSyncFs, REMOVED_SYNC_FS } from "../src/platform/fs-async.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-workers-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BRIDGE = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  readdirSync: (p, o) => o?.withFileTypes
    ? fs.readdirSync(p, { withFileTypes: true }).map(d => ({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile() }))
    : fs.readdirSync(p),
  statSync: p => { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs, mtime: s.mtime.toISOString(), isDir: s.isDirectory(), isFile: s.isFile(), mode: s.mode }; },
};
const shim = createFsPromises(async (fn, args) => {
  if (!BRIDGE[fn]) return { ok: false, error: { message: `fs.${fn} not allowed`, code: "EPERM" } };
  try { return { ok: true, value: BRIDGE[fn](...args) }; }
  catch (e) { return { ok: false, error: { message: e.message, code: e.code } }; }
});
const backends = { node: fs.promises, shim };

const writeReport = (root, id, rep) => {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, "report.json"), typeof rep === "string" ? rep : JSON.stringify(rep));
};

for (const [name, fsp] of Object.entries(backends)) {
  test(`[${name}] scanWorkerReports: prime, detect new/changed, skip specs and invalid`, async () => {
    const root = path.join(tmp, name);
    const scan = (seen, readNew = true) => scanWorkerReports({ fsp, join: path.join, root, seen, readNew });

    const missing = await scan({});
    assert.deepEqual(missing, { seen: {}, changed: false, reports: [], listed: false });

    writeReport(root, "FIX-1", { fix_id: "FIX-1", ok: true });
    writeReport(root, "specs", { fix_id: "nope" });
    fs.mkdirSync(path.join(root, "FIX-2")); // running: no report yet

    // Priming records mtimes without reading/returning reports.
    const primed = await scan({}, false);
    assert.equal(primed.listed, true);
    assert.equal(primed.changed, true);
    assert.deepEqual(Object.keys(primed.seen), ["FIX-1"]);
    assert.deepEqual(primed.reports, []);

    const idle = await scan(primed.seen);
    assert.equal(idle.changed, false);
    assert.deepEqual(idle.reports, []);

    writeReport(root, "FIX-2", { fix_id: "FIX-2", ok: false });
    writeReport(root, "FIX-3", "{partial");
    const next = await scan(primed.seen);
    assert.equal(next.changed, true);
    assert.deepEqual(next.reports, [{ id: "FIX-2", report: { fix_id: "FIX-2", ok: false } }]);
    assert.deepEqual(Object.keys(next.seen).sort(), ["FIX-1", "FIX-2", "FIX-3"], "invalid report still marked seen");
    assert.equal(primed.seen["FIX-2"], undefined, "input seen map is not mutated");

    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, "FIX-1", "report.json"), t, t);
    const again = await scan(next.seen);
    assert.deepEqual(again.reports.map(r => r.id), ["FIX-1"], "a rewritten report surfaces again");
  });
}

test("formatWorkerReport renders status, summary and git state", () => {
  const text = formatWorkerReport({ fix_id: "FIX-9", ok: false, rc: 1, duration_s: 42, summary: "broke",
    git: [{ repo: "api", dirty: 2, head: "abc" }, { repo: "web", dirty: 0, head: "def" }] });
  assert.match(text, /^⚠️ \*\*FIX-9\*\* worker finished \(rc=1, 42s\)/);
  assert.match(text, /broke/);
  assert.match(text, /api: 2 uncommitted — abc\nweb: clean — def$/);
  assert.match(formatWorkerReport({ fix_id: "X", ok: true }), /^✅ \*\*X\*\*.*\n\n\n\n\*\*git state:\*\*\n$/);
});

test("removed sync fs methods throw ERR_SYNC_FS_REMOVED with the async alternative", () => {
  const sync = removedSyncFs();
  assert.deepEqual(Object.keys(sync).sort(), [...REMOVED_SYNC_FS].sort());
  assert.throws(() => sync.readFileSync("/x"), e => e.code === "ERR_SYNC_FS_REMOVED" && /fs\.promises\.readFile\(\)/.test(e.message));
  assert.throws(() => sync.existsSync("/x"), /fs\.promises\.exists\(\)/);
  assert.throws(() => sync.readTail("/x", 10), /fs\.promises\.readTail\(\)/);
  // Every suggested alternative actually exists on the shim's fs.promises.
  for (const n of REMOVED_SYNC_FS) {
    const alt = n === "existsSync" ? "exists" : n.replace(/Sync$/, "");
    assert.equal(typeof shim[alt], "function", `fs.promises.${alt}`);
  }
});

test("app sources no longer use synchronous XHR or sync fs", () => {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(js|jsx)$/.test(e.name)) files.push(p);
  } };
  walk(new URL("../src", import.meta.url).pathname);
  const offenders = files.flatMap(f => {
    const src = fs.readFileSync(f, "utf8");
    const hits = [];
    if (/XMLHttpRequest/.test(src)) hits.push(`${f}: XMLHttpRequest`);
    if (!f.endsWith("fs-async.js")) {
      for (const m of src.matchAll(/\.(readFileSync|writeFileSync|existsSync|mkdirSync|statSync|readdirSync|copyFileSync|chmodSync|accessSync|unlinkSync|renameSync|execFileSync|execSync|spawnSync)\(/g)) hits.push(`${f}: ${m[1]}`);
    }
    return hits;
  });
  assert.deepEqual(offenders, []);
});
