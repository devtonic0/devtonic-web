import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeEditor from "./CodeEditor.jsx";
import { ghostComplete, fixProblem } from "../llm.js";
import { projectRoot, bus, scanTree, readFileSafe } from "../store.js";
import { hermesPath } from "../platform/hermes.js";

// Real code editor: CodeMirror 6 w/ syntax, autocomplete, emmet, linting,
// AI ghost completion, AI-driven fix suggestions, save-on-Ctrl+S. AI calls
// use the user's configured provider directly (see llm.js) — no Hermes loop.
const { execFile, spawn } = window.require("child_process");
const fsn = window.require("fs");
const os = window.require("os");
const pathMod = window.require("path");

// Packaged Electron loses PATH tweaks from ~/.bashrc, so re-inject common bin
// dirs so tsc/eslint/node/gh/etc. resolve when spawned.
const EXEC_ENV = {
  ...process.env,
  PATH: [
    pathMod.join(os.homedir(), ".local", "bin"),
    pathMod.join(os.homedir(), ".nvm", "current", "bin"),
    "/usr/local/bin", "/usr/bin", "/bin",
    process.env.PATH || "",
  ].filter(Boolean).join(":"),
};

export default function Code() {
  const [root, setRoot] = useState(projectRoot);
  const [tree, setTree] = useState(() => scanTree(projectRoot, 6, 2000));
  const [open, setOpen] = useState(() => new Set([projectRoot]));
  const [sel, setSel] = useState(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");   // last on-disk version — dirty check
  const [treeOpen, setTreeOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null);
  const [goLine, setGoLine] = useState(0);
  const [replaceVal, setReplaceVal] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [problems, setProblems] = useState(null);
  const [probBusy, setProbBusy] = useState(false);
  const [probH, setProbH] = useState(180);
  const [ghost, setGhost] = useState("");                 // AI suggestion preview
  const [aiStatus, setAiStatus] = useState("");           // last AI action feedback

  const dirty = content !== savedContent;

  useEffect(() => bus.on("project", r => {
    setRoot(r);
    setTree(scanTree(r, 6, 2000));
    setOpen(new Set([r]));
    setSel(null);
    setContent(""); setSavedContent("");
    setHits(null); setQuery("");
  }), []);

  useEffect(() => bus.on("open-file", p => {
    const [file, line] = String(p).split("::");
    selectFile(file, line ? Number(line) : 0);
  }), []);

  function selectFile(p, line = 0) {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setSel(p);
    const txt = readFileSafe(p);
    setContent(txt);
    setSavedContent(txt);
    setGoLine(line);
    setGhost("");
  }

  function save() {
    if (!sel) return;
    try {
      fsn.writeFileSync(sel, content);
      setSavedContent(content);
      setAiStatus("✓ saved");
      setTimeout(() => setAiStatus(""), 1500);
    } catch (e) {
      setAiStatus(`⚠️ ${e.message}`);
    }
  }

  // Ctrl+S / Cmd+S saves — bound at panel scope so it works from anywhere.
  useEffect(() => {
    const onKey = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Idle-triggered ghost completion: after 700ms of no typing, ask the LLM
  // for a short continuation at the end of the current line.
  const ghostTimer = useRef(null);
  useEffect(() => {
    if (!sel || !content) { setGhost(""); return; }
    clearTimeout(ghostTimer.current);
    ghostTimer.current = setTimeout(async () => {
      // Only trigger if last char is a letter, dot, or opening bracket —
      // strong signal the user's mid-token.
      const last = content.slice(-1);
      if (!/[a-zA-Z0-9._<{(\[]/.test(last)) return;
      try {
        const g = await ghostComplete({ path: sel, prefix: content, suffix: "" });
        if (g && g.length < 200) setGhost(g);
      } catch { /* silent — offline / no key etc */ }
    }, 700);
    return () => clearTimeout(ghostTimer.current);
  }, [content, sel]);

  const acceptGhost = () => {
    if (!ghost) return;
    setContent(c => c + ghost);
    setGhost("");
  };

  function search(q) {
    setQuery(q);
    if (!q.trim()) { setHits(null); return; }
    execFile("rg", ["-n", "--max-count", "4", "--max-columns", "160", "-g", "!node_modules", "-g", "!dist", "-g", "!.next", q, "."],
      { cwd: root, maxBuffer: 4e6, env: EXEC_ENV }, (err, out) => {
        if (err && !out) { setHits([]); return; }
        setHits(out.trim().split("\n").filter(Boolean).slice(0, 120).map(l => {
          const m = l.match(/^(.+?):(\d+):(.*)$/);
          return m ? { file: m[1], line: Number(m[2]), text: m[3].trim() } : null;
        }).filter(Boolean));
      });
  }

  function replaceAll() {
    if (!query.trim() || !hits?.length) return;
    const files = [...new Set(hits.map(h => root + "/" + h.file.replace(/^\.\//, "")))];
    let count = 0;
    for (const f of files) {
      try {
        const txt = fsn.readFileSync(f, "utf8");
        const next = txt.split(query).join(replaceVal);
        if (next !== txt) { count += txt.split(query).length - 1; fsn.writeFileSync(f, next); }
      } catch { /* skip unreadable */ }
    }
    search(query);
    if (sel) { const t = readFileSafe(sel); setContent(t); setSavedContent(t); }
    alert(`Replaced ${count} occurrence(s) across ${files.length} file(s).`);
  }

  function aiSearch() {
    if (!query.trim() || aiBusy) return;
    setAiBusy(true); setHits([]);
    const prompt = `You are a code-location service. In the repo at ${root}, find what the user asks for using your search/file tools. USER QUESTION: "${query}". Reply with ONLY matching locations, one per line, exact format: relative/path/to/file:LINE — short note. Max 10 lines, no other text.`;
    let out = "";
    const p = spawn(hermesPath(), ["--cli", "-z", prompt], { env: { ...process.env } });
    p.stdout.on("data", d => (out += d.toString()));
    p.on("close", () => {
      setAiBusy(false);
      const parsed = out.trim().split("\n")
        .map(l => l.match(/^([\w./~-]+):(\d+)\s*[—-]?\s*(.*)$/))
        .filter(Boolean)
        .map(m => ({ file: m[1], line: Number(m[2]), text: m[3] || "AI match" }));
      setHits(parsed);
    });
    p.on("error", () => setAiBusy(false));
  }

  function checkProblems() {
    setProbBusy(true); setProblems([]);
    const found = [];
    let toolsRun = 0;
    const finish = () => {
      setProbBusy(false);
      if (!toolsRun) {
        setProblems([{
          file: "(no linter)", line: 1, sev: "warn",
          text: "No tsconfig.json / eslint / package.json — install eslint or add tsconfig.json to run checks.",
        }]);
      } else {
        setProblems([...found]);
      }
    };
    const hasTs = fsn.existsSync(root + "/tsconfig.json");
    const hasEslint = fsn.existsSync(root + "/node_modules/.bin/eslint");
    const hasPkg = fsn.existsSync(root + "/package.json");
    const runEslint = () => {
      if (!hasEslint) return finish();
      toolsRun++;
      execFile(root + "/node_modules/.bin/eslint",
        [".", "--format", "json", "--ext", ".js,.jsx,.ts,.tsx"],
        { cwd: root, maxBuffer: 8e6, env: EXEC_ENV }, (_e, out) => {
          try {
            for (const f of JSON.parse(out || "[]")) {
              for (const msg of f.messages) {
                found.push({
                  file: f.filePath.replace(root + "/", ""), line: msg.line ?? 1,
                  sev: msg.severity === 2 ? "error" : "warn",
                  text: `${msg.message} (${msg.ruleId ?? "eslint"})`,
                });
              }
            }
          } catch { /* eslint output unparsable */ }
          finish();
        });
    };
    if (hasTs) {
      toolsRun++;
      const tsc = fsn.existsSync(root + "/node_modules/.bin/tsc") ? root + "/node_modules/.bin/tsc" : "npx";
      const args = tsc === "npx" ? ["tsc", "--noEmit", "--pretty", "false"] : ["--noEmit", "--pretty", "false"];
      execFile(tsc, args, { cwd: root, maxBuffer: 8e6, timeout: 60000, env: EXEC_ENV }, (_e, out) => {
        for (const line of (out || "").split("\n")) {
          const m = line.match(/^(.+?)\((\d+),\d+\): (error|warning) (TS\d+: .*)$/);
          if (m) found.push({ file: m[1], line: +m[2], sev: m[3] === "error" ? "error" : "warn", text: m[4] });
        }
        runEslint();
      });
    } else if (hasEslint) {
      runEslint();
    } else if (hasPkg) {
      // No tsconfig, no eslint bin — try `node --check` on the currently-open file
      // so we at least get syntax errors for the file being edited.
      if (sel && /\.(js|mjs|cjs)$/.test(sel)) {
        toolsRun++;
        execFile("node", ["--check", sel], { cwd: root, maxBuffer: 1e6, env: EXEC_ENV }, (_e, _o, err) => {
          const m = (err || "").match(/^(.+?):(\d+)/m);
          if (m) found.push({ file: m[1].replace(root + "/", ""), line: +m[2], sev: "error", text: err.trim().slice(0, 500) });
          finish();
        });
      } else {
        finish();
      }
    } else {
      finish();
    }
  }

  async function fixWithAi(p) {
    if (!p) return;
    const full = root + "/" + p.file;
    const src = fsn.readFileSync(full, "utf8");
    setAiStatus(`✨ fixing ${p.file}:${p.line}…`);
    try {
      const fixed = await fixProblem({ path: full, content: src, problem: p });
      if (!fixed || fixed === src) { setAiStatus("no changes suggested"); return; }
      fsn.writeFileSync(full, fixed);
      if (sel === full) { setContent(fixed); setSavedContent(fixed); }
      setAiStatus(`✓ patched ${p.file}`);
      setTimeout(() => checkProblems(), 400);   // re-run to see if it's gone
    } catch (e) {
      setAiStatus(`⚠️ ${e.message.slice(0, 120)}`);
    }
  }

  // Turn Problems into CodeMirror diagnostics for the current file only.
  const cmDiagnostics = useMemo(() => {
    if (!sel || !problems) return null;
    const rel = sel.replace(root + "/", "");
    const forFile = problems.filter(p => p.file === rel);
    if (!forFile.length) return [];
    // Convert line-based problems to editor offsets.
    const doc = content;
    const lineStarts = [0];
    for (let i = 0; i < doc.length; i++) if (doc[i] === "\n") lineStarts.push(i + 1);
    return forFile.map(p => {
      const lineIdx = Math.max(0, Math.min(lineStarts.length - 1, p.line - 1));
      const from = lineStarts[lineIdx];
      const to = lineStarts[lineIdx + 1] ? lineStarts[lineIdx + 1] - 1 : doc.length;
      return { from, to, severity: p.sev === "error" ? "error" : "warning", message: p.text };
    });
  }, [problems, sel, content, root]);

  function dragProblems(e) {
    e.preventDefault();
    const startY = e.clientY, startH = probH;
    const move = ev => setProbH(Math.min(500, Math.max(80, startH + (startY - ev.clientY))));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const byParent = useMemo(() => {
    const m = new Map();
    for (const l of tree.links) {
      if (!m.has(l.source)) m.set(l.source, []);
      m.get(l.source).push(tree.nodes.find(n => n.id === l.target));
    }
    for (const kids of m.values()) kids.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return m;
  }, [tree]);

  function renderDir(id, depth = 0) {
    const kids = byParent.get(id) ?? [];
    return kids.map(k => (
      <React.Fragment key={k.id}>
        <div
          className={`ft-item ${sel === k.id ? "sel" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => (k.dir ? setOpen(o => { const n = new Set(o); n.has(k.id) ? n.delete(k.id) : n.add(k.id); return n; }) : selectFile(k.id))}
        >
          <span style={{ opacity: .6, width: 10 }}>{k.dir ? (open.has(k.id) ? "▾" : "▸") : ""}</span>
          {k.name}
        </div>
        {k.dir && open.has(k.id) && renderDir(k.id, depth + 1)}
      </React.Fragment>
    ));
  }

  return (
    <div className="panel-body">
      <div className="code-path">
        <button className="tree-toggle" title={treeOpen ? "Collapse tree" : "Expand tree"} onClick={() => setTreeOpen(o => !o)}>
          {treeOpen ? "⇤" : "⇥"}
        </button>
        <span className="code-path-text">{sel ?? root}{dirty && <span className="dirty-dot" title="unsaved changes">●</span>}</span>
        {sel && (
          <>
            <button className={`tb-btn ${dirty ? "primary" : ""}`} onClick={save} disabled={!dirty} title="Ctrl+S">
              💾 save
            </button>
            {ghost && (
              <button className="tb-btn ghost-accept" onClick={acceptGhost} title="Tab to accept">
                ✨ accept ({ghost.slice(0, 24).replace(/\n/g, " ⏎ ")}…)
              </button>
            )}
          </>
        )}
        {aiStatus && <span className="ai-status">{aiStatus}</span>}
      </div>
      <div className="code-wrap">
        {treeOpen && (
          <div className="file-tree">
            <div className="tree-search">
              <button
                className={`tree-mode ${aiMode ? "ai" : ""}`}
                title={aiMode ? "AI search (ask in plain English)" : "Text search (ripgrep)"}
                onClick={() => { setAiMode(m => !m); setHits(null); }}
              >{aiMode ? "✨" : "⌕"}</button>
              <input
                value={query}
                placeholder={aiMode ? "ask: where is the css for the sign-in button?" : "search code…"}
                onChange={e => (aiMode ? setQuery(e.target.value) : search(e.target.value))}
                onKeyDown={e => aiMode && e.key === "Enter" && aiSearch()}
                spellCheck={false}
              />
              {!aiMode && hits !== null && (
                <button className="tb-btn" title="search & replace" onClick={() => setShowReplace(s => !s)}>⇄</button>
              )}
              {hits !== null && <button className="tb-btn" onClick={() => { setHits(null); setQuery(""); setShowReplace(false); }}>✕</button>}
            </div>
            {showReplace && hits !== null && !aiMode && (
              <div className="tree-search replace-row">
                <input value={replaceVal} placeholder="replace with…" onChange={e => setReplaceVal(e.target.value)} spellCheck={false} />
                <button className="send-btn replace-btn" onClick={replaceAll} disabled={!hits?.length}>
                  replace {hits?.length ?? 0}
                </button>
              </div>
            )}
            {aiMode && aiBusy && <div className="hits-count">✨ Hermes is searching…</div>}
            {hits === null ? renderDir(root) : (
              <>
                <div className="hits-count">{hits.length} matches</div>
                {hits.map((h, i) => (
                  <div key={i} className="ft-item hit-item" onClick={() => selectFile(root + "/" + h.file.replace(/^\.\//, ""), h.line)}>
                    <div className="hit-file">{h.file}:{h.line}</div>
                    <div className="hit-text">{h.text}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        <div className="code-view editable">
          {sel
            ? <CodeEditor path={sel} value={content} onChange={setContent}
                          diagnostics={cmDiagnostics} scrollLine={goLine} />
            : <div className="empty-hint">Select a file, search, or click a node in the 3D map.</div>}
        </div>
      </div>
      <div className="prob-bar">
        <button className="tb-btn" onClick={() => (problems === null ? checkProblems() : setProblems(null))}>
          {problems === null ? "▲ problems" : "▼ hide"}
        </button>
        {problems !== null && (
          <span className="prob-summary">
            {probBusy ? "checking…" : `${problems.filter(p => p.sev === "error").length} errors · ${problems.filter(p => p.sev === "warn").length} warnings`}
          </span>
        )}
        {problems !== null && !probBusy && <button className="tb-btn" onClick={checkProblems}>↻ re-run</button>}
      </div>
      {problems !== null && (
        <div className="prob-drawer" style={{ height: probH }}>
          <div className="prob-grip" onMouseDown={dragProblems} />
          {probBusy && <div className="empty-hint">running tsc / eslint…</div>}
          {!probBusy && problems.length === 0 && <div className="empty-hint">✓ no problems found</div>}
          {problems.map((p, i) => (
            <div key={i} className={`prob-row ${p.sev}`}>
              <span className="prob-sev" onClick={() => selectFile(root + "/" + p.file, p.line)}>{p.sev === "error" ? "✕" : "⚠"}</span>
              <span className="prob-file" onClick={() => selectFile(root + "/" + p.file, p.line)}>{p.file}:{p.line}</span>
              <span className="prob-text" onClick={() => selectFile(root + "/" + p.file, p.line)}>{p.text}</span>
              <button className="tb-btn ai-fix-btn" title="Fix with AI" onClick={() => fixWithAi(p)}>✨ fix</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
