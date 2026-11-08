import { test } from "node:test";
import assert from "node:assert/strict";
import { safeExternalUrl, shouldNotify, notificationStatus, clampScale, notificationBody } from "../src/platform/web-model.js";

test("safeExternalUrl allows http/https/mailto only", () => {
  assert.equal(safeExternalUrl("http://localhost:3000"), "http://localhost:3000/");
  assert.equal(safeExternalUrl(" https://github.com/login/device "), "https://github.com/login/device");
  assert.equal(safeExternalUrl("mailto:a@b.c"), "mailto:a@b.c");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("file:///etc/passwd"), null);
  assert.equal(safeExternalUrl("not a url"), null);
  assert.equal(safeExternalUrl(""), null);
  assert.equal(safeExternalUrl(undefined), null);
});

test("shouldNotify requires permission and a hidden or unfocused tab", () => {
  const base = { supported: true, permission: "granted", visible: false, focused: false };
  assert.equal(shouldNotify(base), true);
  assert.equal(shouldNotify({ ...base, visible: true, focused: false }), true);
  assert.equal(shouldNotify({ ...base, visible: true, focused: true }), false);
  assert.equal(shouldNotify({ ...base, permission: "default" }), false);
  assert.equal(shouldNotify({ ...base, permission: "denied" }), false);
  assert.equal(shouldNotify({ ...base, supported: false }), false);
});

test("notificationStatus", () => {
  assert.deepEqual(notificationStatus({ supported: true, permission: "default", secure: true }), { label: "not enabled", canRequest: true });
  assert.equal(notificationStatus({ supported: true, permission: "granted", secure: true }).canRequest, false);
  assert.match(notificationStatus({ supported: true, permission: "denied", secure: true }).label, /blocked/);
  assert.match(notificationStatus({ supported: false }).label, /not supported/);
  assert.match(notificationStatus({ supported: true, permission: "default", secure: false }).label, /secure/);
});

test("clampScale", () => {
  assert.equal(clampScale(100), 100);
  assert.equal(clampScale(10), 70);
  assert.equal(clampScale(999), 160);
  assert.equal(clampScale("125"), 125);
  assert.equal(clampScale("x"), 100);
  assert.equal(clampScale(undefined), 100);
});

test("notificationBody collapses whitespace and truncates on a word", () => {
  assert.equal(notificationBody("  a\n b  "), "a b");
  assert.equal(notificationBody(null), "");
  const out = notificationBody("word ".repeat(60), 40);
  assert.ok(out.length <= 40, out);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("wor…"));
});
