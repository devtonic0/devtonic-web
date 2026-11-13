import React, { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { loadMissionAsync, saveMissionAsync, bus } from "../store.js";

export default function Notes() {
  const [mission, setMission] = useState(null);
  const [preview, setPreview] = useState(false);
  const saveTimer = useRef(null);

  // Load via fs.promises so mounting the panel never blocks on sync XHR.
  // `live` guards against a slow read resolving after unmount.
  useEffect(() => {
    let live = true;
    const load = () => loadMissionAsync().then(m => { if (live) setMission(m); });
    load();
    const off = bus.on("project", () => { clearTimeout(saveTimer.current); load(); });
    return () => { live = false; off(); };
  }, []);

  function edit(text) {
    const m = { ...mission, notes: text };
    setMission(m);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveMissionAsync(m).catch(() => {}); }, 600);
  }

  if (!mission) return <div className="panel-body"><div className="notes-preview">Loading notes…</div></div>;

  return (
    <div className="panel-body">
      <div className="notes-toolbar">
        <button className={`tb-btn ${!preview ? "active" : ""}`} onClick={() => setPreview(false)}>Edit</button>
        <button className={`tb-btn ${preview ? "active" : ""}`} onClick={() => setPreview(true)}>Preview</button>
      </div>
      {preview ? (
        <div className="notes-preview" dangerouslySetInnerHTML={{ __html: marked.parse(mission.notes ?? "") }} />
      ) : (
        <textarea className="notes-edit" value={mission.notes ?? ""} onChange={e => edit(e.target.value)} spellCheck={false} />
      )}
    </div>
  );
}
