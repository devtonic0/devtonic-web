import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, parentDir, joinPath, crumbs, expandHome, extensionsFrom, visibleEntries } from "../src/platform/picker-model.js";

test("normalize / parentDir / joinPath", () => {
  assert.equal(normalize("//a/./b/../c/"), "/a/c");
  assert.equal(normalize("/.."), "/");
  assert.equal(parentDir("/a/b"), "/a");
  assert.equal(parentDir("/a"), "/");
  assert.equal(parentDir("/"), "/");
  assert.equal(joinPath("/a/b", "../c"), "/a/c");
});

test("crumbs", () => {
  assert.deepEqual(crumbs("/x/y"), [
    { label: "/", path: "/" }, { label: "x", path: "/x" }, { label: "y", path: "/x/y" },
  ]);
  assert.deepEqual(crumbs("/"), [{ label: "/", path: "/" }]);
});

test("expandHome", () => {
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("~/proj/", "/home/u"), "/home/u/proj");
  assert.equal(expandHome(" /tmp ", "/home/u"), "/tmp");
});

test("extensionsFrom electron-style filters", () => {
  assert.deepEqual(extensionsFrom([{ name: "W", extensions: ["gz", "TGZ"] }, { name: "all", extensions: ["*"] }]), ["gz", "tgz"]);
  assert.deepEqual(extensionsFrom(undefined), []);
});

const ents = [
  { name: "zeta", isDir: true, isFile: false },
  { name: ".git", isDir: true, isFile: false },
  { name: "a.tar.gz", isDir: false, isFile: true },
  { name: "notes.md", isDir: false, isFile: true },
  { name: "Alpha", isDir: true, isFile: false },
];

test("visibleEntries folder mode: dirs only, hidden filtered, sorted", () => {
  assert.deepEqual(visibleEntries(ents).map(e => e.name), ["Alpha", "zeta"]);
  assert.deepEqual(visibleEntries(ents, { showHidden: true }).map(e => e.name), [".git", "Alpha", "zeta"]);
});

test("visibleEntries file mode: dirs first, extension filter", () => {
  assert.deepEqual(visibleEntries(ents, { mode: "file" }).map(e => e.name), ["Alpha", "zeta", "a.tar.gz", "notes.md"]);
  assert.deepEqual(visibleEntries(ents, { mode: "file", extensions: ["gz"] }).map(e => e.name), ["Alpha", "zeta", "a.tar.gz"]);
});
