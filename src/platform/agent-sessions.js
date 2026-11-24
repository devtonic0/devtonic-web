// Session list + resume over the agent API (DOM-free, unit-tested in
// test/agent-sessions.test.mjs).
//
// The bridge's GET /api/agent/sessions returns the agent's sessions (recent
// first, already reduced by `sessionSummary()` in server/agent-api.mjs) and
// GET /api/agent/sessions/:id/messages the conversational turns of one. The
// Chat panel uses these helpers to show a "resume" picker and to turn a
// transcript into its own message shape.

/** Short relative age like "5m", "3h", "2d" for a unix-seconds timestamp. */
export function relativeAge(ts, nowMs = Date.now()) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const s = Math.max(0, Math.round(nowMs / 1000 - ts));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** One-line label for a session row: title, else preview, else id. */
export function sessionLabel(s) {
  const one = t => String(t || "").replace(/\s+/g, " ").trim();
  return one(s?.title) || one(s?.preview).slice(0, 80) || String(s?.id || "");
}

/**
 * Filter + order sessions for the picker. `query` matches id, title, preview
 * and model (case-insensitive). Pinned rows first, then most recent activity.
 * Archived rows are hidden unless `archived` is true. `local` (the project's
 * own session names) marks rows already in the dropdown.
 */
export function filterSessions(sessions, { query = "", archived = false, local = [] } = {}) {
  const q = String(query).trim().toLowerCase();
  const mine = new Set(local);
  return (Array.isArray(sessions) ? sessions : [])
    .filter(s => s && s.id && (archived || !s.archived))
    .filter(s => !q || [s.id, s.title, s.preview, s.model].some(v => String(v || "").toLowerCase().includes(q)))
    .map(s => ({ ...s, local: mine.has(s.id) }))
    .sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((b.lastActive ?? 0) - (a.lastActive ?? 0)));
}

/**
 * Turn the agent transcript ({role, text}) into Chat messages. Returns the
 * chat message list (oldest first) with a leading system note saying where
 * it came from; `truncated` adds that older turns were not loaded.
 */
export function transcriptToChat(sessionId, messages, { truncated = false } = {}) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
    .map(m => ({ who: m.role === "user" ? "user" : "hermes", text: m.text }));
  const note = turns.length
    ? `⟲ resumed ${sessionId} from the agent: ${turns.length} message${turns.length === 1 ? "" : "s"}${truncated ? " (latest only)" : ""}`
    : `⟲ resumed ${sessionId} from the agent: no messages yet`;
  return [{ who: "system", text: note }, ...turns];
}

/** Add `id` to the front of the project's session list (no duplicates). */
export function withSession(list, id) {
  return [id, ...(Array.isArray(list) ? list : []).filter(s => s !== id)];
}
