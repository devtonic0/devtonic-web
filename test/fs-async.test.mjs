import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFsPromises, fetchRpc, toError } from "../src/platform/fs-async.js";
import { createAsyncMtimePoller } from "../src/platform/watch-model.js";

test("rpc errors become Node-style errors with code", async () => {
  const fsp = createFsPromises(async () => ({ ok: false, error: { message: "ENOENT: nope", code: "ENOENT" } }));
  await assert.rejects(fsp.readFile("/x"), e => e.code === "ENOENT" && /nope/.test(e.message));
  assert.equal(toError(undefined).message, "fs bridge error");
});

test("maps promise methods onto the bridge's sync fn names", async () => {
  const calls = [];
  const fsp = createFsPromises(async (fn, args) => {
    calls.push([fn, args]);
    if (fn === "statSync") return { ok: true, value: { size: 3, mtimeMs: 5, mtime: "2026-01-01T00:00:00.000Z", isDir: false, isFile: true } };
    if (fn === "readdirSync") return { ok: true, value: args[1]?.withFileTypes ? [{ name: "a", isDir: true, isFile: false }] : ["a"] };
    return { ok: true, value: fn === "existsSync" ? true : null };
  });
  await fsp.readFile("/f", { encoding: "latin1" });
  assert.equal(await fsp.writeFile("/f", 42), undefined);
  const st = await fsp.stat("/f");
  assert.ok(st.isFile() && !st.isDirectory() && st.mtime instanceof Date);
  const [d] = await fsp.readdir("/d", { withFileTypes: true });
  assert.ok(d.isDirectory());
  assert.deepEqual(await fsp.readdir("/d"), ["a"]);
  assert.equal(await fsp.exists("/f"), true);
  assert.deepEqual(calls.slice(0, 2), [["readFileSync", ["/f", "latin1"]], ["writeFileSync", ["/f", "42", undefined]]]);
});

test("async poller skips overlapping ticks and reports change/rename", async () => {
  const events = [];
  let mtime = 1, release;
  const poller = createAsyncMtimePoller("/p/file.json", async () => {
    if (mtime === null) throw new Error("ENOENT");
    return mtime;
  }, (e, n) => events.push([e, n]));
  await poller.tick(); // baseline
  mtime = 2;
  await poller.tick();
  mtime = null;
  await poller.tick();
  assert.deepEqual(events, [["change", "file.json"], ["rename", "file.json"]]);

  let reads = 0;
  const slow = createAsyncMtimePoller("/p/x", () => { reads++; return new Promise(r => { release = r; }); }, () => {});
  const a = slow.tick();
  const b = slow.tick();
  assert.equal(a, b);
  while (!release) await new Promise(r => setImmediate(r));
  release(1);
  await a;
  assert.equal(reads, 1);
});

test("fs.promises against the real bridge", async () => {
  const PORT = 4797, TOKEN = "fsasync";
  const srv = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DEVTONIC_PORT: PORT, DEVTONIC_TOKEN: TOKEN } });
  await new Promise((res, rej) => { srv.stdout.on("data", d => String(d).includes("running") && res()); srv.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-fsasync-"));
  try {
    const fsp = createFsPromises(fetchRpc(TOKEN, `http://127.0.0.1:${PORT}`));
    const f = path.join(dir, "a.txt");
    await fsp.writeFile(f, "hello world");
    assert.equal(await fsp.readFile(f, "utf8"), "hello world");
    assert.equal(await fsp.readTail(f, 5), "world");
    assert.equal((await fsp.stat(f)).size, 11);
    assert.deepEqual(await fsp.readdir(dir), ["a.txt"]);
    await assert.rejects(fsp.readFile(path.join(dir, "missing")), e => e.code === "ENOENT");
    await assert.rejects(createFsPromises(fetchRpc("wrong", `http://127.0.0.1:${PORT}`)).exists(f), /bad or missing token/);
  } finally {
    srv.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
