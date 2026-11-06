import React, { useEffect, useState } from "react";
import { loadMission, bus, projectRoot } from "../store.js";

// Feature Map with drill-in: Overview / Flow / References per feature.
// refs come from mission.json feature.refs [{file, note}] — falls back to a
// live ripgrep over stack keywords when absent.
const { execFile } = window.require("child_process");

const STATUS = {
  live: { label: "LIVE", color: "var(--ok)" },
  building: { label: "BUILDING", color: "var(--accent)" },
  planned: { label: "PLANNED", color: "var(--dim)" },
};

function openInCode(file, line) {
  bus.emit("open-file", line ? `${projectRoot}/${file}::${line}` : `${projectRoot}/${file}`);
}

function FeatureDetail({ feature, onBack }) {
  const [tab, setTab] = useState("overview");
  const [foundRefs, setFoundRefs] = useState(null);

  // If no curated refs, grep the codebase for the feature name / stack hints.
  useEffect(() => {
    if (feature.refs?.length || tab !== "refs") return;
    const needle = feature.grep ?? feature.name.split(" ")[0];
    execFile("rg", ["-ln", "-g", "!node_modules", "-g", "!dist", "-i", needle, "."],
      { cwd: projectRoot, maxBuffer: 2e6 }, (_e, out) => {
        setFoundRefs((out || "").trim().split("\n").filter(Boolean).slice(0, 20).map(f => ({ file: f.replace(/^\.\//, ""), note: `matches “${needle}”` })));
      });
  }, [tab, feature]);

  const refs = feature.refs?.length ? feature.refs : (foundRefs ?? []);
  const flow = feature.flow ?? [];

  return (
    <div className="fd-wrap">
      <div className="fd-head">
        <button className="tb-btn" onClick={onBack}>← back</button>
        <span className="fd-title">{feature.name}</span>
        <span className="fm-status" style={{ color: STATUS[feature.status].color }}>{STATUS[feature.status].label}</span>
      </div>
      <div className="fd-tabs">
        {["overview", "flow", "refs"].map(t => (
          <button key={t} className={`tb-btn ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "refs" ? "references" : t}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="fd-body">
          <p className="fd-desc">{feature.desc}</p>
          <div className="git-section">stack</div>
          <div className="fm-stack">{(feature.stack ?? []).map(s => <span key={s} className="fm-chip">{s}</span>)}</div>
          {feature.why && (<><div className="git-section">why this approach</div><p className="fd-desc">{feature.why}</p></>)}
        </div>
      )}

      {tab === "flow" && (
        <div className="fd-body">
          {flow.length === 0 && <div className="empty-hint">No flow defined — ask Hermes to add a `flow` array to this feature in devtonic.config.json.</div>}
          {flow.map((step, i) => (
            <div key={i} className="fd-step">
              <div className="fd-step-num">{i + 1}</div>
              <div className="fd-step-body">
                <div className="fd-step-title">{step.title}</div>
                <div className="fd-step-detail">{step.detail}</div>
                {step.file && (
                  <button className="fd-ref" onClick={() => openInCode(step.file, step.line)}>
                    ⌥ {step.file}{step.line ? `:${step.line}` : ""}
                  </button>
                )}
              </div>
              {i < flow.length - 1 && <div className="fd-step-line" />}
            </div>
          ))}
        </div>
      )}

      {tab === "refs" && (
        <div className="fd-body">
          {refs.length === 0 && <div className="empty-hint">scanning…</div>}
          {refs.map((r, i) => (
            <button key={i} className="fd-ref-row" onClick={() => openInCode(r.file, r.line)}>
              <span className="fd-ref-file">⌥ {r.file}{r.line ? `:${r.line}` : ""}</span>
              <span className="fd-ref-note">{r.note}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FeatureMap() {
  const [mission, setMission] = useState(loadMission);
  const [selected, setSelected] = useState(null);
  useEffect(() => bus.on("project", () => { setMission(loadMission()); setSelected(null); }), []);
  useEffect(() => bus.on("mission", m => setMission({ ...m })), []);

  const features = mission.features ?? [];

  if (selected) {
    const f = features.find(x => x.name === selected);
    if (f) return <div className="panel-body"><FeatureDetail feature={f} onBack={() => setSelected(null)} /></div>;
  }

  return (
    <div className="panel-body">
      <div className="fm-wrap">
        {features.length === 0 && (
          <div className="empty-hint">No feature map yet — ask Hermes to map the project.</div>
        )}
        {["live", "building", "planned"].map(g => {
          const list = features.filter(f => f.status === g);
          if (!list.length) return null;
          return (
            <div key={g}>
              <div className="fm-group" style={{ color: STATUS[g].color }}>{STATUS[g].label} · {list.length}</div>
              <div className="fm-grid">
                {list.map(f => (
                  <button key={f.name} className={`fm-card ${g}`} onClick={() => setSelected(f.name)}>
                    <div className="fm-name">{f.name} <span className="fm-open">→</span></div>
                    <div className="fm-desc">{f.desc}</div>
                    <div className="fm-stack">
                      {(f.stack ?? []).map(s => <span key={s} className="fm-chip">{s}</span>)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
