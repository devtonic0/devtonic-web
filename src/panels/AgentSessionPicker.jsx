import React, { useEffect, useRef, useState } from "react";
import { listAgentSessions } from "../platform/agent.js";
import { filterSessions, relativeAge, sessionLabel } from "../platform/agent-sessions.js";

// Modal picker over the agent's sessions (GET /api/agent/sessions through the
// bridge). Choosing a row calls onPick(session); the Chat panel then loads its
// transcript and continues the conversation in that agent session.
export default function AgentSessionPicker({ local = [], current, onPick, onClose }) {
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState("loading"); // loading | ready | error
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [busyId, setBusyId] = useState("");
  const inputRef = useRef(null);

  async function load(offset = 0) {
    setState("loading");
    const r = await listAgentSessions({ limit: 50, offset });
    if (!r.ok) { setError(r.error || "could not list sessions"); setState("error"); return; }
    setRows(cur => (offset ? [...cur, ...r.sessions] : r.sessions));
    setHasMore(!!r.hasMore);
    setState("ready");
  }
  useEffect(() => { load(0); inputRef.current?.focus(); }, []);

  const shown = filterSessions(rows, { query, archived, local });
  const pick = async s => {
    setBusyId(s.id);
    try { await onPick(s); } finally { setBusyId(""); }
  };

  return (
    <div className="modal-back" onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal agent-sessions" role="dialog" aria-label="Resume an agent session"
           onKeyDown={e => { if (e.key === "Escape") onClose?.(); }}>
        <div className="modal-title">Resume an agent session</div>
        <input ref={inputRef} placeholder="filter by title, preview, id or model" value={query}
               onChange={e => setQuery(e.target.value)} />
        <div className="agent-sessions-list">
          {state === "error" && <div className="picker-empty picker-err">{error}</div>}
          {state !== "error" && shown.length === 0 && (
            <div className="picker-empty">{state === "loading" ? "loading sessions…" : "no sessions match"}</div>
          )}
          {shown.map(s => (
            <button key={s.id} className={`agent-session-row ${s.id === current ? "cur" : ""}`}
                    disabled={!!busyId} onClick={() => pick(s)} title={s.id}>
              <span className="as-main">
                <span className="as-title">{s.pinned ? "📌 " : ""}{sessionLabel(s)}</span>
                <span className="as-meta">
                  {s.id}{s.source ? ` · ${s.source}` : ""}{s.model ? ` · ${s.model}` : ""}
                  {s.local ? " · in this project" : ""}{s.archived ? " · archived" : ""}
                </span>
              </span>
              <span className="as-side">
                <span>{busyId === s.id ? "loading…" : relativeAge(s.lastActive)}</span>
                <span className="as-count">{s.messageCount} msg</span>
              </span>
            </button>
          ))}
        </div>
        <div className="picker-foot">
          <label className="picker-hidden">
            <input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> show archived
          </label>
          {hasMore && <button disabled={state === "loading"} onClick={() => load(rows.length)}>load more</button>}
          <span style={{ marginLeft: "auto" }} />
          <button onClick={() => load(0)} disabled={state === "loading"}>refresh</button>
          <button onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}
