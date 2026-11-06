import React, { useState } from "react";
import { loadSettings, saveSettings } from "../store.js";

// App settings: UI scale (true zoom), theme, behavior toggles, resets.
const { webFrame } = window.require("electron");

export default function Settings() {
  const s0 = loadSettings();
  const [scale, setScale] = useState(s0.uiScale ?? 100);
  const [diffPoll, setDiffPoll] = useState(s0.diffPollSec ?? 8);
  const [mapDepth, setMapDepth] = useState(s0.mapDepth ?? 6);
  const [cleared, setCleared] = useState("");

  function applyScale(v) {
    setScale(v);
    webFrame.setZoomFactor(v / 100);
    saveSettings({ uiScale: v });
  }
  const save = (k, v, set) => { set(v); saveSettings({ [k]: v }); };

  return (
    <div className="panel-body">
      <div className="usage-scroll">
        <div className="git-section">interface</div>
        <div className="set-row">
          <span className="set-label">UI scale</span>
          <input type="range" min={70} max={160} step={5} value={scale} onChange={e => applyScale(+e.target.value)} />
          <span className="set-val">{scale}%</span>
        </div>
        <div className="cfg-hint">Scales the entire interface — fonts, panels, everything. Theme (dark/light) toggles from the ☀/☾ button in the header.</div>

        <div className="git-section">behavior</div>
        <div className="set-row">
          <span className="set-label">live diff poll while Hermes works</span>
          <input type="range" min={3} max={30} value={diffPoll} onChange={e => save("diffPollSec", +e.target.value, setDiffPoll)} />
          <span className="set-val">{diffPoll}s</span>
        </div>
        <div className="set-row">
          <span className="set-label">map scan depth</span>
          <input type="range" min={3} max={9} value={mapDepth} onChange={e => save("mapDepth", +e.target.value, setMapDepth)} />
          <span className="set-val">{mapDepth} levels</span>
        </div>

        <div className="git-section">resets</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="tb-btn" onClick={() => { saveSettings({ chatSessionsByProject: {}, chatActiveByProject: {} }); setCleared("session lists reset (history stays in Hermes)"); }}>reset session list</button>
          <button className="tb-btn" onClick={() => { saveSettings({ recentProjects: [] }); setCleared("recent projects cleared"); }}>clear recent projects</button>
          <button className="tb-btn" onClick={() => { applyScale(100); setCleared("scale reset"); }}>reset scale</button>
          <button className="tb-btn" onClick={() => { saveSettings({ setupDone: false }); setCleared("setup wizard will show on next launch"); }}>re-run setup wizard</button>
        </div>
        {cleared && <div className="cfg-hint" style={{ marginTop: 8 }}>✓ {cleared}</div>}

        <div className="git-section">about</div>
        <div className="cfg-hint">
          Devtonic v1.0.0 — AI mission control, powered by Hermes.<br />
          Config file: <code>~/.hermes-mission-control.json</code> · Per-project state: <code>&lt;project&gt;/.hermes/mission.json</code>
        </div>
      </div>
    </div>
  );
}
