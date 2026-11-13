import React, { useState } from "react";
import { saveMissionAsync } from "../store.js";
import { useMission } from "./use-mission.js";

const NEXT = { pending: "active", active: "done", done: "pending" };

export default function Flow() {
  const [mission, setMission] = useMission();
  const [name, setName] = useState("");

  const phases = mission?.phases ?? [];

  function update(next) {
    const m = { ...mission, phases: next };
    setMission(m);
    saveMissionAsync(m).catch(() => {});
  }

  function add() {
    const n = name.trim();
    if (!n) return;
    update([...phases, { id: crypto.randomUUID(), name: n, status: "pending" }]);
    setName("");
  }

  if (!mission) return <div className="panel-body"><div className="empty-hint">loading…</div></div>;

  return (
    <div className="panel-body">
      <div className="flow-wrap">
        {phases.map((p, i) => (
          <React.Fragment key={p.id}>
            {i > 0 && <div className="phase-arrow">→</div>}
            <div className="phase-col">
              <div className={`phase-card ${p.status}`}>
                <div className="phase-name">{p.name}</div>
                <div className="phase-status">{p.status}</div>
                <div className="phase-actions">
                  <button onClick={() => update(phases.map(x => x.id === p.id ? { ...x, status: NEXT[x.status] } : x))}>cycle</button>
                  <button onClick={() => update(phases.filter(x => x.id !== p.id))}>✕</button>
                </div>
              </div>
            </div>
          </React.Fragment>
        ))}
        <div className="phase-col flow-add">
          <div className="todo-add" style={{ marginTop: 0 }}>
            <input
              value={name}
              placeholder="Add phase…"
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && add()}
              style={{ width: 130 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
