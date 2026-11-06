import React, { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { loadMission, saveMission, bus } from "../store.js";

export default function Notes() {
  const [mission, setMission] = useState(loadMission);
  const [preview, setPreview] = useState(false);
  const saveTimer = useRef(null);

  useEffect(() => bus.on("project", () => setMission(loadMission())), []);

  function edit(text) {
    const m = { ...mission, notes: text };
    setMission(m);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveMission(m), 600);
  }

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
