// Bridge proxy for the agent's HTTP API (Hermes / devtonic-agent api_server).
//
// The Chat panel prefers a structured streaming turn over this API instead of
// spawning the CLI and tailing ~/.hermes/logs/agent.log. The agent's API key
// never reaches the browser: the bridge reads it from the environment or the
// agent's .env and adds the bearer header itself. Everything here is pure or
// takes an injected fetch, so it is tested against a fake agent server.
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_AGENT_PORT = 8642;
const SESSION_ID_RE = /^[A-Za-z0-9._:@-]{1,200}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** Minimal KEY=VALUE parser for the agent's .env (export prefix and quotes allowed). */
export function parseDotenv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/**
 * Where the agent API lives and how to authenticate.
 * URL: DEVTONIC_AGENT_URL, else http://127.0.0.1:<API_SERVER_PORT|8642>.
 * Key: DEVTONIC_AGENT_KEY, else API_SERVER_KEY from the environment, else from
 * $HERMES_HOME/.env (default ~/.hermes/.env). DEVTONIC_AGENT_API=0 disables it.
 */
export function agentConfig(env = process.env, { home = os.homedir(), readFile = p => fs.readFileSync(p, "utf8") } = {}) {
  const disabled = /^(0|false|off|no)$/i.test(env.DEVTONIC_AGENT_API || "");
  const hermesHome = env.HERMES_HOME || path.join(home, ".hermes");
  let dotenv = {};
  try { dotenv = parseDotenv(readFile(path.join(hermesHome, ".env"))); } catch {}
  const port = env.API_SERVER_PORT || dotenv.API_SERVER_PORT || DEFAULT_AGENT_PORT;
  const url = (env.DEVTONIC_AGENT_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  let key = "", keySource = "none";
  if (env.DEVTONIC_AGENT_KEY) { key = env.DEVTONIC_AGENT_KEY; keySource = "DEVTONIC_AGENT_KEY"; }
  else if (env.API_SERVER_KEY) { key = env.API_SERVER_KEY; keySource = "env"; }
  else if (dotenv.API_SERVER_KEY) { key = dotenv.API_SERVER_KEY; keySource = "dotenv"; }
  return { url, key, keySource, disabled, envFile: path.join(hermesHome, ".env") };
}

/** Set KEY=VALUE in .env text, keeping every other line; appends when absent. */
export function upsertDotenv(text, key, value) {
  const src = String(text || "");
  if (!src.trim()) return `${key}=${value}\n`;
  let found = false;
  const lines = src.split("\n").map(line => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[2] === key) { found = true; return `${m[1]}${key}=${value}`; }
    return line;
  });
  if (!found) {
    if (lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${value}`, "");
  }
  return lines.join("\n");
}

/**
 * Turn the agent API on by generating a strong API_SERVER_KEY (64 hex chars;
 * the agent's api_server needs >= 16) into the agent's .env. Only when no key
 * is configured anywhere, so an existing key is never overwritten. The key is
 * not returned: the bridge reads it back from the .env on every request.
 * Returns {ok, file, restart} or {ok:false, code, error}.
 */
export function enableAgentApi(cfg, { fsImpl = fs, randomBytes = crypto.randomBytes } = {}) {
  if (cfg.disabled) return { ok: false, code: "disabled", error: "DEVTONIC_AGENT_API is off" };
  if (cfg.key) return { ok: false, code: "has-key", error: `an agent API key is already configured (${cfg.keySource})` };
  let existing = "";
  try { existing = fsImpl.readFileSync(cfg.envFile, "utf8"); }
  catch (e) { if (e.code !== "ENOENT") return { ok: false, code: "io", error: e.message }; }
  if (parseDotenv(existing).API_SERVER_KEY) return { ok: false, code: "has-key", error: "API_SERVER_KEY is already set in the agent's .env" };
  const key = randomBytes(32).toString("hex");
  try {
    fsImpl.mkdirSync(path.dirname(cfg.envFile), { recursive: true });
    fsImpl.writeFileSync(cfg.envFile, upsertDotenv(existing, "API_SERVER_KEY", key), { mode: 0o600 });
    try { fsImpl.chmodSync(cfg.envFile, 0o600); } catch {}
  } catch (e) {
    return { ok: false, code: "io", error: e.message };
  }
  // A gateway that is already running read its .env at startup.
  return { ok: true, file: cfg.envFile, restart: true };
}

// argv for the CLI's gateway lifecycle command (no shell).
export const GATEWAY_RESTART_ARGS = ["gateway", "restart"];
const tail = (s, n = 2000) => { const t = String(s || "").trim(); return t.length > n ? `…${t.slice(-n)}` : t; };

/**
 * Restart the agent's gateway through its CLI so a running gateway re-reads
 * its .env (e.g. right after enableAgentApi wrote API_SERVER_KEY). Uses the
 * CLI the bridge resolved (resolveHermes) via execFile, never a shell.
 * Resolves {ok, output} or
 * {ok:false, code: "disabled" | "no-hermes" | "timeout" | "failed", error, output?}.
 */
export function restartAgentGateway(cfg, { hermes, execFileImpl = execFile, timeoutMs = 60000 } = {}) {
  if (cfg.disabled) return Promise.resolve({ ok: false, code: "disabled", error: "DEVTONIC_AGENT_API is off" });
  if (!hermes || !hermes.found) return Promise.resolve({ ok: false, code: "no-hermes",
    error: hermes?.source === "env" ? `DEVTONIC_HERMES=${hermes.path} is not an executable file` : "hermes CLI not found; run the restart yourself" });
  return new Promise(resolve => {
    execFileImpl(hermes.path, GATEWAY_RESTART_ARGS, { timeout: timeoutMs, maxBuffer: 1e6, windowsHide: true }, (err, stdout, stderr) => {
      const output = tail(`${stdout || ""}${stderr ? `\n${stderr}` : ""}`);
      if (!err) return resolve({ ok: true, output });
      if (err.killed) return resolve({ ok: false, code: "timeout", error: `restart timed out after ${Math.round(timeoutMs / 1000)}s`, output });
      resolve({ ok: false, code: "failed", error: tail(stderr, 300) || err.message, output });
    });
  });
}

const authHeaders = cfg => (cfg.key ? { authorization: `Bearer ${cfg.key}` } : {});

async function fetchWithTimeout(fetchImpl, url, opts = {}, ms = 2000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetchImpl(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

/**
 * Probe the agent API. Never throws. `available` means a streaming session
 * turn can be started right now (reachable, authorised, endpoint advertised).
 */
export async function agentStatus(cfg, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const base = { url: cfg.url, keySource: cfg.keySource, available: false };
  if (cfg.disabled) return { ...base, reason: "disabled", detail: "DEVTONIC_AGENT_API is off" };
  let health;
  try {
    const r = await fetchWithTimeout(fetchImpl, `${cfg.url}/health`, {}, timeoutMs);
    if (!r.ok) return { ...base, reason: "unreachable", detail: `GET /health returned ${r.status}` };
    health = await r.json().catch(() => ({}));
  } catch (e) {
    return { ...base, reason: "unreachable", detail: e.name === "AbortError" ? "timed out" : e.message };
  }
  if (!cfg.key) return { ...base, version: health.version, reason: "no-key", detail: "API_SERVER_KEY not set" };
  try {
    const r = await fetchWithTimeout(fetchImpl, `${cfg.url}/v1/capabilities`, { headers: authHeaders(cfg) }, timeoutMs);
    if (r.status === 401 || r.status === 403) return { ...base, version: health.version, reason: "unauthorized", detail: "API key rejected" };
    if (!r.ok) return { ...base, version: health.version, reason: "unsupported", detail: `GET /v1/capabilities returned ${r.status}` };
    const caps = await r.json().catch(() => ({}));
    const f = caps.features || {};
    if (f.session_chat_streaming === false) return { ...base, version: health.version, reason: "unsupported", detail: "agent has no session chat streaming" };
    return { ...base, available: true, version: health.version, reason: "ok",
      approvals: f.run_approval !== false, stop: f.run_stop !== false,
      // Opt-in: older agents have no POST /api/sessions/{id}/model.
      modelLock: f.session_model_lock === true };
  } catch (e) {
    return { ...base, version: health.version, reason: "unreachable", detail: e.message };
  }
}

/** Create the agent session if it doesn't exist yet. Returns {ok, created} or {ok:false, status, error}. */
export async function ensureSession(cfg, sessionId, { fetchImpl = fetch } = {}) {
  const h = { ...authHeaders(cfg), "content-type": "application/json" };
  const id = encodeURIComponent(sessionId);
  const got = await fetchImpl(`${cfg.url}/api/sessions/${id}`, { headers: h });
  if (got.ok) return { ok: true, created: false };
  if (got.status !== 404) return { ok: false, status: got.status, error: await errorText(got) };
  const made = await fetchImpl(`${cfg.url}/api/sessions`, { method: "POST", headers: h, body: JSON.stringify({ id: sessionId }) });
  if (made.ok || made.status === 409) return { ok: true, created: made.ok };
  return { ok: false, status: made.status, error: await errorText(made) };
}

async function errorText(r) {
  const t = await r.text().catch(() => "");
  try { const j = JSON.parse(t); return j?.error?.message || j?.error || t; } catch { return t || `HTTP ${r.status}`; }
}

/** Validate and shape the browser's chat request into the agent's body. */
export function chatRequestBody(input) {
  if (!input || typeof input !== "object") return { error: "body must be a JSON object" };
  const { session, message, instructions, model, provider } = input;
  if (typeof session !== "string" || !SESSION_ID_RE.test(session)) return { error: "invalid session id" };
  if (typeof message !== "string" || !message.trim()) return { error: "message is required" };
  const body = { message };
  if (typeof instructions === "string" && instructions.trim()) body.system_message = instructions;
  if (typeof model === "string" && model) body.model = model;
  if (typeof provider === "string" && provider) body.provider = provider;
  return { session, body };
}

const MODEL_ID_RE = /^[^\s\u0000-\u001f]{1,200}$/;

/**
 * Validate the browser's model-pin request into the agent's
 * POST /api/sessions/{id}/model body ({model, provider?}).
 */
export function modelPinBody(input) {
  if (!input || typeof input !== "object") return { error: "body must be a JSON object" };
  const { model, provider } = input;
  if (typeof model !== "string" || !MODEL_ID_RE.test(model)) return { error: "invalid model id" };
  const body = { model };
  if (provider != null && provider !== "") {
    if (typeof provider !== "string" || provider.length > 80 || !MODEL_ID_RE.test(provider)) return { error: "invalid provider id" };
    body.provider = provider;
  }
  return { body };
}

/**
 * Pin a session's model on the agent (creating the session first if needed).
 * Resolves {ok, status, runtime} or {ok:false, status, code, error}; `code` is
 * "unsupported" for an agent without the endpoint (404/405).
 */
export async function pinSessionModel(cfg, sessionId, body, { fetchImpl = fetch } = {}) {
  const unreachable = e => ({ ok: false, status: 502, code: "agent_unreachable", error: `agent API unreachable: ${e.message}` });
  let ensured;
  try { ensured = await ensureSession(cfg, sessionId, { fetchImpl }); }
  catch (e) { return unreachable(e); }
  if (!ensured.ok) return { ok: false, status: 502, code: "agent_error", error: `agent session: ${ensured.error}` };
  let r;
  try {
    r = await fetchImpl(`${cfg.url}/api/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: "POST", headers: { ...authHeaders(cfg), "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { return unreachable(e); }
  const text = await r.text().catch(() => "");
  let j = {};
  try { j = JSON.parse(text) || {}; } catch {}
  if (r.ok) return { ok: true, status: 200, runtime: j.runtime || null };
  const err = typeof j.error === "object" && j.error ? j.error : { message: j.error };
  const code = r.status === 404 || r.status === 405 ? "unsupported" : err.code || j.code || "agent_error";
  const error = String(err.message || text || `HTTP ${r.status}`).slice(0, 500);
  return { ok: false, status: r.status >= 500 ? 502 : r.status, code, error };
}

const clampInt = (v, def, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};
const str = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : "");
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Reduce one agent session row (GET /api/sessions) to what the session
 * picker shows. Rows whose id can't be used with the chat route are dropped
 * (returns null); child sessions and hidden rows are left out by the agent.
 */
export function sessionSummary(s) {
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !SESSION_ID_RE.test(s.id)) return null;
  return {
    id: s.id,
    title: str(s.title),
    preview: str(s.preview, 160),
    source: str(s.source, 40),
    model: str(s.model),
    startedAt: num(s.started_at),
    lastActive: num(s.last_active) ?? num(s.started_at),
    messageCount: num(s.message_count) ?? 0,
    pinned: !!s.pinned,
    archived: !!s.archived,
  };
}

/** Flatten an agent message's content (string or OpenAI-style parts) to text. */
export function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  }
  return "";
}

/**
 * Keep only the conversational turns of a transcript (GET
 * /api/sessions/{id}/messages): user messages and assistant replies with
 * text. Tool calls/results and system rows are dropped.
 */
export function transcriptMessages(rows) {
  const out = [];
  for (const m of Array.isArray(rows) ? rows : []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const text = messageText(m.content).trim();
    if (!text) continue;
    out.push({ role: m.role, text, timestamp: num(m.timestamp) });
  }
  return out;
}

async function agentGetJson(cfg, pathAndQuery, { fetchImpl = fetch } = {}) {
  let r;
  try { r = await fetchImpl(`${cfg.url}${pathAndQuery}`, { headers: authHeaders(cfg) }); }
  catch (e) { return { ok: false, status: 502, code: "agent_unreachable", error: `agent API unreachable: ${e.message}` }; }
  if (!r.ok) {
    const error = String(await errorText(r)).slice(0, 500);
    const code = r.status === 404 ? "not_found" : r.status === 401 || r.status === 403 ? "unauthorized" : "agent_error";
    return { ok: false, status: r.status >= 500 ? 502 : r.status, code, error };
  }
  const json = await r.json().catch(() => null);
  if (!json || typeof json !== "object") return { ok: false, status: 502, code: "agent_error", error: "agent returned invalid JSON" };
  return { ok: true, json };
}

/**
 * List the agent's sessions, most recently active first.
 * Resolves {ok, status, sessions, hasMore, offset} or {ok:false, status, code, error}.
 */
export async function listAgentSessions(cfg, { limit = 50, offset = 0 } = {}, { fetchImpl = fetch } = {}) {
  const lim = clampInt(limit, 50, 1, 200), off = clampInt(offset, 0, 0, 1_000_000);
  const r = await agentGetJson(cfg, `/api/sessions?limit=${lim}&offset=${off}`, { fetchImpl });
  if (!r.ok) return r;
  const rows = Array.isArray(r.json.data) ? r.json.data : [];
  return { ok: true, status: 200, sessions: rows.map(sessionSummary).filter(Boolean), hasMore: !!r.json.has_more, offset: off };
}

/**
 * The latest `limit` conversational messages of a session, oldest first.
 * Resolves {ok, status, session, messages} or {ok:false, status, code, error}.
 */
export async function agentSessionMessages(cfg, sessionId, { limit = 200 } = {}, { fetchImpl = fetch } = {}) {
  const lim = clampInt(limit, 200, 1, 500);
  const r = await agentGetJson(cfg, `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${lim}&order=latest`, { fetchImpl });
  if (!r.ok) return r;
  return { ok: true, status: 200, session: sessionId, messages: transcriptMessages(r.json.data) };
}

const TITLE_MAX = 200;
const validTitle = t => typeof t === "string" && t.length <= TITLE_MAX && !/[\u0000-\u001f]/.test(t);

/**
 * Validate the browser's session update into the agent's PATCH
 * /api/sessions/{id} body. Only client-safe metadata is forwarded:
 * `title` (string, "" or null clears it), `pinned`, `archived` (booleans).
 */
export function sessionUpdateBody(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "body must be a JSON object" };
  const body = {};
  if ("title" in input) {
    if (input.title !== null && !validTitle(input.title)) return { error: `title must be a single-line string of at most ${TITLE_MAX} chars` };
    body.title = input.title === null ? "" : input.title.trim();
  }
  for (const flag of ["pinned", "archived"]) {
    if (!(flag in input)) continue;
    if (typeof input[flag] !== "boolean") return { error: `${flag} must be a boolean` };
    body[flag] = input[flag];
  }
  const unknown = Object.keys(input).filter(k => !["title", "pinned", "archived"].includes(k));
  if (unknown.length) return { error: `unsupported fields: ${unknown.join(", ")}` };
  if (!Object.keys(body).length) return { error: "nothing to update" };
  return { body };
}

/** Validate a fork request ({id?, title?}) into the agent's POST /api/sessions/{id}/fork body. */
export function forkBody(input) {
  if (input == null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { error: "body must be a JSON object" };
  const body = {};
  if (input.id != null && input.id !== "") {
    if (typeof input.id !== "string" || !SESSION_ID_RE.test(input.id)) return { error: "invalid fork session id" };
    body.id = input.id;
  }
  if (input.title != null && input.title !== "") {
    if (!validTitle(input.title)) return { error: `title must be a single-line string of at most ${TITLE_MAX} chars` };
    body.title = input.title.trim();
  }
  return { body };
}

/** Send a JSON request to the agent and map errors the same way as agentGetJson. */
async function agentSendJson(cfg, method, pathName, body, { fetchImpl = fetch } = {}) {
  let r;
  try {
    r = await fetchImpl(`${cfg.url}${pathName}`, { method,
      headers: { ...authHeaders(cfg), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (e) { return { ok: false, status: 502, code: "agent_unreachable", error: `agent API unreachable: ${e.message}` }; }
  const text = await r.text().catch(() => "");
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!r.ok) {
    const err = j && typeof j.error === "object" && j.error ? j.error : { message: j?.error };
    const code = r.status === 404 ? "not_found" : r.status === 401 || r.status === 403 ? "unauthorized"
      : r.status === 405 ? "unsupported" : err.code || j?.code || "agent_error";
    return { ok: false, status: r.status >= 500 ? 502 : r.status, code, error: String(err.message || text || `HTTP ${r.status}`).slice(0, 500) };
  }
  if (!j || typeof j !== "object") return { ok: false, status: 502, code: "agent_error", error: "agent returned invalid JSON" };
  return { ok: true, json: j };
}

/**
 * Rename / pin / archive an agent session (PATCH /api/sessions/{id}).
 * Resolves {ok, status, session} (picker summary) or {ok:false, status, code, error}.
 */
export async function updateAgentSession(cfg, sessionId, body, { fetchImpl = fetch } = {}) {
  const r = await agentSendJson(cfg, "PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, body, { fetchImpl });
  if (!r.ok) return r;
  return { ok: true, status: 200, session: sessionSummary(r.json.session) };
}

/** Delete an agent session (DELETE /api/sessions/{id}). Resolves {ok, status, id, deleted}. */
export async function deleteAgentSession(cfg, sessionId, { fetchImpl = fetch } = {}) {
  const r = await agentSendJson(cfg, "DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`, null, { fetchImpl });
  if (!r.ok) return r;
  return { ok: true, status: 200, id: sessionId, deleted: r.json.deleted !== false };
}

/**
 * Fork (branch) an agent session (POST /api/sessions/{id}/fork): the agent
 * copies the transcript into a new session and ends the source as "branched".
 * Resolves {ok, status, session, parent} or {ok:false, status, code, error}.
 */
export async function forkAgentSession(cfg, sessionId, body = {}, { fetchImpl = fetch } = {}) {
  const r = await agentSendJson(cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/fork`, body, { fetchImpl });
  if (!r.ok) return r;
  const session = sessionSummary(r.json.session);
  if (!session) return { ok: false, status: 502, code: "agent_error", error: "agent returned an unusable fork id" };
  return { ok: true, status: 200, session, parent: sessionId };
}

const sendJson = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

/**
 * Handle /api/agent/* on the bridge. Returns false when the path isn't ours.
 *   GET  /api/agent/status
 *   POST /api/agent/chat                 {session, message, instructions?, model?, provider?} -> SSE passthrough
 *   POST /api/agent/runs/:id/stop
 *   POST /api/agent/runs/:id/approval    {choice, request_id?}
 *   POST /api/agent/enable               generate API_SERVER_KEY into the agent's .env
 *   POST /api/agent/restart              restart the agent gateway via its CLI
 *   POST /api/agent/sessions/:id/model   {model, provider?} -> pin the session's model
 *   GET  /api/agent/sessions             ?limit&offset -> {sessions, hasMore} (recent first)
 *   GET  /api/agent/sessions/:id/messages ?limit -> {messages: [{role, text, timestamp}]}
 *   PATCH  /api/agent/sessions/:id      {title?, pinned?, archived?} -> {session}
 *   DELETE /api/agent/sessions/:id      -> {id, deleted}
 *   POST   /api/agent/sessions/:id/fork {id?, title?} -> {session, parent}
 * Status also carries `restartable` (the bridge found a CLI to restart with).
 */
export async function handleAgentRoute(req, res, pathname, { getConfig = () => agentConfig(), fetchImpl = fetch, readBody,
  getHermes = () => null, execFileImpl } = {}) {
  if (!pathname.startsWith("/api/agent/")) return false;
  const cfg = getConfig();
  if (pathname === "/api/agent/status" && req.method === "GET") {
    const st = await agentStatus(cfg, { fetchImpl });
    sendJson(res, 200, { ...st, restartable: !cfg.disabled && !!getHermes()?.found });
    return true;
  }
  if (pathname === "/api/agent/restart" && req.method === "POST") {
    const out = await restartAgentGateway(cfg, { hermes: getHermes(), ...(execFileImpl ? { execFileImpl } : {}) });
    sendJson(res, out.ok ? 200 : out.code === "disabled" || out.code === "no-hermes" ? 409 : 502, out);
    return true;
  }
  if (pathname === "/api/agent/enable" && req.method === "POST") {
    const out = enableAgentApi(cfg);
    sendJson(res, out.ok ? 200 : out.code === "io" ? 500 : 409, out);
    return true;
  }
  if (pathname === "/api/agent/chat" && req.method === "POST") {
    let parsed;
    try { parsed = chatRequestBody(JSON.parse(await readBody(req))); } catch { parsed = { error: "invalid JSON" }; }
    if (parsed.error) { sendJson(res, 400, { error: parsed.error, code: "bad_request" }); return true; }
    if (cfg.disabled) { sendJson(res, 503, { error: "agent API disabled", code: "agent_unreachable" }); return true; }
    let ensured;
    try { ensured = await ensureSession(cfg, parsed.session, { fetchImpl }); }
    catch (e) { sendJson(res, 502, { error: `agent API unreachable: ${e.message}`, code: "agent_unreachable" }); return true; }
    if (!ensured.ok) { sendJson(res, 502, { error: `agent session: ${ensured.error}`, code: "agent_error", status: ensured.status }); return true; }
    const ctl = new AbortController();
    // The browser going away (stop button aborting the fetch, tab closed) drops
    // the upstream SSE, which makes the agent interrupt the run.
    res.on("close", () => { if (!res.writableFinished) ctl.abort(); });
    let up;
    try {
      up = await fetchImpl(`${cfg.url}/api/sessions/${encodeURIComponent(parsed.session)}/chat/stream`, {
        method: "POST", signal: ctl.signal,
        headers: { ...authHeaders(cfg), "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(parsed.body),
      });
    } catch (e) {
      if (!ctl.signal.aborted) sendJson(res, 502, { error: `agent API unreachable: ${e.message}`, code: "agent_unreachable" });
      return true;
    }
    if (!up.ok || !up.body) {
      sendJson(res, 502, { error: await errorText(up), code: "agent_error", status: up.status });
      return true;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
      "x-agent-session": parsed.session });
    try {
      for await (const chunk of up.body) {
        if (res.destroyed) break;
        res.write(chunk);
      }
    } catch {}
    res.end();
    return true;
  }
  if (pathname === "/api/agent/sessions" && req.method === "GET") {
    if (cfg.disabled) { sendJson(res, 503, { error: "agent API disabled", code: "agent_unreachable" }); return true; }
    const q = new URL(req.url, "http://x").searchParams;
    const { status, ...out } = await listAgentSessions(cfg, { limit: q.get("limit"), offset: q.get("offset") }, { fetchImpl });
    sendJson(res, status, out);
    return true;
  }
  const mm = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/messages$/);
  if (mm && req.method === "GET") {
    let sessionId = "";
    try { sessionId = decodeURIComponent(mm[1]); } catch {}
    if (!SESSION_ID_RE.test(sessionId)) { sendJson(res, 400, { error: "invalid session id", code: "bad_request" }); return true; }
    if (cfg.disabled) { sendJson(res, 503, { error: "agent API disabled", code: "agent_unreachable" }); return true; }
    const q = new URL(req.url, "http://x").searchParams;
    const { status, ...out } = await agentSessionMessages(cfg, sessionId, { limit: q.get("limit") }, { fetchImpl });
    sendJson(res, status, out);
    return true;
  }
  const sm = pathname.match(/^\/api\/agent\/sessions\/([^/]+)(\/fork)?$/);
  if (sm && (sm[2] ? req.method === "POST" : req.method === "PATCH" || req.method === "DELETE")) {
    let sessionId = "";
    try { sessionId = decodeURIComponent(sm[1]); } catch {}
    if (!SESSION_ID_RE.test(sessionId)) { sendJson(res, 400, { error: "invalid session id", code: "bad_request" }); return true; }
    let parsed = { body: null };
    if (req.method !== "DELETE") {
      try {
        const raw = await readBody(req);
        parsed = (sm[2] ? forkBody : sessionUpdateBody)(raw ? JSON.parse(raw) : sm[2] ? {} : null);
      } catch { parsed = { error: "invalid JSON" }; }
    }
    if (parsed.error) { sendJson(res, 400, { error: parsed.error, code: "bad_request" }); return true; }
    if (cfg.disabled) { sendJson(res, 503, { error: "agent API disabled", code: "agent_unreachable" }); return true; }
    const { status, ...out } = sm[2] ? await forkAgentSession(cfg, sessionId, parsed.body, { fetchImpl })
      : req.method === "DELETE" ? await deleteAgentSession(cfg, sessionId, { fetchImpl })
      : await updateAgentSession(cfg, sessionId, parsed.body, { fetchImpl });
    sendJson(res, status, out);
    return true;
  }
  const pm = pathname.match(/^\/api\/agent\/sessions\/([^/]+)\/model$/);
  if (pm && req.method === "POST") {
    let sessionId = "";
    try { sessionId = decodeURIComponent(pm[1]); } catch {}
    if (!SESSION_ID_RE.test(sessionId)) { sendJson(res, 400, { error: "invalid session id", code: "bad_request" }); return true; }
    let parsed;
    try { parsed = modelPinBody(JSON.parse(await readBody(req) || "{}")); } catch { parsed = { error: "invalid JSON" }; }
    if (parsed.error) { sendJson(res, 400, { error: parsed.error, code: "bad_request" }); return true; }
    if (cfg.disabled) { sendJson(res, 503, { error: "agent API disabled", code: "agent_unreachable" }); return true; }
    const { status, ...out } = await pinSessionModel(cfg, sessionId, parsed.body, { fetchImpl });
    sendJson(res, status, out);
    return true;
  }
  const m = pathname.match(/^\/api\/agent\/runs\/([^/]+)\/(stop|approval)$/);
  if (m && req.method === "POST") {
    if (!RUN_ID_RE.test(m[1])) { sendJson(res, 400, { error: "invalid run id", code: "bad_request" }); return true; }
    let body = {};
    if (m[2] === "approval") {
      try { body = JSON.parse(await readBody(req) || "{}"); } catch { sendJson(res, 400, { error: "invalid JSON", code: "bad_request" }); return true; }
      body = { choice: String(body.choice || ""), ...(body.request_id ? { request_id: String(body.request_id) } : {}) };
    }
    try {
      const r = await fetchImpl(`${cfg.url}/v1/runs/${m[1]}/${m[2]}`, {
        method: "POST", headers: { ...authHeaders(cfg), "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await r.text();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(text || "{}");
    } catch (e) {
      sendJson(res, 502, { error: `agent API unreachable: ${e.message}`, code: "agent_unreachable" });
    }
    return true;
  }
  sendJson(res, 404, { error: "unknown agent route" });
  return true;
}
