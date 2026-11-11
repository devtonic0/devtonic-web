import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, frameVerdict, emptyNav, navPush, navBack, navForward, navCurrent } from "../src/platform/frame-model.js";

const ME = "http://127.0.0.1:4777";
const T = "https://example.com/page";

test("normalizeUrl", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeUrl("127.0.0.1:5173/x"), "http://127.0.0.1:5173/x");
  assert.equal(normalizeUrl("github.com"), "https://github.com/");
  assert.equal(normalizeUrl(" http://a.test/ "), "http://a.test/");
  assert.equal(normalizeUrl("ftp://x.test"), null);
  assert.equal(normalizeUrl(""), null);
});

test("nav stack: push truncates forward history", () => {
  let n = emptyNav("a");
  n = navPush(n, "b"); n = navPush(n, "c");
  n = navBack(navBack(n));
  assert.equal(navCurrent(n), "a");
  assert.equal(navBack(n), n);
  n = navForward(n);
  assert.equal(navCurrent(n), "b");
  n = navPush(n, "d");
  assert.deepEqual(n.stack, ["a", "b", "d"]);
  assert.equal(navForward(n), n);
  assert.equal(navPush(n, "d"), n);
});

test("X-Frame-Options", () => {
  assert.deepEqual(frameVerdict({}, ME, T), { blocked: false, reason: null });
  assert.equal(frameVerdict({ "x-frame-options": "DENY" }, ME, T).blocked, true);
  assert.equal(frameVerdict({ "x-frame-options": ["sameorigin"] }, ME, T).reason, "X-Frame-Options: SAMEORIGIN");
  assert.equal(frameVerdict({ "x-frame-options": "SAMEORIGIN" }, ME, `${ME}/x`).blocked, false);
  assert.equal(frameVerdict({ "x-frame-options": "ALLOW-FROM https://a.test" }, ME, T).blocked, false);
});

test("CSP frame-ancestors overrides XFO", () => {
  const v = (csp, xfo) => frameVerdict({ "content-security-policy": csp, ...(xfo ? { "x-frame-options": xfo } : {}) }, ME, T).blocked;
  assert.equal(v("frame-ancestors 'none'"), true);
  assert.equal(v("default-src 'self'; frame-ancestors 'self'"), true);
  assert.equal(v("frame-ancestors *", "DENY"), false);
  assert.equal(v("frame-ancestors http://127.0.0.1:4777"), false);
  assert.equal(v("frame-ancestors http://127.0.0.1:9999"), true);
  assert.equal(v("frame-ancestors http://127.0.0.1:*"), false);
  assert.equal(v("frame-ancestors https:"), true);
  assert.equal(v("frame-ancestors http:"), false);
  assert.equal(v("frame-ancestors https://*.google.com"), true);
  assert.equal(v("default-src 'none'"), false);
  assert.equal(v(["frame-ancestors *", "frame-ancestors 'none'"]), true);
  assert.match(frameVerdict({ "content-security-policy": "frame-ancestors 'self'" }, ME, T).reason, /frame-ancestors 'self'/);
});
