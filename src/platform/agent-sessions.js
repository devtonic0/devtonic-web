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

const chatTurns = messages => (Array.isArray(messages) ? messages : [])
  .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim())
  .map(m => ({ who: m.role === "user" ? "user" : "hermes", text: m.text }));

const resumeNote = (sessionId, count, more) => count
  ? `⟲ resumed ${sessionId} from the agent: ${count} message${count === 1 ? "" : "s"}${more ? " (scroll up for older)" : ""}`
  : `⟲ resumed ${sessionId} from the agent: no messages yet`;

/**
 * Turn the agent transcript ({role, text}) into Chat messages. Returns the
 * chat message list (oldest first) with a leading system note saying where
 * it came from. When `hasMore` is set the note carries the paging cursor
 * (`resume: {session, nextOffset, hasMore, loaded}`) so the panel can load
 * older pages on scroll-up with `prependOlder()`.
 */
export function transcriptToChat(sessionId, messages, { hasMore = false, nextOffset = 0, oldestId = null } = {}) {
  const turns = chatTurns(messages);
  const note = { who: "system", text: resumeNote(sessionId, turns.length, hasMore) };
  if (hasMore) note.resume = { session: sessionId, nextOffset, hasMore: true, loaded: turns.length, beforeId: oldestId ?? null };
  return [note, ...turns];
}

/** The paging cursor of a resumed transcript, or null when nothing older is left to load. */
export function olderCursor(chat) {
  const r = Array.isArray(chat) ? chat[0]?.resume : null;
  return r && r.hasMore && typeof r.session === "string" && Number.isFinite(r.nextOffset) ? r : null;
}

/**
 * Insert an older page ({messages, nextOffset, hasMore} from
 * `agentSessionMessages`) after the leading resume note and advance its
 * cursor. Rows at or after the cursor's `beforeId` (already shown; turns sent
 * since the resume shift the agent's offsets) are dropped. Returns `chat`
 * unchanged when it has no cursor.
 */
export function prependOlder(chat, page) {
  const cur = olderCursor(chat);
  if (!cur || !page) return chat;
  const fresh = (Array.isArray(page.messages) ? page.messages : [])
    .filter(m => !(typeof cur.beforeId === "number" && typeof m?.id === "number" && m.id >= cur.beforeId));
  const turns = chatTurns(fresh);
  const loaded = (cur.loaded ?? 0) + turns.length;
  const hasMore = !!page.hasMore && Number(page.nextOffset) > cur.nextOffset;
  const note = { who: "system", text: resumeNote(cur.session, loaded, hasMore) };
  const beforeId = typeof page.oldestId === "number" ? Math.min(page.oldestId, cur.beforeId ?? Infinity) : cur.beforeId ?? null;
  if (hasMore) note.resume = { ...cur, nextOffset: Number(page.nextOffset), loaded, beforeId };
  return [note, ...turns, ...chat.slice(1)];
}

/** Add `id` to the front of the project's session list (no duplicates). */
export function withSession(list, id) {
  return [id, ...(Array.isArray(list) ? list : []).filter(s => s !== id)];
}

/** Replace the row with `updated.id` in the picker rows (no-op for a falsy update). */
export function replaceSession(rows, updated) {
  const list = Array.isArray(rows) ? rows : [];
  if (!updated || !updated.id) return list;
  return list.map(s => (s && s.id === updated.id ? { ...s, ...updated } : s));
}

/** Picker rows without `id`. */
export const dropSession = (rows, id) => (Array.isArray(rows) ? rows : []).filter(s => s && s.id !== id);

/**
 * The project's session list after the agent session `id` was deleted.
 * Returns {sessions, active, changed}: `id` removed, the active session kept
 * unless it was the deleted one (then the next in the list, else `fallback`),
 * and the list never left empty.
 */
export function afterSessionDelete(list, id, active, fallback) {
  const before = Array.isArray(list) ? list : [];
  let sessions = before.filter(s => s !== id);
  if (!sessions.length) sessions = [fallback && fallback !== id ? fallback : `${id}-new`];
  const nextActive = active === id || !sessions.includes(active) ? sessions[0] : active;
  return { sessions, active: nextActive, changed: sessions.length !== before.length || nextActive !== active };
}

/** Validate a rename typed into the picker: trimmed, single line, <= 200 chars. */
export function cleanTitle(t) {
  const s = String(t ?? "").replace(/[\u0000-\u001f]+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 200) : s;
}
