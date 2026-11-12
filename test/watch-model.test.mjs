import { test } from "node:test";
import assert from "node:assert/strict";
import { createMtimePoller } from "../src/platform/watch-model.js";

function harness(initial) {
  let mtime = initial; // number or null (missing)
  const events = [];
  const poller = createMtimePoller("/proj/devtonic.config.json/", () => {
    if (mtime === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return mtime;
  }, (evt, name) => events.push([evt, name]));
  return { poller, events, set: v => { mtime = v; } };
}

test("first tick is a baseline and never fires", () => {
  const h = harness(1);
  h.poller.tick();
  h.poller.tick();
  assert.deepEqual(h.events, []);
});

test("mtime changes report 'change' with the basename", () => {
  const h = harness(1);
  h.poller.tick();
  h.set(2);
  h.poller.tick();
  h.poller.tick();
  assert.deepEqual(h.events, [["change", "devtonic.config.json"]]);
});

test("appear/disappear report 'rename'", () => {
  const h = harness(null);
  h.poller.tick();
  h.set(5);
  h.poller.tick(); // created
  h.set(null);
  h.poller.tick(); // deleted
  h.poller.tick(); // still missing: no event
  assert.deepEqual(h.events, [["rename", "devtonic.config.json"], ["rename", "devtonic.config.json"]]);
});
