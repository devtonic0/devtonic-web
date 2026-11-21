// Browser client for the bridge's /api/agent/* proxy (server/agent-api.mjs).
// The agent's API key stays on the bridge; the browser only sends the
// devtonic token.
import { createSSEParser } from "./agent-stream.js";

const token = () => localStorage.getItem("devtonic-token") || "";
const headers = json => ({ "x-devtonic-token": token(), ...(json ? { "content-type": "application/json" } : {}) });

let cached = null, cachedAt = 0;
/** GET /api/agent/status, cached for `maxAgeMs`. Never throws. */
export async function agentStatus({ maxAgeMs = 15000, force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < maxAgeMs) return cached;
  try {
    const r = await fetch("/api/agent/status", { headers: headers() });
    cached = r.ok ? await r.json() : { available: false, reason: "unreachable", detail: `bridge returned ${r.status}` };
  } catch (e) {
    cached = { available: false, reason: "unreachable", detail: e.message };
  }
  cachedAt = Date.now();
  return cached;
}

/**
 * Run one chat turn. Resolves when the stream ends; calls onEvent for every
 * SSE event. Rejects with err.code = "agent_unreachable" | "agent_error" |
 * "bad_request" when the turn could not start (nothing was streamed yet), so
 * the caller can fall back to the CLI. Aborting `signal` stops the run.
 */
export async function streamAgentChat({ session, message, instructions, model, provider, signal, onEvent }) {
  const r = await fetch("/api/agent/chat", { method: "POST", headers: headers(true), signal,
    body: JSON.stringify({ session, message, instructions, model, provider }) });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({}));
    throw Object.assign(new Error(j.error || `agent chat returned ${r.status}`), { code: j.code || "agent_error", status: r.status });
  }
  const parser = createSSEParser(onEvent);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(dec.decode(value, { stream: true }));
    }
  } catch (e) {
    if (e.name !== "AbortError") throw e;
  }
  parser.end();
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: headers(true), body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || j?.error || `HTTP ${r.status}`);
  return j;
}

export const respondApproval = (runId, choice, requestId) =>
  post(`/api/agent/runs/${encodeURIComponent(runId)}/approval`, { choice, ...(requestId ? { request_id: requestId } : {}) });

export const stopRun = runId => post(`/api/agent/runs/${encodeURIComponent(runId)}/stop`, {});
