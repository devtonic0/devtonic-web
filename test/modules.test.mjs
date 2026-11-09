import { test } from "node:test";
import assert from "node:assert/strict";
import { SHIM_MODULES, resolveModule, unavailableModuleError } from "../src/platform/modules.js";

const mods = { fs: { tag: "fs" }, path: { tag: "path" }, os: { tag: "os" }, child_process: { tag: "cp" } };

test("resolveModule returns shim modules", () => {
  for (const name of SHIM_MODULES) assert.equal(resolveModule(mods, name), mods[name]);
});

test("electron is no longer provided and points at web.js", () => {
  assert.throws(() => resolveModule({ ...mods, electron: {} }, "electron"), err => {
    assert.equal(err.code, "MODULE_NOT_FOUND");
    assert.match(err.message, /src\/platform\/web\.js/);
    assert.match(err.message, /openExternal/);
    return true;
  });
});

test("unknown modules list what is available", () => {
  const e = unavailableModuleError("net");
  assert.match(e.message, /"net" is not available/);
  assert.match(e.message, /fs, path, os, child_process/);
});

test("prototype keys are not resolvable", () => {
  assert.throws(() => resolveModule(mods, "constructor"), /not available/);
  assert.throws(() => resolveModule(mods, "__proto__"), /not available/);
});
