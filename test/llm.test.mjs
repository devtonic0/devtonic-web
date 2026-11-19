// llm.js config/env resolution: llmClient() must read ~/.hermes/config.yaml
// and ~/.hermes/.env through fs.promises (no sync XHR in the browser).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadStoreEnv } from "./helpers/store-env.mjs";

const env = await loadStoreEnv();
after(env.cleanup);

// Fail loudly if llm.js falls back to a sync read.
const realFs = window.require("fs");
const guarded = { ...realFs };
for (const k of ["readFileSync", "readdirSync", "statSync", "existsSync"]) {
  guarded[k] = () => { throw new Error(`sync fs.${k} used`); };
}
const prevRequire = window.require;
window.require = name => (name === "fs" ? guarded : prevRequire(name));
const llm = await import("../src/llm.js");
window.require = prevRequire;

const hermesDir = path.join(env.home, ".hermes");
const write = (cfg, dotenv) => {
  fs.mkdirSync(hermesDir, { recursive: true });
  fs.writeFileSync(path.join(hermesDir, "config.yaml"), cfg);
  fs.writeFileSync(path.join(hermesDir, ".env"), dotenv);
};

test("parseEnv reads KEY=value lines only", () => {
  assert.deepEqual(llm.parseEnv("A_KEY=1\n# c\nlower=x\nB=two words\n"), { A_KEY: "1", B: "two words" });
  assert.deepEqual(llm.parseEnv(""), {});
});

test("yamlGet resolves a nested dotted key", () => {
  const y = "model:\n  provider: openai\n  default: gpt-5\nother: 1\n";
  assert.equal(llm.yamlGet(y, "model.provider"), "openai");
  assert.equal(llm.yamlGet(y, "model.default"), "gpt-5");
  assert.equal(llm.yamlGet(y, "model.missing"), "");
});

test("llmClient resolves provider, model and key asynchronously", async () => {
  write("model:\n  provider: openrouter\n  default: some/model\n", "OPENROUTER_API_KEY=sk-test\n");
  const p = llm.llmClient();
  assert.ok(p instanceof Promise);
  const c = await p;
  assert.equal(c.provider, "openrouter");
  assert.equal(c.model, "some/model");
  assert.equal(c.apiKey, "sk-test");
  assert.equal(c.kind, "openai");
});

test("llmClient defaults to anthropic and reports a missing key", async () => {
  write("", "");
  await assert.rejects(llm.llmClient(), /Missing ANTHROPIC_API_KEY/);
});

test("llmClient rejects unsupported providers", async () => {
  write("model:\n  provider: nope\n", "");
  await assert.rejects(llm.llmClient(), /not supported for provider "nope"/);
});

test("llmClient tolerates missing files", async () => {
  fs.rmSync(hermesDir, { recursive: true, force: true });
  await assert.rejects(llm.llmClient(), /Missing ANTHROPIC_API_KEY/);
});
