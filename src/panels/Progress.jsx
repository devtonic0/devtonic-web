import React, { useEffect, useState } from "react";
import { loadMission, saveMission, bus } from "../store.js";

export default function Progress() {
  const [mission, setMission] = useState(loadMission);
  const [text, setText] = useState("");

  useEffect(() => bus.on("project", () => setMission(loadMission())), []);
  useEffect(() => bus.on("mission", m => setMission({ ...m })), []);

  const todos = mission.todos ?? [];
  const done = todos.filter(t => t.done).length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;

  function update(next) {
    const m = { ...mission, todos: next };
    setMission(m);
    saveMission(m);
  }

  function add() {
    const t = text.trim();
    if (!t) return;
    update([...todos, { id: crypto.randomUUID(), text: t, done: false }]);
    setText("");
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
