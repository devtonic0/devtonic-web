import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createModelPinner } from "../src/platform/model-pin.js";
import { modelPinBody, pinSessionModel, agentStatus } from "../server/agent-api.mjs";

const KEY = "pin-agent-key";

test("model pinner: per-turn model when the agent lacks session_model_lock", async () => {
  const calls = [];
  const p = createModelPinner({ pin: async (...a) => { calls.push(a); return { ok: true }; } });
  const r = await p.prepare({ status: { available: true }, session: "s", model: "m", provider: "prov" });
  assert.deepEqual(r, { model: "m", provider: "prov", pinned: false, changed: false });
  assert.equal(calls.length, 0);
  // No model chosen: nothing to pin or send.
  const r2 = await p.prepare({ status: { modelLock: true }, session: "s", model: "", provider: "" });
  assert.deepEqual(r2, { model: undefined, provider: undefined, pinned: false, changed: false });
  assert.equal(calls.length, 0);
});

test("model pinner: pins once per model change and drops the per-turn model", async () => {
  const calls = [];
  const p = createModelPinner({ pin: async (session, body) => { calls.push({ session, body }); return { ok: true }; } });
  const status = { available: true, modelLock: true };
  let r = await p.prepare({ status, session: "s", model: "big", provider: "prov" });
  assert.deepEqual(r, { model: undefined, provider: undefined, pinned: true, changed: true });
  r = await p.prepare({ status, session: "s", model: "big", provider: "prov" });
  assert.deepEqual(r, { model: undefined, provider: undefined, pinned: true, changed: false });
  assert.equal(calls.length, 1, "same model: no second pin");
  r = await p.prepare({ status, session: "s", model: "small", provider: "prov" });
  assert.equal(r.changed, true);
  assert.deepEqual(p.current("s"), { model: "small", provider: "prov" });
  // Sessions are independent; provider is omitted when empty.
  await p.prepare({ status, session: "other", model: "small", provider: "" });
  assert.deepEqual(calls.map(c => [c.session, c.body]),
    [["s", { model: "big", provider: "prov" }], ["s", { model: "small", provider: "prov" }], ["other", { model: "small" }]]);
  p.forget("s");
  assert.equal(p.current("s"), null);
});

test("model pinner: a refused pin falls back to per-turn model without retrying every turn", async () => {
  let n = 0;
  const p = createModelPinner({ pin: async () => { n++; return { ok: false, code: "model_lock_unavailable", error: "cannot be routed" }; } });
  const status = { modelLock: true };
  let r = await p.prepare({ status, session: "s", model: "x", provider: "p" });
  assert.deepEqual(r, { model: "x", provider: "p", pinned: false, changed: false, error: "cannot be routed" });
  r = await p.prepare({ status, session: "s", model: "x", provider: "p" });
  assert.equal(r.model, "x");
  assert.equal(r.error, undefined);
  assert.equal(n, 1, "same refused model isn't retried");
  await p.prepare({ status, session: "s", model: "y", provider: "p" });
  assert.equal(n, 2, "a different model is tried");
});

test("modelPinBody validates ids", () => {
  assert.ok(modelPinBody(null).error);
  assert.ok(modelPinBody({}).error);
  assert.ok(modelPinBody({ model: "has space" }).error);
  assert.ok(modelPinBody({ model: "m", provider: "p".repeat(81) }).error);
  assert.deepEqual(modelPinBody({ model: "anthropic/claude-x", provider: "openrouter", junk: 1 }),
    { body: { model: "anthropic/claude-x", provider: "openrouter" } });
  assert.deepEqual(modelPinBody({ model: "m", provider: "" }), { body: { model: "m" } });
});

function fakeAgent({ lock = true, refuse = false } = {}) {
  const sessions = new Set(["existing"]);
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/health") return json(200, { status: "ok" });
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: "nope" } });
    if (req.url === "/v1/capabilities") return json(200, { features: { session_chat_streaming: true, ...(lock ? { session_model_lock: true } : {}) } });
    let m = req.url.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === "GET") return sessions.has(decodeURIComponent(m[1])) ? json(200, { id: m[1] }) : json(404, { error: "missing" });
    if (req.url === "/api/sessions" && req.method === "POST") { sessions.add(JSON.parse(body).id); return json(201, {}); }
    m = req.url.match(/^\/api\/sessions\/([^/]+)\/model$/);
    if (m && req.method === "POST" && lock) {
      if (refuse) return json(409, { error: { message: "Requested Browser model lock cannot be routed", code: "model_lock_unavailable" } });
      const b = JSON.parse(body);
      return json(200, { object: "hermes.session.model_lock", session_id: decodeURIComponent(m[1]),
        runtime: { model: b.model, provider: b.provider || "", model_lock: "accepted" } });
    }
    json(404, { error: "not found" });
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

test("agentStatus reports modelLock from capabilities; pinSessionModel maps results", async () => {
  const a = await fakeAgent();
  const b = await fakeAgent({ lock: false });
  const c = await fakeAgent({ refuse: true });
  try {
    assert.equal((await agentStatus({ url: a.url, key: KEY })).modelLock, true);
    assert.equal((await agentStatus({ url: b.url, key: KEY })).modelLock, false);
    const ok = await pinSessionModel({ url: a.url, key: KEY }, "fresh", { model: "m", provider: "p" });
    assert.deepEqual(ok, { ok: true, status: 200, runtime: { model: "m", provider: "p", model_lock: "accepted" } });
    assert.ok(a.calls.some(x => x.method === "POST" && x.url === "/api/sessions"), "missing session is created first");
    const un = await pinSessionModel({ url: b.url, key: KEY }, "existing", { model: "m" });
    assert.equal(un.code, "unsupported");
    const no = await pinSessionModel({ url: c.url, key: KEY }, "existing", { model: "m" });
    assert.deepEqual(no, { ok: false, status: 409, code: "model_lock_unavailable", error: "Requested Browser model lock cannot be routed" });
    const down = await pinSessionModel({ url: "http://127.0.0.1:1", key: KEY }, "existing", { model: "m" });
    assert.equal(down.code, "agent_unreachable");
  } finally { a.srv.close(); b.srv.close(); c.srv.close(); }
});

test("bridge POST /api/agent/sessions/:id/model forwards the pin with the key and validates input", async () => {
  const a = await fakeAgent();
  const PORT = 4786, TOKEN = "pintok";
  const bridge = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DEVTONIC_PORT: String(PORT), DEVTONIC_TOKEN: TOKEN,
    DEVTONIC_AGENT_URL: a.url, DEVTONIC_AGENT_KEY: KEY, DEVTONIC_AGENT_API: "" } });
  try {
    await new Promise((res, rej) => { bridge.stdout.on("data", d => String(d).includes("running") && res()); bridge.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
    const base = `http://127.0.0.1:${PORT}/api/agent/sessions`;
    const h = { "x-devtonic-token": TOKEN, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/existing/model`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/bad%20id/model`, { method: "POST", headers: h, body: JSON.stringify({ model: "m" }) })).status, 400);
    assert.equal((await fetch(`${base}/existing/model`, { method: "POST", headers: h, body: JSON.stringify({ model: "" }) })).status, 400);
    assert.equal((await fetch(`${base}/existing/model`, { method: "POST", headers: h, body: "not json" })).status, 400);
    const r = await fetch(`${base}/existing/model`, { method: "POST", headers: h, body: JSON.stringify({ model: "m", provider: "p", junk: 1 }) });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!text.includes(KEY), "response must not leak the agent key");
    assert.equal(JSON.parse(text).runtime.model_lock, "accepted");
    const sent = a.calls.find(c => c.url === "/api/sessions/existing/model");
    assert.deepEqual(JSON.parse(sent.body), { model: "m", provider: "p" });
    assert.equal(sent.auth, `Bearer ${KEY}`);
  } finally { bridge.kill(); a.srv.close(); }
});
