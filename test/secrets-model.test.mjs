// secrets-model.js: env-file discovery, parsing and edits. Runs against real
// Node fs.promises and the browser shim's createFsPromises (fed by the same
// allow-list as server/index.mjs) so the Secrets panel only needs methods the
// bridge exposes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFsPromises } from "../src/platform/fs-async.js";
import * as M from "../src/panels/secrets-model.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-secrets-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BRIDGE = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, d, o) => fs.writeFileSync(p, d, o),
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  accessSync: (p, m) => fs.accessSync(p, m),
  chmodSync: (p, m) => fs.chmodSync(p, m),
  readdirSync: (p, o) => o?.withFileTypes
    ? fs.readdirSync(p, { withFileTypes: true }).map(d => ({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile() }))
    : fs.readdirSync(p),
};
const calls = [];
const shim = createFsPromises(async (fn, args) => {
  calls.push(fn);
  if (!BRIDGE[fn]) return { ok: false, error: { message: `fs.${fn} not allowed`, code: "EPERM" } };
  try { return { ok: true, value: BRIDGE[fn](...args) }; }
  catch (e) { return { ok: false, error: { message: e.message, code: e.code } }; }
});
const backends = { node: fs.promises, shim };

const mkProject = name => {
  const root = fs.mkdtempSync(path.join(tmp, `${name}-`));
  const w = (rel, txt) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), txt); };
  w(".env", "A=1\n");
  w("api/.env.production", "B=2\n");
  w("web/deep/.envrc", "export C=3\n");
  w("node_modules/pkg/.env", "NO=1\n");
  w(".git/.env", "NO=1\n");
  w(".config/.env", "D=4\n");
  w("README.md", "x");
  return root;
};

test("isEnvFile / parse / mask", () => {
  for (const n of [".env", ".env.local", ".envrc", "env"]) assert.ok(M.isEnvFile(n), n);
  for (const n of ["env.js", "x.env", ".environment"]) assert.ok(!M.isEnvFile(n), n);
  assert.deepEqual(M.parse("# c\nexport A=1\nB = \"two\"\nbad line\n"),
    [{ key: "A", value: "1", line: 1 }, { key: "B", value: "two", line: 2 }]);
  assert.equal(M.mask("abc"), "•••");
  assert.equal(M.mask("abcdefghij"), "abc•••••ij");
});

test("upsertVar / removeVar preserve unrelated lines and quote safely", () => {
  const src = "# header\nexport A=1\nB=2";
  assert.equal(M.upsertVar(src, "A", "9"), "# header\nexport A=9\nB=2");
  assert.equal(M.upsertVar(src, "C", "x y"), "# header\nexport A=1\nB=2\n\nC=\"x y\"");
  assert.equal(M.upsertVar("", "K", 'a"$b'), 'K="a\\"\\$b"');
  assert.equal(M.removeVar(src, "A"), "# header\nB=2");
  assert.equal(M.removeVar(src, "Z"), src);
});

for (const [name, fsp] of Object.entries(backends)) {
  test(`[${name}] findEnvFiles skips ignored and dot dirs, bounded by depth/count`, async () => {
    const root = mkProject(`${name}-find`);
    const rel = (await M.findEnvFiles(fsp, path, root)).map(f => path.relative(root, f)).sort();
    assert.deepEqual(rel, [".config/.env", ".env", "api/.env.production", "web/deep/.envrc"]);
    assert.deepEqual((await M.findEnvFiles(fsp, path, root, 0)).map(f => path.basename(f)), [".env"]);
    assert.equal((await M.findEnvFiles(fsp, path, root, 6, 2)).length, 2);
    assert.deepEqual(await M.findEnvFiles(fsp, path, path.join(root, "missing")), []);
  });

  test(`[${name}] detectSections: defaults, discovered labels, global, exists flags`, async () => {
    const root = mkProject(`${name}-detect`);
    const home = path.join(tmp, `${name}-home`);
    const secs = await M.detectSections(fsp, path, root, { mission: {}, homedir: home });
    const base = path.basename(root);
    // Fixed head (project defaults, deduped) and tail (global); discovered files
    // in between, in readdir order — compare those as a set.
    assert.equal(secs.length, 6);
    assert.deepEqual(secs.slice(0, 2).map(s => [s.name, s.exists]), [[`${base} · .env`, true], [`${base} · .env.local`, false]]);
    assert.deepEqual(secs.slice(2, 5).map(s => s.name).sort(), [".config · .env", "api · .env.production", "web/deep · .envrc"]);
    assert.ok(secs.slice(2, 5).every(s => s.exists));
    assert.deepEqual([secs[5].name, secs[5].exists], ["hermes · global", false]);
    assert.equal(secs.at(-1).file, path.join(home, ".hermes", ".env"));

    const explicit = await M.detectSections(fsp, path, root, {
      mission: { secrets: [{ name: "api", file: "api/.env.production" }, { name: "abs", file: "/nope/.env" }] }, homedir: home,
    });
    assert.deepEqual(explicit, [
      { name: "api", file: path.join(root, "api/.env.production"), exists: true },
      { name: "abs", file: "/nope/.env", exists: false },
    ]);
  });

  test(`[${name}] readVars / writeVar / deleteVar round-trip, create with 0600`, async () => {
    const root = fs.mkdtempSync(path.join(tmp, `${name}-rw-`));
    const file = path.join(root, "nested", ".env");
    assert.deepEqual(await M.readVars(fsp, file), []);
    await M.deleteVar(fsp, file, "X");                      // missing file → no-op
    assert.ok(!fs.existsSync(file));
    await M.writeVar(fsp, path, file, "X", "1");
    await M.writeVar(fsp, path, file, "Y", "has space");
    await M.writeVar(fsp, path, file, "X", "2");
    assert.equal(fs.readFileSync(file, "utf8"), 'X=2\n\nY="has space"');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual((await M.readVars(fsp, file)).map(v => [v.key, v.value]), [["X", "2"], ["Y", "has space"]]);
    await M.deleteVar(fsp, file, "X");
    assert.deepEqual((await M.readVars(fsp, file)).map(v => v.key), ["Y"]);
  });

  test(`[${name}] readVars surfaces non-ENOENT errors`, async () => {
    const dir = fs.mkdtempSync(path.join(tmp, `${name}-dir-`));
    await assert.rejects(M.readVars(fsp, dir));            // EISDIR, not silently []
  });
}

test("shim backend was exercised and never hit a non-allow-listed method", () => {
  assert.ok(calls.length > 10);
  assert.ok(calls.every(fn => fn in BRIDGE), [...new Set(calls)].join(","));
});
