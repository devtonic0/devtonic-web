import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHermes, defaultIsExec, fallbackDirs } from "../server/hermes.mjs";

const HOME = "/home/u";
const only = (...ok) => p => ok.includes(p);

test("DEVTONIC_HERMES wins, with ~ expansion, even when PATH has hermes", () => {
  const r = resolveHermes({ env: { DEVTONIC_HERMES: "~/bin/devtonic-agent", PATH: "/usr/bin" }, homedir: HOME,
    isExec: only("/home/u/bin/devtonic-agent", "/usr/bin/hermes") });
  assert.deepEqual(r, { path: "/home/u/bin/devtonic-agent", source: "env", found: true });
});

test("DEVTONIC_HERMES pointing at nothing is reported, not silently ignored", () => {
  const r = resolveHermes({ env: { DEVTONIC_HERMES: "/nope/hermes", PATH: "/usr/bin" }, homedir: HOME, isExec: only("/usr/bin/hermes") });
  assert.deepEqual(r, { path: "/nope/hermes", source: "env", found: false });
});

test("blank DEVTONIC_HERMES is ignored", () => {
  const r = resolveHermes({ env: { DEVTONIC_HERMES: "  ", PATH: "/usr/bin" }, homedir: HOME, isExec: only("/usr/bin/hermes") });
  assert.equal(r.source, "path");
});

test("PATH is searched in order, like `which`", () => {
  const r = resolveHermes({ env: { PATH: ["/a", "", "/b", "/c"].join(path.delimiter) }, homedir: HOME, isExec: only("/b/hermes", "/c/hermes") });
  assert.deepEqual(r, { path: "/b/hermes", source: "path", found: true });
});

test("falls back to ~/.local/bin when PATH lacks it (GUI-launched server)", () => {
  const r = resolveHermes({ env: { PATH: "/usr/bin:/bin" }, homedir: HOME, isExec: only("/home/u/.local/bin/hermes") });
  assert.deepEqual(r, { path: "/home/u/.local/bin/hermes", source: "fallback", found: true });
  assert.equal(fallbackDirs(HOME)[0], "/home/u/.local/bin");
});

test("missing → bare name so spawn errors with ENOENT", () => {
  const r = resolveHermes({ env: { PATH: "/usr/bin" }, homedir: HOME, isExec: () => false });
  assert.deepEqual(r, { path: "hermes", source: "missing", found: false });
});

test("real probe: finds an executable on PATH and rejects non-exec / dirs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-hermes-"));
  try {
    const bin = path.join(dir, "hermes");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o644 });
    assert.equal(defaultIsExec(bin), false);
    assert.equal(defaultIsExec(dir), false);
    fs.chmodSync(bin, 0o755);
    assert.equal(defaultIsExec(bin), true);
    const r = resolveHermes({ env: { PATH: dir }, homedir: "/nonexistent-home" });
    assert.deepEqual(r, { path: bin, source: "path", found: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
