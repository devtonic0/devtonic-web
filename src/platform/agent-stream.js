// DOM-free model for a structured agent chat turn streamed over SSE from the
// bridge's /api/agent/chat (a passthrough of the agent's
// POST /api/sessions/{id}/chat/stream). Covered by test/agent-stream.test.mjs.

/**
 * Incremental Server-Sent Events parser. Feed it text chunks in any split;
 * it calls onEvent({event, data}) once per complete frame. `data` is the
 * JSON-parsed payload when possible, else the raw string. Comment lines
 * (": keepalive") are ignored.
 */
export function createSSEParser(onEvent) {
  let buf = "";
  let event = "", data = [];
  const dispatch = () => {
    if (!data.length && !event) return;
    const raw = data.join("\n");
    let parsed = raw;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch {}
    onEvent({ event: event || "message", data: parsed });
    event = ""; data = [];
  };
  const line = l => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  return {
    feed(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.search(/\r?\n/)) >= 0) {
        const l = buf.slice(0, nl);
        buf = buf.slice(buf[nl] === "\r" ? nl + 2 : nl + 1);
        line(l);
      }
    },
    end() { if (buf) { line(buf); buf = ""; } dispatch(); },
  };
}

export function initialTurn(startedAt = Date.now()) {
  return { runId: null, text: "", entries: [], transcript: [], approval: null,
    status: "starting", final: null, error: null, startedAt, live: true };
}

const short = (s, n = 90) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/**
 * Fold one SSE event into the turn state (returns a new object). Unknown
 * events are ignored so newer agents can add event types safely.
 */
export function reduceTurn(state, { event, data }) {
  const d = data && typeof data === "object" ? data : {};
  const s = { ...state };
  if (d.run_id && !s.runId) s.runId = d.run_id;
  switch (event) {
    case "run.started":
      s.status = "running";
      s.entries = [...s.entries, { icon: "▶", text: "session started", kind: "think" }];
      break;
    case "assistant.delta":
      if (typeof d.delta === "string") s.text += d.delta;
      break;
    case "assistant.commentary":
      if (d.text) s.transcript = [...s.transcript, String(d.text)];
      break;
    case "tool.progress":
      // Reasoning deltas arrive as tool.progress with tool_name "_thinking".
      if (d.delta) {
        const t = [...s.transcript];
        if (d.tool_name === "_thinking" && t.length && t[t.length - 1].startsWith("💭 ")) t[t.length - 1] += d.delta;
        else t.push(d.tool_name === "_thinking" ? `💭 ${d.delta}` : `${d.tool_name}: ${d.delta}`);
        s.transcript = t;
      }
      break;
    case "tool.started":
      s.entries = [...s.entries, { icon: "⋯", text: `${d.tool_name || "tool"}${d.preview ? ` · ${short(d.preview)}` : ""}`, kind: "tool", live: true, tool: d.tool_name }];
      break;
    case "tool.completed":
    case "tool.failed": {
      const failed = event === "tool.failed";
      const entry = { icon: failed ? "✕" : "✓", text: `${d.tool_name || "tool"}${d.preview ? ` · ${short(d.preview)}` : ""}`, kind: failed ? "error" : "tool" };
      const entries = [...s.entries];
      const i = entries.map(e => e.live && e.tool === d.tool_name).lastIndexOf(true);
      if (i >= 0) entries[i] = entry; else entries.push(entry);
      s.entries = entries;
      break;
    }
    case "approval.request":
      s.status = "waiting_for_approval";
      s.approval = { command: d.command || "", description: d.description || "",
        choices: Array.isArray(d.choices) && d.choices.length ? d.choices : ["once", "deny"],
        requestId: d.request_id || null, runId: d.run_id || s.runId };
      s.entries = [...s.entries, { icon: "⚠", text: `approval needed${d.command ? ` · ${short(d.command)}` : ""}`, kind: "error" }];
      break;
    case "approval.responded":
      s.approval = null;
      if (s.status === "waiting_for_approval") s.status = "running";
      break;
    case "assistant.completed":
      s.final = typeof d.content === "string" ? d.content : s.text;
      break;
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      s.status = event.slice(4);
      s.approval = null;
      if (event === "run.failed" && d.error && !s.error) s.error = String(d.error);
      s.entries = [...s.entries, { icon: "◇", text: `run ${s.status}`, kind: event === "run.completed" ? "think" : "error" }];
      break;
    case "error":
      s.error = String(d.message || d.error || "agent error");
      s.status = "failed";
      break;
    case "done":
      s.live = false;
      break;
  }
  return s;
}

/** The text to keep as the assistant's reply once the turn ends. */
export function turnReply(s) {
  const body = (s.final ?? s.text ?? "").trim();
  if (s.error) return body ? `${body}\n\n⚠️ ${s.error}` : `⚠️ ${s.error}`;
  if (s.status === "cancelled") return body ? `${body}\n\n_(stopped)_` : "_(stopped)_";
  return body || "(no output)";
}

/** Short label for why the Chat panel is (not) using the structured API. */
export function transportLabel(status) {
  if (!status) return { mode: "cli", title: "checking agent API…" };
  if (status.available) return { mode: "api", title: `streaming via agent API at ${status.url}${status.version ? ` (v${status.version})` : ""}` };
  const why = { disabled: "DEVTONIC_AGENT_API is off", unreachable: `agent API not reachable at ${status.url}`,
    "no-key": "agent API running but API_SERVER_KEY is not set", unauthorized: "agent API rejected the key",
    unsupported: "agent API has no session chat streaming" }[status.reason] || status.reason;
  return { mode: "cli", title: `CLI + log tail (${why}${status.detail && !why.includes(status.detail) ? `: ${status.detail}` : ""})` };
}
