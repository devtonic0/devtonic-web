import test from "node:test";
import assert from "node:assert/strict";
import { langKeyFor, LANG_KEYS, EMMET_KEYS } from "../src/panels/code-langs.js";

test("langKeyFor maps common extensions", () => {
  assert.equal(langKeyFor("/p/src/a.js"), "js");
  assert.equal(langKeyFor("a.cjs"), "js");
  assert.equal(langKeyFor("App.JSX"), "jsx");
  assert.equal(langKeyFor("x.ts"), "ts");
  assert.equal(langKeyFor("x.tsx"), "tsx");
  assert.equal(langKeyFor("s.scss"), "css");
  assert.equal(langKeyFor("C.vue"), "html");
  assert.equal(langKeyFor("README.md"), "markdown");
  assert.equal(langKeyFor("main.py"), "python");
  assert.equal(langKeyFor("lib.rs"), "rust");
  assert.equal(langKeyFor("x.hpp"), "cpp");
  assert.equal(langKeyFor("C:\\proj\\q.sql"), "sql");
});

test("langKeyFor returns null for unknown or extension-less paths", () => {
  assert.equal(langKeyFor("Makefile"), null);
  assert.equal(langKeyFor(".gitignore"), null);
  assert.equal(langKeyFor("dir.d/noext"), null);
  assert.equal(langKeyFor("a.unknown"), null);
  assert.equal(langKeyFor(""), null);
  assert.equal(langKeyFor(undefined), null);
  assert.equal(langKeyFor("a.toString"), null);
});

test("every mapped key has a loader and emmet keys are a subset", () => {
  for (const ext of ["js", "jsx", "ts", "tsx", "css", "html", "json", "md", "py", "xml", "sql", "rs", "cpp"]) {
    assert.ok(LANG_KEYS.includes(langKeyFor(`f.${ext}`)), ext);
  }
  for (const k of EMMET_KEYS) assert.ok(LANG_KEYS.includes(k), k);
});
