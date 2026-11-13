import React, { useEffect, useState } from "react";
import { loadMissionAsync, saveMissionAsync, bus } from "../store.js";

export default function Progress() {
  const [mission, setMission] = useState(null);
  const [text, setText] = useState("");

  // Async load (fs.promises) on mount and on project switch.
  useEffect(() => {
    let live = true;
    const load = () => loadMissionAsync().then(m => { if (live) setMission(m); });
    load();
    const offProject = bus.on("project", load);
    const offMission = bus.on("mission", m => setMission({ ...m }));
    return () => { live = false; offProject(); offMission(); };
  }, []);

  const todos = mission?.todos ?? [];
  const done = todos.filter(t => t.done).length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;

  function update(next) {
    const m = { ...mission, todos: next };
    setMission(m);
    saveMissionAsync(m).catch(() => {});
  }

  function add() {
    const t = text.trim();
    if (!t) return;
    update([...todos, { id: crypto.randomUUID(), text: t, done: false }]);
    setText("");
  }

  if (!mission) {
    return <div className="panel-body"><div className="prog-wrap"><div className="prog-label">Loading…</div></div></div>;
  }

  return (
    <div className="panel-body">
      <div className="prog-wrap">
        <div className="prog-bar-outer"><div className="prog-bar-inner" style={{ width: `${pct}%` }} /></div>
        <div className="prog-label">{done}/{todos.length} complete · {pct}%</div>
        {todos.map(t => (
          <div key={t.id} className={`todo-row ${t.done ? "done" : ""}`}>
            <button className="todo-check" onClick={() => update(todos.map(x => x.id === t.id ? { ...x, done: !x.done } : x))}>✓</button>
            <span className="todo-text">{t.text}</span>
            <button className="todo-del" onClick={() => update(todos.filter(x => x.id !== t.id))}>✕</button>
          </div>
        ))}
        <div className="todo-add">
          <input
            value={text}
            placeholder="Add task…"
            onChange={e => setText(e.target.value)}
            onKeyDown={e => e.key === "Enter" && add()}
          />
          <button className="send-btn" onClick={add}>Add</button>
        </div>
      </div>
    </div>
  );
}
