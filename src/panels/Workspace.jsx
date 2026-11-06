import React, { useState } from "react";
import { projectRoot } from "../store.js";

// Workspace image: export the full Hermes identity + app state as a portable
// .devtonic.tar.gz — memory, skills, config, sessions, plugins list, app
// settings, project mission files — and import one on a fresh machine.
const { execFile } = window.require("child_process");
const { ipcRenderer } = window.require("electron");
const fs = window.require("fs");
const path = window.require("path");
const os = window.require("os");

const HOME = os.homedir();
const H = path.join(HOME, ".hermes");

// what makes up a "workspace image"
const PARTS = [
  { key: "memories", label: "Memory (facts, user profile)", path: ".hermes/memories" },
  { key: "skills", label: "Skills (learned procedures)", path: ".hermes/skills" },
  { key: "config", label: "Config (models, tools, providers)", path: ".hermes/config.yaml" },
  { key: "env", label: "Secrets (.env — API keys!)", path: ".hermes/.env", sensitive: true },
  { key: "sessions", label: "Chat history (state.db)", path: ".hermes/state.db" },
  { key: "plugins", label: "Plugins (installed set)", path: ".hermes/plugins" },
  { key: "cron", label: "Scheduled jobs", path: ".hermes/cron" },
  { key: "app", label: "Devtonic app settings", path: ".hermes-mission-control.json" },
];

export default function Workspace() {
  const [selected, setSelected] = useState(new Set(PARTS.map(p => p.key).filter(k => k !== "env")));
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

  const toggle = k => setSelected(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  async function exportImage() {
    const dir = await ipcRenderer.invoke("pick-folder");
    if (!dir) return;
    setBusy(true);
    const stamp = new Date().toISOString().slice(0, 10);
    const out = path.join(dir, `devtonic-workspace-${stamp}.tar.gz`);
    const include = PARTS.filter(p => selected.has(p.key) && fs.existsSync(path.join(HOME, p.path))).map(p => p.path);
    // also carry the current project's mission state
    const missionRel = path.relative(HOME, path.join(projectRoot, ".hermes"));
    if (!missionRel.startsWith("..") && fs.existsSync(path.join(projectRoot, ".hermes"))) include.push(missionRel);
    const manifest = { created: new Date().toISOString(), host: os.hostname(), parts: [...selected], version: 1 };
    fs.writeFileSync(path.join(HOME, ".devtonic-manifest.json"), JSON.stringify(manifest, null, 2));
    include.push(".devtonic-manifest.json");
    execFile("tar", ["czf", out, "-C", HOME, ...include], { maxBuffer: 1e6 }, (err, _o, errOut) => {
      setBusy(false);
      setLog(err ? `⚠️ ${errOut || err.message}` : `✓ Workspace image written:\n${out}\n\nParts: ${include.join(", ")}\n\nMove it to the new machine and use Import there.`);
    });
  }

  async function importImage() {
    const file = await ipcRenderer.invoke("pick-file", [{ name: "Devtonic workspace", extensions: ["gz", "tgz"] }]);
    if (!file) return;
    setBusy(true);
    // safety snapshot of the current ~/.hermes before overwrite
    const backup = path.join(HOME, `.hermes-backup-${Date.now()}.tar.gz`);
    execFile("tar", ["czf", backup, "-C", HOME, ".hermes"], () => {
      execFile("tar", ["xzf", file, "-C", HOME], { maxBuffer: 1e6 }, (err, _o, errOut) => {
        setBusy(false);
        setLog(err
          ? `⚠️ ${errOut || err.message}`
          : `✓ Workspace imported from:\n${file}\n\nPrevious ~/.hermes backed up to:\n${backup}\n\nRestart the app (and any running Hermes gateway) to pick everything up.`);
      });
    });
  }

  return (
    <div className="panel-body">
      <div className="usage-scroll">
        <div className="git-section">workspace image — what to include</div>
        {PARTS.map(p => (
          <label key={p.key} className="ws-part">
            <input type="checkbox" checked={selected.has(p.key)} onChange={() => toggle(p.key)} />
            <span className="ws-label">{p.label}</span>
            <span className="ws-path">~/{p.path}</span>
            {p.sensitive && <span className="ws-warn">contains API keys</span>}
          </label>
        ))}
        <div className="cfg-hint" style={{ margin: "10px 0" }}>
          The current project's <code>.hermes/mission.json</code> (trackers, features, architecture) rides along automatically when the project lives under your home directory.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="send-btn" onClick={exportImage} disabled={busy}>⇪ export image…</button>
          <button className="tb-btn" onClick={importImage} disabled={busy}>⇩ import image…</button>
        </div>
        {(busy || log) && <pre className="git-output" style={{ marginTop: 12 }}>{busy ? "working…" : log}</pre>}
      </div>
    </div>
  );
}
