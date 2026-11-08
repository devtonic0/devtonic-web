import React, { useCallback, useEffect, useState } from "react";
import { projectRoot, bus, loadMission } from "../store.js";
import { copyText, reloadApp } from "../platform/web.js";

// Secrets: env files grouped into sections (frontend/backend/etc).
// Auto-scans the project recursively for any .env* file (bounded — ignores
// node_modules etc). Values masked by default; click to reveal, copy, edit, delete.
const fs = window.require("fs");
const path = window.require("path");
const os = window.require("os");

// Directories we never descend into (huge, no user env files worth reading).
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", "dist", "build", "out",
  ".venv", "venv", "__pycache__", ".cache", "coverage", ".pnpm-store",
  "target", ".yarn", ".nuxt", ".output", ".svelte-kit", ".astro",
  ".terraform", "release", "linux-unpacked",
]);

// Recognize files a dev would actually put env vars in.
function isEnvFile(name) {
  return /^\.env(\..+)?$/.test(name) || name === "env" || name === ".envrc";
}

// Depth-limited recursive walk. Returns absolute paths.
function findEnvFiles(root, maxDepth = 6, maxFiles = 40) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (e.name.startsWith(".") && e.name !== ".env.d" && e.name !== ".config") {
          // Skip dot dirs except an env dir we might want.
          continue;
        }
        walk(full, depth + 1);
      } else if (isEnvFile(e.name)) {
        out.push(full);
      }
    }
  }
  walk(root, 0);
  return out;
}

function detectSections(root) {
  const mission = loadMission(root);
  if (mission.secrets?.length) {
    return mission.secrets.map(s => ({
      name: s.name,
      file: path.isAbsolute(s.file) ? s.file : path.join(root, s.file),
    }));
  }
  const seen = new Set();
  const out = [];
  const push = (file, name) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ file, name });
  };
  // Always-visible project defaults, created lazily on first add.
  push(path.join(root, ".env"), `${path.basename(root)} · .env`);
  push(path.join(root, ".env.local"), `${path.basename(root)} · .env.local`);
  // Everything else we can actually find, recursively.
  for (const file of findEnvFiles(root)) {
    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    const label = parts.length === 1
      ? `${path.basename(root)} · ${rel}`
      : `${parts.slice(0, -1).join("/")} · ${parts[parts.length - 1]}`;
    push(file, label);
  }
  push(path.join(os.homedir(), ".hermes", ".env"), "hermes · global");
  return out;
}

const parse = text => text.split("\n").map((line, i) => {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  return m ? { key: m[1], value: m[2].replace(/^["']|["']$/g, ""), line: i } : null;
}).filter(Boolean);

const mask = v => (v.length <= 6 ? "•".repeat(v.length) : v.slice(0, 3) + "•".repeat(Math.min(v.length - 5, 18)) + v.slice(-2));

// Rewrite a single key's value in an env file, preserving all other lines.
// If the key doesn't exist, appends it. Escapes values containing whitespace/#
// with double quotes for shell-safe re-parse.
function writeVar(file, key, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const needsQuote = /[\s#"'`$]/.test(value);
  const escaped = needsQuote ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
  const lines = existing.split("\n");
  let found = false;
  const out = lines.map(line => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (m && m[2] === key) { found = true; return `${m[1]}${m[2]}=${escaped}`; }
    return line;
  });
  if (!found) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`${key}=${escaped}`);
  }
  fs.writeFileSync(file, out.join("\n"));
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

function deleteVar(file, key) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(line => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !m || m[1] !== key;
  });
  fs.writeFileSync(file, lines.join("\n"));
}

export default function Secrets() {
  const [sections, setSections] = useState(() => detectSections(projectRoot));
  const [active, setActive] = useState(0);
  const [vars, setVars] = useState([]);
  const [revealed, setRevealed] = useState(new Set());
  const [copied, setCopied] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [edit, setEdit] = useState(null); // { key, value }
  const [dirty, setDirty] = useState(false); // any write since panel opened → offer restart

  const load = useCallback((secs = sections, idx = active) => {
    const s = secs[idx];
    if (!s) { setVars([]); return; }
    try { setVars(fs.existsSync(s.file) ? parse(fs.readFileSync(s.file, "utf8")) : []); }
    catch { setVars([]); }
    setRevealed(new Set());
    setEdit(null);
  }, [sections, active]);

  useEffect(() => bus.on("project", root => {
    const secs = detectSections(root);
    setSections(secs);
    setActive(0);
    load(secs, 0);
    setDirty(false);
  }), [load]);

  // Rescan when Chat writes new env vars (e.g. modal just created <root>/.env).
  useEffect(() => bus.on("env-updated", ({ file }) => {
    const secs = detectSections(projectRoot);
    const idx = Math.max(0, secs.findIndex(s => s.file === file));
    setSections(secs);
    setActive(idx);
    load(secs, idx);
  }), [load]);

  useEffect(() => { load(); }, [active, load]);

  function copy(v, key) {
    copyText(v);
    setCopied(key);
    setTimeout(() => setCopied(""), 1200);
  }

  function saveEdit() {
    const s = sections[active];
    if (!s || !edit) return;
    writeVar(s.file, edit.key, edit.value);
    setEdit(null);
    setDirty(true);
    bus.emit("config-dirty", { reason: `secret ${edit.key} updated in ${path.basename(s.file)}` });
    load();
  }

  function addVar() {
    const s = sections[active];
    if (!s || !newKey.trim()) return;
    writeVar(s.file, newKey.trim(), newVal);
    setNewKey(""); setNewVal("");
    setDirty(true);
    bus.emit("config-dirty", { reason: `new secret ${newKey.trim()} added` });
    load();
  }

  function delVar(key) {
    const s = sections[active];
    if (!s) return;
    if (!confirm(`Delete ${key} from ${path.basename(s.file)}?`)) return;
    deleteVar(s.file, key);
    setDirty(true);
    bus.emit("config-dirty", { reason: `secret ${key} removed` });
    load();
  }

  function rescan() {
    const secs = detectSections(projectRoot);
    setSections(secs);
    setActive(Math.min(active, secs.length - 1));
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
        {!s && <div className="empty-hint">No env files found — create .env / .env.local in the project, or define `secrets` in devtonic.config.json.</div>}
        {s && (
          <>
            <div className="secrets-path">
              {s.file}
              {!fs.existsSync(s.file) && <span className="secrets-new"> · will be created on first add</span>}
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
