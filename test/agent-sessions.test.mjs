import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { sessionSummary, messageText, transcriptMessages, listAgentSessions, agentSessionMessages } from "../server/agent-api.mjs";
import { relativeAge, sessionLabel, filterSessions, transcriptToChat, withSession, olderCursor, prependOlder } from "../src/platform/agent-sessions.js";

const KEY = "sessions-agent-key";

test("sessionSummary keeps picker fields, drops unusable ids and private fields", () => {
  const s = sessionSummary({ id: "abc_1", title: "Fix login", preview: "p".repeat(300), source: "cli", model: "m",
    started_at: 10, last_active: 20, message_count: 4, pinned: 1, archived: 0, system_prompt: "secret", has_system_prompt: true });
  assert.deepEqual(s, { id: "abc_1", title: "Fix login", preview: "p".repeat(160), source: "cli", model: "m",
    startedAt: 10, lastActive: 20, messageCount: 4, pinned: true, archived: false });
  assert.equal(sessionSummary({ id: "has space" }), null);
  assert.equal(sessionSummary({ id: 5 }), null);
  assert.equal(sessionSummary(null), null);
  // last_active falls back to started_at; missing count is 0.
  const t = sessionSummary({ id: "x", started_at: 7 });
  assert.equal(t.lastActive, 7);
  assert.equal(t.messageCount, 0);
  assert.equal(t.title, "");
});

test("transcriptMessages keeps user/assistant text turns only", () => {
  assert.equal(messageText([{ type: "text", text: "a" }, { type: "image_url" }, "b"]), "a\nb");
  assert.equal(messageText(null), "");
  const rows = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello", timestamp: 1 },
    { role: "assistant", content: "", tool_calls: [{ id: "t" }] },
    { role: "tool", content: "result", tool_call_id: "t" },
    { role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: 2 },
    null,
  ];
  assert.deepEqual(transcriptMessages(rows), [
    { role: "user", text: "hello", timestamp: 1 },
    { role: "assistant", text: "hi there", timestamp: 2 },
  ]);
  assert.deepEqual(transcriptMessages(undefined), []);
});

test("picker helpers: label, age, filtering and ordering", () => {
  assert.equal(sessionLabel({ id: "i", title: "  T  " }), "T");
  assert.equal(sessionLabel({ id: "i", preview: "line one\nline two" }), "line one line two");
  assert.equal(sessionLabel({ id: "i" }), "i");
  const now = 1_000_000 * 1000;
  assert.equal(relativeAge(1_000_000 - 10, now), "now");
  assert.equal(relativeAge(1_000_000 - 300, now), "5m");
  assert.equal(relativeAge(1_000_000 - 7200, now), "2h");
  assert.equal(relativeAge(1_000_000 - 86400 * 3, now), "3d");
  assert.match(relativeAge(1_000_000 - 86400 * 60, now), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(relativeAge(null, now), "");
  const rows = [
    { id: "old", lastActive: 1, title: "Old" },
    { id: "new", lastActive: 9, model: "claude-x" },
    { id: "pin", lastActive: 2, pinned: true },
    { id: "arch", lastActive: 10, archived: true },
  ];
  assert.deepEqual(filterSessions(rows).map(s => s.id), ["pin", "new", "old"]);
  assert.deepEqual(filterSessions(rows, { archived: true }).map(s => s.id), ["pin", "arch", "new", "old"]);
  assert.deepEqual(filterSessions(rows, { query: "CLAUDE" }).map(s => s.id), ["new"]);
  assert.deepEqual(filterSessions(rows, { query: "old" }).map(s => s.id), ["old"]);
  assert.equal(filterSessions(rows, { local: ["new"] }).find(s => s.id === "new").local, true);
  assert.deepEqual(withSession(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(withSession(undefined, "z"), ["z"]);
});

test("transcriptToChat maps roles and notes the source", () => {
  const out = transcriptToChat("s1", [{ role: "user", text: "q" }, { role: "assistant", text: "a" }, { role: "tool", text: "x" }], { hasMore: true, nextOffset: 7, oldestId: 40 });
  assert.equal(out[0].who, "system");
  assert.match(out[0].text, /s1.*2 messages.*scroll up for older/);
  assert.deepEqual(out[0].resume, { session: "s1", nextOffset: 7, hasMore: true, loaded: 2, beforeId: 40 });
  assert.deepEqual(out.slice(1), [{ who: "user", text: "q" }, { who: "hermes", text: "a" }]);
  assert.match(transcriptToChat("s2", [])[0].text, /no messages yet/);
  assert.equal(olderCursor(transcriptToChat("s3", [{ role: "user", text: "q" }])), null, "no cursor without hasMore");
});

test("prependOlder inserts the older page after the note and advances the cursor", () => {
  const chat = transcriptToChat("s", [{ role: "user", text: "new q", id: 50 }, { role: "assistant", text: "new a", id: 51 }],
    { hasMore: true, nextOffset: 2, oldestId: 50 });
  const page = { messages: [{ role: "user", text: "old q", id: 30 }, { role: "assistant", text: "old a", id: 31 },
    { role: "user", text: "dup (shifted offset)", id: 50 }], nextOffset: 4, hasMore: true, oldestId: 30 };
  const next = prependOlder(chat, page);
  assert.deepEqual(next.slice(1).map(m => m.text), ["old q", "old a", "new q", "new a"], "already-shown ids are dropped");
  assert.deepEqual(olderCursor(next), { session: "s", nextOffset: 4, hasMore: true, loaded: 4, beforeId: 30 });
  assert.match(next[0].text, /4 messages.*scroll up/);
  const last = prependOlder(next, { messages: [{ role: "user", text: "first", id: 1 }], nextOffset: 5, hasMore: false, oldestId: 1 });
  assert.equal(olderCursor(last), null, "cursor cleared on the last page");
  assert.equal(last[0].resume, undefined);
  assert.deepEqual(last.slice(1, 3).map(m => m.text), ["first", "old q"]);
  // A page that doesn't advance the offset ends paging (no infinite loop).
  assert.equal(olderCursor(prependOlder(chat, { messages: [], nextOffset: 2, hasMore: true })), null);
  // No cursor: unchanged.
  const plain = [{ who: "hermes", text: "hi" }];
  assert.equal(prependOlder(plain, page), plain);
});

function fakeAgent() {
  const calls = [];
  const sessions = [
    { id: "recent", title: "Recent", last_active: 50, message_count: 3, system_prompt: "do not leak", model_config: "{}" },
    { id: "bad id", title: "dropped" },
    { id: "older", preview: "older chat", last_active: 10, message_count: 1 },
  ];
  const srv = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: "nope" } });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/sessions") {
      const limit = Number(u.searchParams.get("limit")), offset = Number(u.searchParams.get("offset"));
      const page = sessions.slice(offset, offset + limit);
      return json(200, { object: "list", data: page, limit, offset, has_more: offset + limit < sessions.length });
    }
    const m = u.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (id === "missing") return json(404, { error: { message: "Session not found: missing", code: "session_not_found" } });
      if (id === "long") {
        // 10 rows (ids 1..10), paged back from the newest like order=latest.
        const all = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, role: i % 2 ? "assistant" : "user", content: `m${i + 1}` }));
        const limit = Number(u.searchParams.get("limit")), offset = Number(u.searchParams.get("offset") || 0);
        const page = all.slice().reverse().slice(offset, offset + limit).reverse();
        return json(200, { object: "list", session_id: id, data: page, pagination: { limit, offset, order: "latest", returned: page.length } });
      }
      return json(200, { object: "list", session_id: id, data: [
        { role: "user", content: "build it" }, { role: "assistant", content: "", tool_calls: [{}] },
        { role: "tool", content: "ok" }, { role: "assistant", content: "done" }] });
    }
    json(404, { error: "not found" });
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

test("listAgentSessions / agentSessionMessages against a fake agent", async () => {
  const a = await fakeAgent();
  try {
    const cfg = { url: a.url, key: KEY };
    const list = await listAgentSessions(cfg, { limit: 2, offset: 0 });
    assert.equal(list.ok, true);
    assert.deepEqual(list.sessions.map(s => s.id), ["recent"], "invalid ids are dropped");
    assert.equal(list.hasMore, true);
    assert.ok(!JSON.stringify(list).includes("do not leak"));
    assert.ok(a.calls.some(c => c.url === "/api/sessions?limit=2&offset=0"));
    // Limits are clamped before they reach the agent.
    await listAgentSessions(cfg, { limit: "9999", offset: "-4" });
    assert.ok(a.calls.some(c => c.url === "/api/sessions?limit=200&offset=0"));
    const msgs = await agentSessionMessages(cfg, "recent");
    assert.deepEqual(msgs, { ok: true, status: 200, session: "recent",
      messages: [{ role: "user", text: "build it", timestamp: null }, { role: "assistant", text: "done", timestamp: null }],
      offset: 0, nextOffset: 4, hasMore: false, oldestId: null });
    assert.ok(a.calls.some(c => c.url === "/api/sessions/recent/messages?limit=200&offset=0&order=latest"));
    // Offset paging walks back from the newest; ids ride along for dedup.
    const p1 = await agentSessionMessages(cfg, "long", { limit: 4 });
    assert.deepEqual(p1.messages.map(m => m.text), ["m7", "m8", "m9", "m10"]);
    assert.deepEqual([p1.nextOffset, p1.hasMore, p1.oldestId, p1.messages[0].id], [4, true, 7, 7]);
    const p3 = await agentSessionMessages(cfg, "long", { limit: 4, offset: 8 });
    assert.deepEqual(p3.messages.map(m => m.text), ["m1", "m2"]);
    assert.deepEqual([p3.nextOffset, p3.hasMore], [10, false]);
    let chat = transcriptToChat("long", p1.messages, p1);
    while (olderCursor(chat)) chat = prependOlder(chat, await agentSessionMessages(cfg, "long", { limit: 4, offset: olderCursor(chat).nextOffset }));
    assert.deepEqual(chat.slice(1).map(m => m.text), Array.from({ length: 10 }, (_, i) => `m${i + 1}`), "paging assembles the full transcript in order");
    await agentSessionMessages(cfg, "long", { limit: 4, offset: "-3" });
    assert.ok(a.calls.some(c => c.url === "/api/sessions/long/messages?limit=4&offset=0&order=latest"), "negative offsets are clamped");
    const missing = await agentSessionMessages(cfg, "missing");
    assert.deepEqual(missing, { ok: false, status: 404, code: "not_found", error: "Session not found: missing" });
    const unauth = await listAgentSessions({ url: a.url, key: "wrong" });
    assert.equal(unauth.code, "unauthorized");
    const down = await listAgentSessions({ url: "http://127.0.0.1:1", key: KEY });
    assert.equal(down.code, "agent_unreachable");
  } finally { a.srv.close(); }
});

test("bridge GET /api/agent/sessions[/:id/messages] proxies with the key and validates ids", async () => {
  const a = await fakeAgent();
  const PORT = 4787, TOKEN = "sesstok";
  const bridge = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DEVTONIC_PORT: String(PORT), DEVTONIC_TOKEN: TOKEN,
    DEVTONIC_AGENT_URL: a.url, DEVTONIC_AGENT_KEY: KEY, DEVTONIC_AGENT_API: "" } });
  try {
    await new Promise((res, rej) => { bridge.stdout.on("data", d => String(d).includes("running") && res()); bridge.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
    const base = `http://127.0.0.1:${PORT}/api/agent/sessions`;
    const h = { "x-devtonic-token": TOKEN };
    assert.equal((await fetch(base)).status, 401);
    const r = await fetch(`${base}?limit=10`, { headers: h });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!text.includes(KEY), "response must not leak the agent key");
    assert.deepEqual(JSON.parse(text).sessions.map(s => s.id), ["recent", "older"]);
    assert.ok(a.calls.every(c => c.auth === `Bearer ${KEY}`));
    const m = await fetch(`${base}/recent/messages`, { headers: h });
    assert.equal(m.status, 200);
    assert.equal((await m.json()).messages.length, 2);
    const older = await (await fetch(`${base}/long/messages?limit=3&offset=3`, { headers: h })).json();
    assert.deepEqual(older.messages.map(x => x.text), ["m5", "m6", "m7"]);
    assert.deepEqual([older.nextOffset, older.hasMore], [6, true]);
    assert.equal((await fetch(`${base}/bad%20id/messages`, { headers: h })).status, 400);
    assert.equal((await fetch(`${base}/missing/messages`, { headers: h })).status, 404);
  } finally { bridge.kill(); a.srv.close(); }
});
