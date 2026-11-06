import React, { useCallback, useEffect, useMemo, useState } from "react";

// Servers panel — the Hermes background-process registry, curated for
// dev servers (things like `pnpm dev`, `vite`, `next dev`, `uvicorn`, ...).
//
// Data source: ~/.hermes/processes.json (written by Hermes' process_registry
// on spawn/exit). We hydrate each entry with:
//   - liveness    (kill -0 pid)
//   - listening ports (ss -ltnp filtered by pid)
//   - resource use (ps -o pcpu,pmem,etime)
//   - last log lines (best-effort tail of matching Hermes log file, if any)
// and provide start/stop/restart/logs actions.

const fs = window.require("fs");
const os = window.require("os");
const path = window.require("path");
const { execFile } = window.require("child_process");

const REGISTRY = path.join(os.homedir(), ".hermes", "processes.json");
const LOG_DIR = path.join(os.homedir(), ".hermes", "logs");

// Heuristic: is this command a dev server we want in this panel?
// Everything else (grep, ls, one-off scripts) stays out.
const DEV_RE = /(pnpm|npm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)|vite|next(\s+dev)?|nodemon|uvicorn|gunicorn|flask\s+run|rails\s+s|hypercorn|astro|remix|nuxt|tsx watch|ts-node-dev|deno\s+task|turbo run dev|expo\s+start|django-admin runserver|manage\.py runserver|serve\s|http-server|live-server|python\s+-m\s+http\.server/i;

function readRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Async: is a pid alive? kill -0 doesn't send a signal, just tests permission.
function pidAlive(pid, cb) {
  execFile("kill", ["-0", String(pid)], (err) => cb(!err));
}

// Async: listening TCP ports for a pid (best-effort; requires ss).
function pidPorts(pid, cb) {
  execFile("ss", ["-ltnp"], { maxBuffer: 2e6 }, (_e, out) => {
    if (!out) return cb([]);
    const ports = new Set();
    for (const line of out.split("\n")) {
      if (!line.includes(`pid=${pid},`)) continue;
      // Local address column looks like "127.0.0.1:5173" or "[::1]:3000"
      const m = line.match(/\s(?:\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|\*):(\d+)\s/);
      if (m) ports.add(+m[1]);
    }
    cb([...ports].sort((a, b) => a - b));
  });
}

// Async: cpu%/mem%/etime for a pid via ps.
function pidStat(pid, cb) {
  execFile("ps", ["-o", "pcpu=,pmem=,etime=", "-p", String(pid)], (_e, out) => {
    const m = (out || "").trim().match(/([\d.]+)\s+([\d.]+)\s+(\S+)/);
    if (!m) return cb(null);
    cb({ cpu: +m[1], mem: +m[2], time: m[3] });
  });
}

function fmtCmd(cmd) {
  if (!cmd) return "";
  // Strip surrounding sh wrapper "bash -lc '<inner>'" that Hermes uses.
  const m = cmd.match(/^\S*sh\s+-l?c\s+['"](.*)['"]$/s);
  return (m ? m[1] : cmd).replace(/\s+/g, " ").trim();
}

function shortId(id) { return (id || "").split("_").pop()?.slice(0, 6) ?? ""; }

export default function Servers() {
  const [rows, setRows] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState("");
  const [msg, setMsg] = useState("");
  const [logOpen, setLogOpen] = useState(""); // session id whose log panel is open
  const [logText, setLogText] = useState("");

  const refresh = useCallback(() => {
    const entries = readRegistry();
    // hydrate each row asynchronously
    const hydrated = entries.map(e => ({ ...e, _alive: false, _ports: [], _stat: null }));
    setRows(hydrated);
    entries.forEach((e, i) => {
      if (!e.pid) return;
      pidAlive(e.pid, alive => {
        setRows(r => r.map((row, j) => j === i ? { ...row, _alive: alive } : row));
        if (alive) {
          pidPorts(e.pid, ports => setRows(r => r.map((row, j) => j === i ? { ...row, _ports: ports } : row)));
          pidStat(e.pid, stat => setRows(r => r.map((row, j) => j === i ? { ...row, _stat: stat } : row)));
        }
      });
    });
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, [refresh]);

  function stop(row, force) {
    if (!row.pid) return;
    setBusyId(row.session_id);
    execFile("kill", [force ? "-9" : "-15", String(row.pid)], err => {
      setBusyId("");
      setMsg(err ? `kill failed: ${err.message}` : `sent ${force ? "SIGKILL" : "SIGTERM"} → ${row.pid}`);
      setTimeout(refresh, 500);
    });
  }

  function restart(row) {
    if (!row.command) return;
    setBusyId(row.session_id);
    // Fire SIGTERM, wait 1.5s, respawn the same command in the same cwd.
    execFile("kill", ["-15", String(row.pid)], () => {
      setTimeout(() => {
        const { spawn } = window.require("child_process");
        try {
          const p = spawn("bash", ["-lc", row.command], {
            cwd: row.cwd || os.homedir(),
            detached: true,
            stdio: "ignore",
          });
          p.unref();
          setMsg(`restarted → new pid ${p.pid}`);
        } catch (e) {
          setMsg(`restart failed: ${e.message}`);
        }
        setBusyId("");
        setTimeout(refresh, 800);
      }, 1500);
    });
  }

  function copyCmd(row) {
    const { clipboard } = window.require("electron");
    clipboard.writeText(fmtCmd(row.command));
    setMsg("command copied");
    setTimeout(() => setMsg(""), 1200);
  }

  function toggleLog(row) {
    if (logOpen === row.session_id) {
      setLogOpen("");
      setLogText("");
      return;
    }
    setLogOpen(row.session_id);
    // Best-effort: agent.log filtered by session id; may be empty for
    // processes spawned outside a Hermes turn.
    const AGENT_LOG = path.join(LOG_DIR, "agent.log");
    execFile("bash", ["-lc", `tail -n 400 ${AGENT_LOG} 2>/dev/null | grep -F ${row.session_id} | tail -n 100`],
      { maxBuffer: 2e6 }, (_e, out) => {
        setLogText(out?.trim() || "(no log lines found for this process — Hermes only logs what ran inside an agent turn)");
      });
  }

  const shown = useMemo(() => rows
    .filter(r => showAll ? true : DEV_RE.test(fmtCmd(r.command)))
    .filter(r => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return fmtCmd(r.command).toLowerCase().includes(q) || String(r.pid).includes(q);
    }), [rows, showAll, query]);

  return (
    <div className="panel-body">
      <div className="db-head">
        <button className={`cfg-tool ${!showAll ? "on" : ""}`} onClick={() => setShowAll(a => !a)}>
          <span className="cfg-tool-dot" /> {showAll ? "all bg processes" : "dev servers only"}
        </button>
        <input className="db-filter" value={query} placeholder="filter…" onChange={e => setQuery(e.target.value)} />
        <button className="tb-btn" onClick={refresh}>↻ refresh</button>
      </div>
      <div className="db-scroll">
        {shown.length === 0 && (
          <div className="empty-hint">
            No {showAll ? "background processes" : "dev servers"} tracked.
            Hermes registers a process here whenever it runs one with <code>background=true</code>
            (e.g. <code>pnpm dev</code>, <code>uvicorn</code>). Ask Hermes to start your dev server
            and it'll show up.
          </div>
        )}
        {shown.map(r => {
          const cmd = fmtCmd(r.command);
          const cwdShort = (r.cwd || "").replace(os.homedir(), "~");
          const uptime = r._stat?.time || (r.started_at ? Math.floor((Date.now() / 1000 - r.started_at)) + "s" : "?");
          return (
            <div key={r.session_id} className="proc-row" style={{ flexWrap: "wrap", alignItems: "flex-start", padding: "8px 10px" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 110 }}>
                <span className="dot" style={{ background: r._alive ? "var(--ok)" : "var(--red)" }} />
                <span className="proc-pid">{r.pid ?? "—"}</span>
                <span className="tb-menu-dim" style={{ fontSize: 10 }}>{shortId(r.session_id)}</span>
              </span>
              <span style={{ flex: 1, minWidth: 260, display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="proc-cmd" style={{ fontFamily: "var(--mono)", fontSize: 12 }} title={r.command}>{cmd.slice(0, 200)}</span>
                <span className="tb-menu-dim" style={{ fontSize: 10 }}>{cwdShort}</span>
              </span>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", minWidth: 130, gap: 2 }}>
                {r._ports?.length > 0 ? (
                  <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {r._ports.map(p => (
                      <a key={p} className="tb-btn" style={{ padding: "2px 8px", color: "var(--accent)" }}
                         href="#" onClick={e => { e.preventDefault(); window.require("electron").shell.openExternal(`http://localhost:${p}`); }}
                         title={`open http://localhost:${p}`}>:{p}</a>
                    ))}
                  </span>
                ) : (
                  <span className="tb-menu-dim" style={{ fontSize: 10 }}>{r._alive ? "no listening ports" : "not running"}</span>
                )}
                {r._stat && (
                  <span className="tb-menu-dim" style={{ fontSize: 10, fontFamily: "var(--mono)" }}>
                    {r._stat.cpu.toFixed(0)}% cpu · {r._stat.mem.toFixed(1)}% mem · {uptime}
                  </span>
                )}
              </span>
              <span style={{ display: "flex", gap: 4 }}>
                <button className="tb-btn" disabled={!r._alive || busyId === r.session_id} onClick={() => stop(r, false)}>stop</button>
                <button className="tb-btn" disabled={!r.command || busyId === r.session_id} onClick={() => restart(r)}>↻</button>
                <button className="tb-btn" onClick={() => toggleLog(r)}>{logOpen === r.session_id ? "hide" : "logs"}</button>
                <button className="tb-btn" onClick={() => copyCmd(r)}>copy</button>
                {r._alive && <button className="tb-btn" style={{ color: "var(--red)" }} onClick={() => stop(r, true)}>kill</button>}
              </span>
              {logOpen === r.session_id && (
                <pre className="diff-pre" style={{ width: "100%", marginTop: 6, maxHeight: 200 }}>{logText}</pre>
              )}
            </div>
          );
        })}
      </div>
      <div className="db-foot">
        <span>{shown.length} shown · auto-refresh 4s · registry: ~/.hermes/processes.json</span>
        {msg && <span style={{ marginLeft: 10, color: "var(--ok)" }}>{msg}</span>}
      </div>
    </div>
  );
}
