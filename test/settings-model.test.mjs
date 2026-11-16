import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSettingsStore } from "../src/platform/settings-model.js";

// In-memory fake file with controllable write latency and a write log.
function fakeIo(initial) {
  const io = {
    text: initial,
    writes: [],
    gate: null, // when set, writes wait for it
    async read() {
      if (io.text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return io.text;
    },
    async write(t) {
      if (io.gate) await io.gate;
      io.writes.push(t);
      io.text = t;
    },
  };
  return io;
}

test("prime reads the file; missing, corrupt and non-object files give {}", async () => {
  for (const [text, want] of [[undefined, {}], ["{bad", {}], ["[1,2]", {}], ["null", {}], ['{"a":1}', { a: 1 }]]) {
    const s = createSettingsStore(fakeIo(text));
    assert.equal(s.primed, false);
    assert.deepEqual(await s.prime(), want, String(text));
    assert.equal(s.primed, true);
  }
});

test("load returns a copy: mutating it does not change the cache", async () => {
  const s = createSettingsStore(fakeIo('{"list":[1]}'));
  await s.prime();
  s.load().list.push(2);
  assert.deepEqual(s.load(), { list: [1] });
});

test("save is visible synchronously, shallow-merges, and persists", async () => {
  const io = fakeIo('{"keep":true,"nested":{"x":1}}');
  const s = createSettingsStore(io);
  await s.prime();
  s.save({ nested: { y: 2 } });
  assert.deepEqual(s.load(), { keep: true, nested: { y: 2 } });
  await s.flush();
  assert.deepEqual(JSON.parse(io.text), { keep: true, nested: { y: 2 } });
});

test("saves during an in-flight write coalesce into one follow-up write of the latest state", async () => {
  const io = fakeIo("{}");
  const s = createSettingsStore(io);
  await s.prime();
  let open;
  io.gate = new Promise(r => { open = r; });
  s.save({ a: 1 });
  s.save({ b: 2 });
  s.save({ c: 3 });
  open();
  await s.flush();
  assert.equal(io.writes.length, 2, "first write + one coalesced follow-up");
  assert.deepEqual(JSON.parse(io.writes.at(-1)), { a: 1, b: 2, c: 3 });
});

test("patch objects are copied, so later caller mutation is not saved", async () => {
  const s = createSettingsStore(fakeIo("{}"));
  await s.prime();
  const patch = { list: [1] };
  s.save(patch);
  patch.list.push(2);
  assert.deepEqual(s.load().list, [1]);
});

test("write errors go to onError and later saves still persist", async () => {
  const errs = [];
  const io = fakeIo("{}");
  let fail = true;
  const realWrite = io.write;
  io.write = async t => { if (fail) { fail = false; throw new Error("EACCES"); } return realWrite(t); };
  const s = createSettingsStore(io, { onError: e => errs.push(e.message) });
  await s.prime();
  await s.save({ a: 1 });
  assert.deepEqual(errs, ["EACCES"]);
  await s.save({ b: 2 });
  assert.deepEqual(JSON.parse(io.text), { a: 1, b: 2 });
});

test("saves made before prime are kept, merged over disk, and written after priming", async () => {
  const io = fakeIo('{"fromDisk":1,"early":false}');
  const s = createSettingsStore(io);
  s.save({ early: true });
  await s.flush();
  assert.equal(io.writes.length, 0, "nothing written before the file was read");
  assert.deepEqual(await s.prime(), { fromDisk: 1, early: true });
  await s.flush();
  assert.deepEqual(JSON.parse(io.text), { fromDisk: 1, early: true });
});

test("reload waits for pending writes, then re-reads the file", async () => {
  const io = fakeIo("{}");
  const s = createSettingsStore(io);
  await s.prime();
  s.save({ a: 1 });
  assert.deepEqual(await s.reload(), { a: 1 });
  io.text = '{"external":true}';
  assert.deepEqual(await s.reload(), { external: true });
});

test("works against real Node fs/promises", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-settings-"));
  const file = path.join(dir, "s.json");
  try {
    const s = createSettingsStore({
      read: () => fs.promises.readFile(file, "utf8"),
      write: t => fs.promises.writeFile(file, t),
    });
    assert.deepEqual(await s.prime(), {});
    s.save({ theme: "light" });
    s.save({ uiScale: 110 });
    await s.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { theme: "light", uiScale: 110 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
