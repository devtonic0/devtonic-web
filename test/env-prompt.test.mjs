// env-prompt.js: env target discovery, unset filtering and upserts. Runs
// against real Node fs.promises and the browser shim's createFsPromises (fed
// by the same allow-list as server/index.mjs) so the Chat env prompt only
// needs methods the bridge exposes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFsPromises } from "../src/platform/fs-async.js";
import * as M from "../src/env-prompt.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-envprompt-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BRIDGE = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  accessSync: (p, m) => fs.accessSync(p, m),
  chmodSync: (p, m) => fs.chmodSync(p, m),
};
const calls = [];
const shim = createFsPromises(async (fn, args) => {
  calls.push(fn);
  if (!BRIDGE[fn]) return { ok: false, error: { message: `fs.${fn} not allowed`, code: "EPERM" } };
  try { return { ok: true, value: BRIDGE[fn](...args) }; }
  catch (e) { return { ok: false, error: { message: e.message, code: e.code } }; }
});
const backends = { node: fs.promises, shim };

const mkdir = name => fs.mkdtempSync(path.join(tmp, `${name}-`));

test("parseEnvText handles export, quotes and junk lines", () => {
  assert.deepEqual(M.parseEnvText('export A=1\nB="two"\n# c=3\nnot a line\nC=\'x y\''), { A: "1", B: "two", C: "x y" });
});

for (const [name, fsp] of Object.entries(backends)) {
  test(`[${name}] detectEnvTargets lists existing project files, a create fallback, then global`, async () => {
    const root = mkdir(`${name}-proj`);
    const home = mkdir(`${name}-home`);
    fs.writeFileSync(path.join(root, ".env.local"), "X=1\n");
    let t = await M.detectEnvTargets(root, { fsp, home });
    assert.deepEqual(t.map(x => [path.relative(root, x.file), x.scope, x.exists]), [
      [".env.local", "project", true],
      [".env", "project", false],
      [path.relative(root, path.join(home, ".hermes", ".env")), "global", false],
    ]);
    fs.writeFileSync(path.join(root, ".env"), "Y=1\n");
    t = await M.detectEnvTargets(root, { fsp, home });
    assert.equal(t.filter(x => x.file === path.join(root, ".env")).length, 1, "no duplicate .env entry");
    assert.ok(t.find(x => x.file === path.join(root, ".env")).exists);
  });

  test(`[${name}] filterUnset ignores set values and treats empty as unset`, async () => {
    const dir = mkdir(`${name}-filter`);
    const a = path.join(dir, "a.env"), b = path.join(dir, "b.env");
    fs.writeFileSync(a, "SET_A=1\nEMPTY=\n");
    fs.writeFileSync(b, "export SET_B='v'\n");
    const missing = path.join(dir, "nope.env");
    assert.deepEqual(await M.filterUnset(["SET_A", "SET_B", "EMPTY", "NEW"], [a, b, missing], { fsp }), ["EMPTY", "NEW"]);
  });

  test(`[${name}] saveEnvVars creates, upserts and restricts permissions`, async () => {
    const home = mkdir(`${name}-save`);
    const r1 = await M.saveEnvVars({ FOO: "bar" }, undefined, { fsp, home });
    const file = path.join(home, ".hermes", ".env");
    assert.equal(r1.path, file);
    assert.deepEqual(r1.written, ["FOO"]);
    await M.saveEnvVars({ FOO: "baz", SPACE: "a b" }, file, { fsp });
    const parsed = M.parseEnvText(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.FOO, "baz");
    assert.equal(parsed.SPACE, "a b");
    assert.equal(fs.readFileSync(file, "utf8").match(/^FOO=/gm).length, 1, "updated in place");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
}

test("shim path only uses bridge-allowed fs methods", () => {
  assert.ok(calls.length > 0);
  for (const fn of calls) assert.ok(BRIDGE[fn], `unexpected bridge call ${fn}`);
});
