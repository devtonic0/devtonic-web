import React, { useCallback, useEffect, useRef, useState } from "react";
import { projectRoot, bus, loadMissionAsync } from "../store.js";
import { copyText, reloadApp } from "../platform/web.js";
import { detectSections, readVars, writeVar, deleteVar, mask } from "./secrets-model.js";

// Secrets: env files grouped into sections (frontend/backend/etc).
// Auto-scans the project recursively for any .env* file (bounded — ignores
// node_modules etc). Values masked by default; click to reveal, copy, edit, delete.
// All file IO is async (fs.promises) — see secrets-model.js.
const fs = window.require("fs");
const path = window.require("path");
const os = window.require("os");
const fsp = () => fs.promises;

async function scan(root) {
  const mission = await loadMissionAsync(root);
  return detectSections(fsp(), path, root, { mission, homedir: os.homedir() });
}

export default function Secrets() {
  const [sections, setSections] = useState([]);
  const [scanned, setScanned] = useState(false);
  const [active, setActive] = useState(0);
  const [vars, setVars] = useState([]);
  const [revealed, setRevealed] = useState(new Set());
  const [copied, setCopied] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [edit, setEdit] = useState(null); // { key, value }
  const [dirty, setDirty] = useState(false); // any write since panel opened → offer restart
  const seq = useRef(0);

  // Rescan sections; `pick(secs)` chooses the active index. Out-of-order
  // results (fast project switches) are dropped.
  const rescanWith = useCallback(async (root, pick) => {
    const my = ++seq.current;
    const secs = await scan(root).catch(() => []);
    if (my !== seq.current) return;
    setSections(secs);
    setScanned(true);
    setActive(pick(secs));
  }, []);

  const load = useCallback(async (s = sections[active]) => {
    setRevealed(new Set());
    setEdit(null);
    if (!s) { setVars([]); return; }
    try { setVars(await readVars(fsp(), s.file)); }
    catch { setVars([]); }
  }, [sections, active]);

  useEffect(() => { rescanWith(projectRoot, () => 0); }, [rescanWith]);

  useEffect(() => bus.on("project", root => {
    setDirty(false);
    rescanWith(root, () => 0);
  }), [rescanWith]);

  // Rescan when Chat writes new env vars (e.g. modal just created <root>/.env).
  useEffect(() => bus.on("env-updated", ({ file }) => {
    rescanWith(projectRoot, secs => Math.max(0, secs.findIndex(s => s.file === file)));
  }), [rescanWith]);

  useEffect(() => { load(); }, [load]);

  function copy(v, key) {
    copyText(v);
    setCopied(key);
    setTimeout(() => setCopied(""), 1200);
  }

  // After a write: mark the file as existing and reload its vars.
  async function afterWrite(s, reason) {
    setDirty(true);
    bus.emit("config-dirty", { reason });
    if (!s.exists) setSections(secs => secs.map(x => (x.file === s.file ? { ...x, exists: true } : x)));
    await load({ ...s, exists: true });
  }

  async function saveEdit() {
    const s = sections[active];
    if (!s || !edit) return;
    const { key, value } = edit;
    await writeVar(fsp(), path, s.file, key, value);
    await afterWrite(s, `secret ${key} updated in ${path.basename(s.file)}`);
  }

  async function addVar() {
    const s = sections[active];
    const key = newKey.trim();
    if (!s || !key) return;
    await writeVar(fsp(), path, s.file, key, newVal);
    setNewKey(""); setNewVal("");
    await afterWrite(s, `new secret ${key} added`);
  }

  async function delVar(key) {
    const s = sections[active];
    if (!s) return;
    if (!confirm(`Delete ${key} from ${path.basename(s.file)}?`)) return;
    await deleteVar(fsp(), s.file, key);
    await afterWrite(s, `secret ${key} removed`);
  }

  function rescan() {
    rescanWith(projectRoot, secs => Math.max(0, Math.min(active, secs.length - 1)));
  }

  const s = sections[active];

  return (
    <div className="panel-body">
      <div className="secrets-tabs">
        {sections.map((sec, i) => (
          <button key={sec.file} className={`tb-btn ${i === active ? "active" : ""}`} onClick={() => setActive(i)}>
            {sec.name}
          </button>
        ))}
        <button className="tb-btn" style={{ marginLeft: "auto" }} onClick={rescan} title="Rescan project for .env files">↻ scan</button>
      </div>
      {dirty && (
        <div className="cfg-hint" style={{
          margin: "8px 12px", padding: "8px 10px", background: "rgba(125,211,252,0.08)",
          border: "1px solid var(--accent)", borderRadius: 6,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ flex: 1 }}>Secrets changed. Reload Devtonic so new values are picked up everywhere.</span>
          <button className="send-btn" onClick={reloadApp}>↻ reload</button>
          <button className="tb-btn" onClick={() => setDirty(false)}>dismiss</button>
        </div>
      )}
      <div className="secrets-scroll">
        {!scanned && <div className="empty-hint">scanning…</div>}
        {scanned && !s && <div className="empty-hint">No env files found — create .env / .env.local in the project, or define `secrets` in devtonic.config.json.</div>}
        {s && (
          <>
            <div className="secrets-path">
              {s.file}
              {!s.exists && <span className="secrets-new"> · will be created on first add</span>}
            </div>
            {vars.length === 0 && (
              <div className="cfg-hint" style={{ marginBottom: 10 }}>
                No keys here yet — add one below, or ask Hermes to do something that needs a key (it'll pop the paste modal).
              </div>
            )}
            {vars.map(v => (
              <div key={v.key} className="secret-row">
                <span className="secret-key">{v.key}</span>
                {edit?.key === v.key ? (
                  <>
                    <input
                      autoFocus
                      className="secret-val"
                      style={{ background: "var(--bg2)", border: "1px solid var(--accent)", color: "var(--text)", padding: "3px 8px", fontFamily: "var(--mono)", fontSize: 12 }}
                      value={edit.value}
                      onChange={e => setEdit({ ...edit, value: e.target.value })}
                      onKeyDown={e => {
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") setEdit(null);
                      }}
                    />
                    <button className="send-btn" onClick={saveEdit}>save</button>
                    <button className="tb-btn" onClick={() => setEdit(null)}>cancel</button>
                  </>
                ) : (
                  <>
                    <button className="secret-val" title="click to reveal/hide" onClick={() =>
                      setRevealed(r => { const n = new Set(r); n.has(v.key) ? n.delete(v.key) : n.add(v.key); return n; })
                    }>
                      {revealed.has(v.key) ? v.value || "(empty)" : mask(v.value)}
                    </button>
                    <button className="tb-btn" onClick={() => setEdit({ key: v.key, value: v.value })}>edit</button>
                    <button className="tb-btn" onClick={() => copy(v.value, v.key)}>{copied === v.key ? "✓" : "copy"}</button>
                    <button className="tb-btn" style={{ color: "var(--red)" }} onClick={() => delVar(v.key)}>✕</button>
                  </>
                )}
              </div>
            ))}
            <div className="cfg-row" style={{ marginTop: 10 }}>
              <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="NEW_KEY" style={{ maxWidth: 200, fontFamily: "var(--mono)" }} />
              <input value={newVal} onChange={e => setNewVal(e.target.value)} placeholder="value" />
              <button className="send-btn" onClick={addVar} disabled={!newKey.trim()}>add</button>
            </div>
            <div className="cfg-hint" style={{ marginTop: 8 }}>Values stay on disk in the env file — nothing leaves this machine. Reveal/edit/copy/delete per key.</div>
          </>
        )}
      </div>
    </div>
  );
}
