import React, { useEffect, useRef, useState } from "react";
import { deleteAgentSession, forkAgentSession, listAgentSessions, updateAgentSession } from "../platform/agent.js";
import { cleanTitle, dropSession, filterSessions, relativeAge, replaceSession, sessionLabel } from "../platform/agent-sessions.js";

// Modal picker over the agent's sessions (GET /api/agent/sessions through the
// bridge). Choosing a row calls onPick(session); the Chat panel then loads its
// transcript and continues the conversation in that agent session. Each row
// can also be renamed, pinned, archived, forked (the fork is then resumed) or
// deleted (onDeleted(id) lets Chat drop it from the project's session list).
export default function AgentSessionPicker({ local = [], current, onPick, onDeleted, onClose }) {
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState("loading"); // loading | ready | error
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [renaming, setRenaming] = useState(null); // {id, title}
  const renameDone = useRef(false); // Enter/Escape already handled; skip the blur save
  const [confirmDel, setConfirmDel] = useState("");
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

  // Run one row action with the row locked; failures land in the notice line.
  async function act(id, what, fn) {
    setBusyId(id);
    setNotice("");
    try {
      const r = await fn();
      if (r && r.ok === false) setNotice(`${what} failed: ${r.error || r.code}`);
      return r;
    } finally { setBusyId(""); }
  }
  const pick = s => act(s.id, "resume", () => onPick(s));
  const update = (s, patch, what) => act(s.id, what, async () => {
    const r = await updateAgentSession(s.id, patch);
    if (r.ok) setRows(cur => replaceSession(cur, r.session || { id: s.id, ...patch }));
    return r;
  });
  const fork = s => act(s.id, "fork", async () => {
    const r = await forkAgentSession(s.id);
    if (r.ok && r.session) {
      // The agent ends the source as "branched"; continue in the fork.
      setRows(cur => [r.session, ...cur]);
      await onPick(r.session);
    }
    return r;
  });
  const remove = s => act(s.id, "delete", async () => {
    setConfirmDel("");
    const r = await deleteAgentSession(s.id);
    if (r.ok) {
      setRows(cur => dropSession(cur, s.id));
      onDeleted?.(s.id);
      setNotice(`deleted ${s.id}`);
    }
    return r;
  });
  // save: "enter" commits anything (an empty title clears it), "blur" only a
  // non-empty change, so focus loss can't wipe a title by accident.
  const finishRename = save => {
    if (renameDone.current || !renaming) return;
    renameDone.current = true;
    const { id, title } = renaming;
    setRenaming(null);
    const s = rows.find(r => r.id === id);
    const next = cleanTitle(title);
    if (!save || !s || next === (s.title || "") || (save === "blur" && !next)) return;
    update(s, { title: next }, "rename");
  };
  const startRename = s => { renameDone.current = false; setRenaming({ id: s.id, title: s.title || "" }); };

  return (
    <div className="modal-back" onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal agent-sessions" role="dialog" aria-label="Resume an agent session"
           onKeyDown={e => { if (e.key === "Escape" && !renaming) onClose?.(); }}>
        <div className="modal-title">Resume an agent session</div>
        <input ref={inputRef} placeholder="filter by title, preview, id or model" value={query}
               onChange={e => setQuery(e.target.value)} />
        <div className="agent-sessions-list">
          {state === "error" && <div className="picker-empty picker-err">{error}</div>}
          {state !== "error" && shown.length === 0 && (
            <div className="picker-empty">{state === "loading" ? "loading sessions…" : "no sessions match"}</div>
          )}
          {shown.map(s => (
            <div key={s.id} className={`agent-session-row ${s.id === current ? "cur" : ""}`}>
              {renaming?.id === s.id ? (
                <input className="as-rename" autoFocus value={renaming.title} maxLength={200}
                       aria-label={`new title for ${s.id}`} placeholder="title (empty clears it)"
                       onChange={e => setRenaming({ id: s.id, title: e.target.value })}
                       onKeyDown={e => {
                         if (e.key === "Enter") finishRename("enter");
                         if (e.key === "Escape") { e.stopPropagation(); finishRename(null); }
                       }}
                       onBlur={() => finishRename("blur")} />
              ) : (
                <button className="as-main" disabled={!!busyId} onClick={() => pick(s)} title={`resume ${s.id}`}>
                  <span className="as-title">{s.pinned ? "📌 " : ""}{sessionLabel(s)}</span>
                  <span className="as-meta">
                    {s.id}{s.source ? ` · ${s.source}` : ""}{s.model ? ` · ${s.model}` : ""}
                    {s.local ? " · in this project" : ""}{s.archived ? " · archived" : ""}
                  </span>
                </button>
              )}
              <span className="as-side">
                <span>{busyId === s.id ? "working…" : relativeAge(s.lastActive)}</span>
                <span className="as-count">{s.messageCount} msg</span>
              </span>
              <span className="as-actions">
                {confirmDel === s.id ? (
                  <>
                    <button className="as-danger" disabled={!!busyId} onClick={() => remove(s)}>delete</button>
                    <button disabled={!!busyId} onClick={() => setConfirmDel("")}>keep</button>
                  </>
                ) : (
                  <>
                    <button title="rename" aria-label={`rename ${s.id}`} disabled={!!busyId}
                            onClick={() => startRename(s)}>✎</button>
                    <button title={s.pinned ? "unpin" : "pin"} aria-label={`${s.pinned ? "unpin" : "pin"} ${s.id}`}
                            disabled={!!busyId} className={s.pinned ? "on" : ""}
                            onClick={() => update(s, { pinned: !s.pinned }, s.pinned ? "unpin" : "pin")}>📌</button>
                    <button title={s.archived ? "unarchive" : "archive"} aria-label={`${s.archived ? "unarchive" : "archive"} ${s.id}`}
                            disabled={!!busyId} className={s.archived ? "on" : ""}
                            onClick={() => update(s, { archived: !s.archived }, s.archived ? "unarchive" : "archive")}>🗄</button>
                    <button title="fork into a new session and continue there" aria-label={`fork ${s.id}`}
                            disabled={!!busyId} onClick={() => fork(s)}>⑂</button>
                    <button title="delete from the agent" aria-label={`delete ${s.id}`} disabled={!!busyId}
                            onClick={() => setConfirmDel(s.id)}>🗑</button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
        {notice && <div className="picker-err as-notice">{notice}</div>}
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
