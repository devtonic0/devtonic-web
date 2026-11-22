// Bridge proxy for the agent's HTTP API (Hermes / devtonic-agent api_server).
//
// The Chat panel prefers a structured streaming turn over this API instead of
// spawning the CLI and tailing ~/.hermes/logs/agent.log. The agent's API key
// never reaches the browser: the bridge reads it from the environment or the
// agent's .env and adds the bearer header itself. Everything here is pure or
// takes an injected fetch, so it is tested against a fake agent server.
import crypto from "node:crypto";
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
      approvals: f.run_approval !== false, stop: f.run_stop !== false };
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

const sendJson = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

/**
 * Handle /api/agent/* on the bridge. Returns false when the path isn't ours.
 *   GET  /api/agent/status
 *   POST /api/agent/chat                 {session, message, instructions?, model?, provider?} -> SSE passthrough
 *   POST /api/agent/runs/:id/stop
 *   POST /api/agent/runs/:id/approval    {choice, request_id?}
 *   POST /api/agent/enable               generate API_SERVER_KEY into the agent's .env
 */
export async function handleAgentRoute(req, res, pathname, { getConfig = () => agentConfig(), fetchImpl = fetch, readBody } = {}) {
  if (!pathname.startsWith("/api/agent/")) return false;
  const cfg = getConfig();
  if (pathname === "/api/agent/status" && req.method === "GET") {
    sendJson(res, 200, await agentStatus(cfg, { fetchImpl }));
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
