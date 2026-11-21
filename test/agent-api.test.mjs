import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { parseDotenv, agentConfig, agentStatus, chatRequestBody } from "../server/agent-api.mjs";

const KEY = "fake-agent-key";

test("parseDotenv handles export, quotes and comments", () => {
  assert.deepEqual(parseDotenv("export A=1\nB=\"two words\"\nC='x' \nD=plain # note\n# E=no\nbad line"),
    { A: "1", B: "two words", C: "x", D: "plain" });
});

test("agentConfig: precedence of URL, port and key sources", () => {
  const dot = "API_SERVER_KEY=fromdot\nAPI_SERVER_PORT=9001\n";
  const read = () => dot;
  let c = agentConfig({}, { home: "/h", readFile: read });
  assert.deepEqual(c, { url: "http://127.0.0.1:9001", key: "fromdot", keySource: "dotenv", disabled: false });
  c = agentConfig({ API_SERVER_KEY: "envk", API_SERVER_PORT: "9002" }, { home: "/h", readFile: read });
  assert.equal(c.keySource, "env");
  assert.equal(c.url, "http://127.0.0.1:9002");
  c = agentConfig({ DEVTONIC_AGENT_KEY: "dk", DEVTONIC_AGENT_URL: "http://x:1/", API_SERVER_KEY: "envk" }, { home: "/h", readFile: read });
  assert.deepEqual([c.url, c.key, c.keySource], ["http://x:1", "dk", "DEVTONIC_AGENT_KEY"]);
  c = agentConfig({ DEVTONIC_AGENT_API: "0" }, { home: "/h", readFile: () => { throw new Error("ENOENT"); } });
  assert.equal(c.disabled, true);
  assert.equal(c.keySource, "none");
  // HERMES_HOME decides where .env is read from.
  let seen;
  agentConfig({ HERMES_HOME: "/custom" }, { home: "/h", readFile: p => { seen = p; return ""; } });
  assert.match(seen, /custom[\\/]\.env$/);
});

test("chatRequestBody validates and maps fields", () => {
  assert.ok(chatRequestBody(null).error);
  assert.ok(chatRequestBody({ session: "bad id with spaces", message: "x" }).error);
  assert.ok(chatRequestBody({ session: "ok", message: "  " }).error);
  assert.deepEqual(chatRequestBody({ session: "proj-11-21-1200", message: "hi", instructions: "ctx", model: "m", provider: "p", extra: 1 }),
    { session: "proj-11-21-1200", body: { message: "hi", system_message: "ctx", model: "m", provider: "p" } });
});

// --- fake agent API -------------------------------------------------------
function fakeAgent({ caps = { features: { session_chat_streaming: true } } } = {}) {
  const sessions = new Set(["existing"]);
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/health") return json(200, { status: "ok", version: "9.9" });
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: "nope" } });
    if (req.url === "/v1/capabilities") return json(200, caps);
    let m = req.url.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === "GET") return sessions.has(decodeURIComponent(m[1])) ? json(200, { id: m[1] }) : json(404, { error: "missing" });
    if (req.url === "/api/sessions" && req.method === "POST") { sessions.add(JSON.parse(body).id); return json(201, {}); }
    m = req.url.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/);
    if (m) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify({ run_id: "run_abc", ...d })}\n\n`);
      send("run.started", {});
      send("assistant.delta", { delta: "hi " });
      res.write(": keepalive\n\n");
      send("assistant.delta", { delta: "there" });
      send("assistant.completed", { content: "hi there" });
      send("run.completed", {});
      send("done", {});
      return res.end();
    }
    m = req.url.match(/^\/v1\/runs\/([^/]+)\/(stop|approval)$/);
    if (m) return json(200, { run_id: m[1], action: m[2], echo: body ? JSON.parse(body) : null });
    json(404, {});
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

test("agentStatus classifies reachability, auth and capability", async () => {
  const a = await fakeAgent();
  try {
    assert.equal((await agentStatus({ url: a.url, key: KEY, keySource: "env" })).available, true);
    assert.equal((await agentStatus({ url: a.url, key: "wrong", keySource: "env" })).reason, "unauthorized");
    assert.equal((await agentStatus({ url: a.url, key: "", keySource: "none" })).reason, "no-key");
    assert.equal((await agentStatus({ url: "http://127.0.0.1:1", key: KEY })).reason, "unreachable");
    assert.equal((await agentStatus({ url: a.url, key: KEY, disabled: true })).reason, "disabled");
  } finally { a.srv.close(); }
  const b = await fakeAgent({ caps: { features: { session_chat_streaming: false } } });
  try { assert.equal((await agentStatus({ url: b.url, key: KEY })).reason, "unsupported"); }
  finally { b.srv.close(); }
});

test("bridge /api/agent/*: status, chat SSE passthrough, run controls; key never reaches the browser", async () => {
  const a = await fakeAgent();
  const PORT = 4781, TOKEN = "agenttok";
  const bridge = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DEVTONIC_PORT: String(PORT), DEVTONIC_TOKEN: TOKEN,
    DEVTONIC_AGENT_URL: a.url, DEVTONIC_AGENT_KEY: KEY, DEVTONIC_AGENT_API: "" } });
  try {
    await new Promise((res, rej) => { bridge.stdout.on("data", d => String(d).includes("running") && res()); bridge.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
    const base = `http://127.0.0.1:${PORT}`;
    const h = { "x-devtonic-token": TOKEN, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/agent/status`)).status, 401);

    const statusText = await (await fetch(`${base}/api/agent/status`, { headers: h })).text();
    const st = JSON.parse(statusText);
    assert.equal(st.available, true);
    assert.equal(st.version, "9.9");
    assert.ok(!statusText.includes(KEY), "status must not leak the agent key");

    const bad = await fetch(`${base}/api/agent/chat`, { method: "POST", headers: h, body: JSON.stringify({ session: "x y", message: "hi" }) });
    assert.equal(bad.status, 400);

    // New session: bridge creates it, then streams the turn.
    const r = await fetch(`${base}/api/agent/chat`, { method: "POST", headers: h,
      body: JSON.stringify({ session: "fresh-1", message: "hello", instructions: "ctx" }) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    const sse = await r.text();
    assert.match(sse, /event: run.started/);
    assert.match(sse, /"content":"hi there"/);
    assert.match(sse, /event: done/);
    const created = a.calls.find(c => c.method === "POST" && c.url === "/api/sessions");
    assert.deepEqual(JSON.parse(created.body), { id: "fresh-1" });
    const turn = a.calls.find(c => c.url === "/api/sessions/fresh-1/chat/stream");
    assert.deepEqual(JSON.parse(turn.body), { message: "hello", system_message: "ctx" });
    assert.equal(turn.auth, `Bearer ${KEY}`);

    // Existing session isn't re-created.
    const before = a.calls.filter(c => c.url === "/api/sessions").length;
    await (await fetch(`${base}/api/agent/chat`, { method: "POST", headers: h, body: JSON.stringify({ session: "existing", message: "again" }) })).text();
    assert.equal(a.calls.filter(c => c.url === "/api/sessions").length, before);

    const ap = await (await fetch(`${base}/api/agent/runs/run_abc/approval`, { method: "POST", headers: h,
      body: JSON.stringify({ choice: "once", request_id: "rq", junk: true }) })).json();
    assert.deepEqual(ap.echo, { choice: "once", request_id: "rq" });
    const stop = await (await fetch(`${base}/api/agent/runs/run_abc/stop`, { method: "POST", headers: h })).json();
    assert.equal(stop.action, "stop");
    assert.equal((await fetch(`${base}/api/agent/runs/..%2Fx/stop`, { method: "POST", headers: h })).status, 400);
    assert.equal((await fetch(`${base}/api/agent/nope`, { headers: h })).status, 404);
  } finally { bridge.kill(); a.srv.close(); }
});

test("bridge /api/agent/chat reports agent_unreachable so the UI can fall back to the CLI", async () => {
  const PORT = 4782, TOKEN = "agenttok2";
  const bridge = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DEVTONIC_PORT: String(PORT), DEVTONIC_TOKEN: TOKEN,
    DEVTONIC_AGENT_URL: "http://127.0.0.1:1", DEVTONIC_AGENT_KEY: KEY, DEVTONIC_AGENT_API: "" } });
  try {
    await new Promise((res, rej) => { bridge.stdout.on("data", d => String(d).includes("running") && res()); bridge.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
    const h = { "x-devtonic-token": TOKEN, "content-type": "application/json" };
    const r = await fetch(`http://127.0.0.1:${PORT}/api/agent/chat`, { method: "POST", headers: h, body: JSON.stringify({ session: "s", message: "hi" }) });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).code, "agent_unreachable");
    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/agent/status`, { headers: h })).json();
    assert.equal(st.available, false);
    assert.equal(st.reason, "unreachable");
  } finally { bridge.kill(); }
});
