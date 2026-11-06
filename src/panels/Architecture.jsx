import React, { useEffect, useState } from "react";
import { loadMission, saveMission, bus, projectRoot } from "../store.js";

// Architecture: clickable nodes → purpose explanation + live code references.
const { execFile } = window.require("child_process");

const DEFAULT_ARCH = {
  layers: [
    { name: "Client", items: [{ name: "Web UI", detail: "framework TBD" }] },
    { name: "Backend", items: [{ name: "API", detail: "define in mission.json" }] },
    { name: "Providers", items: [{ name: "—", detail: "external services" }] },
  ],
};

const COLORS = ["#5599ff", "#8b5cf6", "#34d399", "#fbbf24", "#f472b6", "#60a5fa", "#4ade80"];

function NodeDetail({ node, onBack }) {
  const [refs, setRefs] = useState(null);

  useEffect(() => {
    if (node.refs?.length) { setRefs(node.refs); return; }
    const needle = node.grep ?? node.name.split(/[\s(]/)[0];
    execFile("rg", ["-ln", "-g", "!node_modules", "-g", "!dist", "-g", "!package-lock.json", "-i", needle, "."],
      { cwd: projectRoot, maxBuffer: 2e6 }, (_e, out) => {
        setRefs((out || "").trim().split("\n").filter(Boolean).slice(0, 20).map(f => ({ file: f.replace(/^\.\//, ""), note: `matches “${needle}”` })));
      });
  }, [node]);

  return (
    <div className="fd-wrap">
      <div className="fd-head">
        <button className="tb-btn" onClick={onBack}>← back</button>
        <span className="fd-title">{node.name}</span>
      </div>
      <div className="fd-body">
        <div className="git-section">what it does here</div>
        <p className="fd-desc">{node.purpose ?? node.detail}</p>
        <div className="git-section">code references</div>
        {!refs && <div className="empty-hint">scanning…</div>}
        {refs?.length === 0 && <div className="empty-hint">no matches found in the codebase</div>}
        {refs?.map((r, i) => (
          <button
            key={i}
            className="fd-ref-row"
            onClick={() => bus.emit("open-file", r.line ? `${projectRoot}/${r.file}::${r.line}` : `${projectRoot}/${r.file}`)}
          >
            <span className="fd-ref-file">⌥ {r.file}{r.line ? `:${r.line}` : ""}</span>
            <span className="fd-ref-note">{r.note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Architecture() {
  const [mission, setMission] = useState(loadMission);
  const [selected, setSelected] = useState(null);
  useEffect(() => bus.on("project", () => { setMission(loadMission()); setSelected(null); }), []);
  useEffect(() => bus.on("mission", m => setMission({ ...m })), []);

  const arch = mission.architecture ?? DEFAULT_ARCH;

  if (selected) {
    return <div className="panel-body"><NodeDetail node={selected} onBack={() => setSelected(null)} /></div>;
  }

  return (
    <div className="panel-body">
      <div className="arch-wrap">
        {arch.layers.map((layer, li) => (
          <React.Fragment key={layer.name}>
            {li > 0 && (
              <div className="arch-connector">
                <div className="arch-line" />
                <span>▼</span>
              </div>
            )}
            <div className="arch-layer">
              <div className="arch-layer-name">{layer.name}</div>
              <div className="arch-items">
                {layer.items.map((it, i) => (
                  <button key={it.name} className="arch-node" style={{ borderColor: it.color ?? COLORS[i % COLORS.length] }} onClick={() => setSelected(it)}>
                    <div className="arch-node-name" style={{ color: it.color ?? COLORS[i % COLORS.length] }}>{it.name} <span className="fm-open">→</span></div>
                    <div className="arch-node-detail">{it.detail}</div>
                  </button>
                ))}
              </div>
            </div>
          </React.Fragment>
        ))}
        <div className="arch-hint">Click any node for purpose + code references. Hermes keeps this in <code>devtonic.config.json</code>.</div>
      </div>
    </div>
  );
}
