import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadStoreEnv } from "./helpers/store-env.mjs";

const env = await loadStoreEnv();
const { classifyTask, routeModel, routingStatus, setRouting } = env.routing;
after(env.cleanup);

test("classifyTask honours an explicit hint", () => {
  assert.equal(classifyTask({ hint: "cheap", prompt: "please architect the whole system" }), "cheap");
});

test("classifyTask: reasoning verbs → top", () => {
  for (const p of ["Why does this crash?", "plan the migration", "debug the login flow", "find the root cause", "analyse the logs", "analyze perf", "figure out the leak"]) {
    assert.equal(classifyTask({ prompt: p }), "top", p);
  }
});

test("classifyTask: refactor/multi-file verbs → strong", () => {
  for (const p of ["refactor the store", "migrate to vite 6", "multi-file rename", "multi file rename", "overhaul settings"]) {
    assert.equal(classifyTask({ prompt: p }), "strong", p);
  }
  // top wins over strong when both match
  assert.equal(classifyTask({ prompt: "plan and refactor" }), "top");
});

test("classifyTask: short acknowledgements → cheap, everything else → mid", () => {
  assert.equal(classifyTask({ prompt: "ok" }), "cheap");
  assert.equal(classifyTask({ prompt: "  Thanks!" }), "cheap");
  assert.equal(classifyTask({ prompt: "yes", contextChars: 500 }), "mid", "large context is never cheap");
  assert.equal(classifyTask({ prompt: "add a button to the toolbar" }), "mid");
  assert.equal(classifyTask({ prompt: "okay go" }), "mid", "word boundary: 'okay' is not 'ok'");
  assert.equal(classifyTask({}), "mid");
  assert.equal(classifyTask({ prompt: "rewrite" }), "strong");
  assert.equal(classifyTask({ prompt: "explainer" }), "mid", "word boundary on reasoning verbs");
});

test("routeModel returns the default model while routing is disabled", () => {
  assert.equal(routeModel("anthropic", "my-model", "top"), "my-model");
  assert.deepEqual(routingStatus(), { enabled: false, overrides: {} });
});

test("routeModel uses per-provider tier defaults once enabled", () => {
  setRouting({ enabled: true });
  assert.equal(routingStatus().enabled, true);
  const tiers = ["top", "strong", "mid", "cheap"].map(t => routeModel("anthropic", "dflt", t));
  assert.ok(tiers.every(m => m && m !== "dflt"), "anthropic maps every tier");
  assert.equal(new Set(tiers).size, 4);
  assert.equal(routeModel("unknown-provider", "dflt", "top"), "dflt");
  assert.equal(routeModel("anthropic", "dflt", "nonexistent-tier"), "dflt");
});

test("routeModel prefers user overrides and setRouting merges patches", () => {
  setRouting({ anthropic: { mid: "custom-mid" } });
  assert.equal(routeModel("anthropic", "dflt", "mid"), "custom-mid");
  assert.notEqual(routeModel("anthropic", "dflt", "top"), "dflt", "non-overridden tiers keep defaults");
  assert.equal(routingStatus().enabled, true, "earlier keys survive the patch");
  assert.deepEqual(env.readSettings().modelRouting, { enabled: true, anthropic: { mid: "custom-mid" } });

  setRouting({ enabled: false });
  assert.equal(routeModel("anthropic", "dflt", "mid"), "dflt", "disabling ignores overrides");
});
