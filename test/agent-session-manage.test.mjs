import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { sessionUpdateBody, forkBody, updateAgentSession, deleteAgentSession, forkAgentSession } from "../server/agent-api.mjs";
import { replaceSession, dropSession, afterSessionDelete, cleanTitle } from "../src/platform/agent-sessions.js";

const KEY = "manage-agent-key";

test("sessionUpdateBody forwards only title/pinned/archived", () => {
  assert.deepEqual(sessionUpdateBody({ title: "  New name " }), { body: { title: "New name" } });
  assert.deepEqual(sessionUpdateBody({ title: null }), { body: { title: "" } }, "null clears the title");
  assert.deepEqual(sessionUpdateBody({ pinned: true, archived: false }), { body: { pinned: true, archived: false } });
  assert.match(sessionUpdateBody({ pinned: "yes" }).error, /pinned must be a boolean/);
  assert.match(sessionUpdateBody({ title: "a\nb" }).error, /single-line/);
  assert.match(sessionUpdateBody({ title: "x".repeat(201) }).error, /200/);
  assert.match(sessionUpdateBody({ hidden: true }).error, /unsupported fields: hidden/, "agent-only flags are not reachable");
  assert.match(sessionUpdateBody({}).error, /nothing to update/);
  assert.match(sessionUpdateBody([]).error, /JSON object/);
  assert.match(sessionUpdateBody(null).error, /JSON object/);
});

test("forkBody validates the optional id and title", () => {
  assert.deepEqual(forkBody(undefined), { body: {} });
  assert.deepEqual(forkBody({ id: "child-1", title: " t " }), { body: { id: "child-1", title: "t" } });
  assert.match(forkBody({ id: "bad id" }).error, /invalid fork session id/);
  assert.match(forkBody({ title: "a\u0000" }).error, /single-line/);
  assert.match(forkBody("x").error, /JSON object/);
});

test("picker row and project-list helpers", () => {
  const rows = [{ id: "a", title: "A", pinned: false }, { id: "b", title: "B" }];
  assert.deepEqual(replaceSession(rows, { id: "a", pinned: true }), [{ id: "a", title: "A", pinned: true }, { id: "b", title: "B" }]);
  assert.equal(replaceSession(rows, null), rows);
  assert.deepEqual(dropSession(rows, "a").map(r => r.id), ["b"]);
  // Deleting a non-active session keeps the active one.
  assert.deepEqual(afterSessionDelete(["a", "b", "c"], "b", "a", "p-main"), { sessions: ["a", "c"], active: "a", changed: true });
  // Deleting the active session moves to the next in the list.
  assert.deepEqual(afterSessionDelete(["a", "b"], "a", "a", "p-main"), { sessions: ["b"], active: "b", changed: true });
  // The list is never left empty.
  assert.deepEqual(afterSessionDelete(["x"], "x", "x", "p-main"), { sessions: ["p-main"], active: "p-main", changed: true });
  assert.deepEqual(afterSessionDelete(["p-main"], "p-main", "p-main", "p-main").sessions, ["p-main-new"]);
  // A session that isn't in this project changes nothing.
  assert.deepEqual(afterSessionDelete(["a"], "zzz", "a", "p-main"), { sessions: ["a"], active: "a", changed: false });
  assert.equal(cleanTitle("  two\nlines "), "two lines");
  assert.equal(cleanTitle("y".repeat(300)).length, 200);
});

function fakeAgent() {
  const calls = [];
  const db = new Map([
    ["s1", { id: "s1", title: "One", pinned: false, archived: false, last_active: 5, message_count: 2, system_prompt: "secret prompt" }],
    ["busy", { id: "busy", title: "Busy" }],
  ]);
  const srv = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: "nope" } });
    const m = req.url.match(/^\/api\/sessions\/([^/]+)(\/fork)?$/);
    if (!m) return json(404, { error: "no route" });
    const id = decodeURIComponent(m[1]);
    const s = db.get(id);
    if (!s) return json(404, { error: { message: `Session not found: ${id}`, code: "session_not_found" } });
    const body = raw ? JSON.parse(raw) : {};
    if (m[2] && req.method === "POST") {
      const forkId = body.id || `${id}-fork`;
      if (db.has(forkId)) return json(409, { error: { message: `Session already exists: ${forkId}`, code: "session_exists" } });
      const fork = { id: forkId, title: body.title || `${s.title} fork`, parent_session_id: id, message_count: s.message_count, system_prompt: "secret prompt" };
      db.set(forkId, fork);
      return json(201, { object: "hermes.session", session: fork });
    }
    if (req.method === "PATCH") {
      Object.assign(s, body);
      return json(200, { object: "hermes.session", session: s });
    }
    if (req.method === "DELETE") {
      if (id === "busy") return json(409, { error: { message: "session has an active turn", code: "session_active_turn" } });
      db.delete(id);
      return json(200, { object: "hermes.session.deleted", id, deleted: true });
    }
    json(405, { error: "method not allowed" });
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, calls, db, url: `http://127.0.0.1:${srv.address().port}` })));
}

test("update / delete / fork against a fake agent", async () => {
  const a = await fakeAgent();
  try {
    const cfg = { url: a.url, key: KEY };
    const up = await updateAgentSession(cfg, "s1", { title: "Renamed", pinned: true });
    assert.equal(up.ok, true);
    assert.equal(up.session.title, "Renamed");
    assert.equal(up.session.pinned, true);
    assert.ok(!JSON.stringify(up).includes("secret prompt"), "only picker fields come back");
    const patchCall = a.calls.find(c => c.method === "PATCH");
    assert.equal(patchCall.url, "/api/sessions/s1");
    assert.deepEqual(patchCall.body, { title: "Renamed", pinned: true });

    const fork = await forkAgentSession(cfg, "s1", {});
    assert.deepEqual({ ok: fork.ok, id: fork.session.id, parent: fork.parent, title: fork.session.title },
      { ok: true, id: "s1-fork", parent: "s1", title: "Renamed fork" });
    const dup = await forkAgentSession(cfg, "s1", { id: "s1-fork" });
    assert.deepEqual({ ok: dup.ok, status: dup.status, code: dup.code }, { ok: false, status: 409, code: "session_exists" });

    assert.deepEqual(await deleteAgentSession(cfg, "s1"), { ok: true, status: 200, id: "s1", deleted: true });
    assert.equal(a.db.has("s1"), false);
    const busy = await deleteAgentSession(cfg, "busy");
    assert.deepEqual({ status: busy.status, code: busy.code }, { status: 409, code: "session_active_turn" });
    const gone = await updateAgentSession(cfg, "s1", { pinned: false });
    assert.deepEqual({ status: gone.status, code: gone.code }, { status: 404, code: "not_found" });
    assert.equal((await deleteAgentSession({ url: a.url, key: "wrong" }, "busy")).code, "unauthorized");
    assert.equal((await forkAgentSession({ url: "http://127.0.0.1:1", key: KEY }, "busy")).code, "agent_unreachable");
  } finally { a.srv.close(); }
});

test("bridge PATCH/DELETE /api/agent/sessions/:id and POST .../fork", async () => {
  const a = await fakeAgent();
  const PORT = 4788, TOKEN = "managetok";
  const bridge = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DEVTONIC_PORT: String(PORT), DEVTONIC_TOKEN: TOKEN,
    DEVTONIC_AGENT_URL: a.url, DEVTONIC_AGENT_KEY: KEY, DEVTONIC_AGENT_API: "" } });
  try {
    await new Promise((res, rej) => { bridge.stdout.on("data", d => String(d).includes("running") && res()); bridge.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
    const base = `http://127.0.0.1:${PORT}/api/agent/sessions`;
    const h = { "x-devtonic-token": TOKEN, "content-type": "application/json" };
    const req = (method, path, body) => fetch(`${base}${path}`, { method, headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    assert.equal((await fetch(`${base}/s1`, { method: "DELETE" })).status, 401, "token required");
    const r = await req("PATCH", "/s1", { archived: true });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!text.includes(KEY) && !text.includes("secret prompt"));
    assert.equal(JSON.parse(text).session.archived, true);
    assert.equal((await req("PATCH", "/s1", { hidden: true })).status, 400, "unsupported field rejected before the agent");
    assert.equal((await req("PATCH", "/bad%20id", { pinned: true })).status, 400);
    const callsBefore = a.calls.length;
    assert.equal((await req("PATCH", "/s1", "not-an-object")).status, 400);
    assert.equal(a.calls.length, callsBefore, "invalid bodies never reach the agent");

    const f = await req("POST", "/s1/fork");
    assert.equal(f.status, 200);
    assert.equal((await f.json()).session.id, "s1-fork");
    assert.equal((await req("POST", "/s1/fork", { id: "bad id" })).status, 400);

    const d = await req("DELETE", "/s1-fork");
    assert.deepEqual(await d.json(), { ok: true, id: "s1-fork", deleted: true });
    assert.equal((await req("DELETE", "/s1-fork")).status, 404);
    assert.equal((await req("DELETE", "/busy")).status, 409);
    assert.ok(a.calls.every(c => c.auth === `Bearer ${KEY}`));
  } finally { bridge.kill(); a.srv.close(); }
});
