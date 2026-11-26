import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { parseArgs, USAGE } from "../server/cli.mjs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const BIN = "bin/devtonic-web.mjs";

test("cli: parseArgs defaults and flags", () => {
  assert.deepEqual(parseArgs([]), { help: false, version: false, open: true, port: null, error: null });
  assert.equal(parseArgs(["--no-open"]).open, false);
  assert.equal(parseArgs(["--no-open", "--open"]).open, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["-p", "5000"]).port, 5000);
  assert.equal(parseArgs(["--port=5001"]).port, 5001);
  assert.equal(parseArgs(["--port", "5002", "--no-open"]).open, false);
});

test("cli: parseArgs rejects bad input", () => {
  assert.match(parseArgs(["--port"]).error, /invalid port: \(missing\)/);
  assert.match(parseArgs(["--port", "abc"]).error, /invalid port: abc/);
  assert.match(parseArgs(["--port=0"]).error, /invalid port/);
  assert.match(parseArgs(["--port", "70000"]).error, /invalid port/);
  assert.match(parseArgs(["--bogus"]).error, /unknown option: --bogus/);
  assert.match(USAGE, /--no-open/);
});

test("cli: bin prints version/help and rejects unknown flags", () => {
  assert.equal(execFileSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }).trim(), pkg.version);
  assert.match(execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }), /Usage: devtonic-web/);
  let err;
  try { execFileSync(process.execPath, [BIN, "--nope"], { encoding: "utf8", stdio: "pipe" }); } catch (e) { err = e; }
  assert.equal(err?.status, 2);
  assert.match(String(err.stderr), /unknown option: --nope/);
});

test("cli: bin starts the bridge on --port without opening a browser", async () => {
  const p = spawn(process.execPath, [BIN, "--port", "4774", "--no-open"], { env: { ...process.env, DEVTONIC_TOKEN: "clitoken" } });
  try {
    const line = await new Promise((res, rej) => {
      let buf = "";
      p.stdout.on("data", d => { buf += d; if (buf.includes("running")) res(buf); });
      p.on("error", rej); p.on("exit", c => rej(new Error(`exited ${c}`)));
      setTimeout(() => rej(new Error("boot timeout")), 5000);
    });
    assert.match(line, /http:\/\/127\.0\.0\.1:4774\/\?token=clitoken/);
    const r = await fetch("http://127.0.0.1:4774/api/env", { headers: { "x-devtonic-token": "clitoken" } });
    assert.equal(r.status, 200);
  } finally { p.kill(); }
});

test("cli: a busy port exits with a clear message", async () => {
  const a = spawn(process.execPath, [BIN, "--port", "4773", "--no-open"], { env: { ...process.env, DEVTONIC_TOKEN: "x" } });
  try {
    await new Promise((res, rej) => { a.stdout.on("data", d => String(d).includes("running") && res()); setTimeout(() => rej(new Error("boot timeout")), 5000); });
    const b = spawn(process.execPath, [BIN, "--port", "4773", "--no-open"]);
    let err = "";
    b.stderr.on("data", d => { err += d; });
    const code = await new Promise(res => b.on("exit", res));
    assert.equal(code, 1);
    assert.match(err, /port 4773 is already in use/);
  } finally { a.kill(); }
});

test("package: npm-ready manifest (bin, files, runtime deps only)", () => {
  assert.equal(pkg.bin["devtonic-web"], BIN);
  assert.ok(fs.readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node"));
  assert.ok(fs.statSync(BIN).mode & 0o111, "bin must be executable");
  for (const f of ["bin/**", "dist/**", "server/**", "src/platform/frame-model.js"]) assert.ok(pkg.files.includes(f), f);
  assert.equal(pkg.scripts.prepack, "npm run build");
  // Only what the bridge imports at runtime; the UI ships prebuilt in dist/.
  assert.deepEqual(Object.keys(pkg.dependencies), ["ws"]);
  const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
  // Every bare import in shipped server code must be a runtime dependency.
  for (const f of fs.readdirSync("server")) {
    const src = fs.readFileSync(`server/${f}`, "utf8");
    for (const [, spec] of src.matchAll(/from "([^".][^"]*)"/g)) {
      if (spec.startsWith("node:")) continue;
      assert.ok(pkg.dependencies[spec.split("/")[0]], `${f} imports ${spec}, which is not a dependency`);
    }
  }
});

test("package: npm pack contents", { skip: !fs.existsSync("dist/index.html") && "dist/ not built" }, () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map(f => f.path);
  for (const f of ["bin/devtonic-web.mjs", "server/index.mjs", "server/cli.mjs", "dist/index.html", "src/platform/frame-model.js", "package.json", "README.md", "LICENSE"])
    assert.ok(files.includes(f), `missing ${f}`);
  assert.ok(!files.some(f => f.startsWith("test/") || f.startsWith("node_modules/") || f.startsWith("src/panels")), "unexpected files in package");
});
