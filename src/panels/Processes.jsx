import React, { useCallback, useEffect, useState } from "react";

// Processes: live view of background/dev processes with kill buttons.
// "dev" filter = node/npm/electron/vite/next/python servers; "all" = everything yours.
const { execFile } = window.require("child_process");

const DEV_RE = /node|npm|electron|vite|next|python|uvicorn|flask|cargo|go run|devtonic|hermes/i;
const SELF_RE = /ps -eo|Processes panel/;

function fetchProcs(cb) {
  execFile("ps", ["-eo", "pid,pcpu,pmem,etime,args", "--sort=-pcpu", "--no-headers", "-u", process.env.USER || ""],
    { maxBuffer: 4e6 }, (_e, out) => {
      const rows = (out || "").split("\n").filter(Boolean).map(l => {
        const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
        return m ? { pid: +m[1], cpu: +m[2], mem: +m[3], time: m[4], cmd: m[5] } : null;
      }).filter(Boolean).filter(p => !SELF_RE.test(p.cmd));
      cb(rows);
    });
}

export default function Processes() {
  const [procs, setProcs] = useState([]);
  const [devOnly, setDevOnly] = useState(true);
  const [query, setQuery] = useState("");
  const [confirmPid, setConfirmPid] = useState(null);
  const [msg, setMsg] = useState("");

  const refresh = useCallback(() => fetchProcs(setProcs), []);
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  function kill(pid, force) {
    execFile("kill", [force ? "-9" : "-15", String(pid)], () => {
      setMsg(`sent ${force ? "SIGKILL" : "SIGTERM"} to ${pid}`);
      setConfirmPid(null);
      setTimeout(refresh, 600);
    });
  }

  const shown = procs
    .filter(p => (devOnly ? DEV_RE.test(p.cmd) : true))
    .filter(p => (query.trim() ? p.cmd.toLowerCase().includes(query.toLowerCase()) || String(p.pid).includes(query) : true))
    .slice(0, 60);

  return (
    <div className="panel-body">
      <div className="db-head">
        <button className={`cfg-tool ${devOnly ? "on" : ""}`} onClick={() => setDevOnly(d => !d)}>
          <span className="cfg-tool-dot" /> dev only
        </button>
        <input className="db-filter" value={query} placeholder="filter by name or pid…" onChange={e => setQuery(e.target.value)} />
        <button className="tb-btn" onClick={refresh}>↻ refresh</button>
      </div>
      <div className="db-scroll">
        {shown.length === 0 && <div className="empty-hint">no matching processes</div>}
        {shown.map(p => (
          <div key={p.pid} className="proc-row">
            <span className="proc-pid">{p.pid}</span>
            <span className={`proc-cpu ${p.cpu > 50 ? "hot" : ""}`}>{p.cpu.toFixed(0)}%</span>
            <span className="proc-mem">{p.mem.toFixed(1)}%</span>
            <span className="proc-time">{p.time}</span>
            <span className="proc-cmd" title={p.cmd}>{p.cmd.slice(0, 130)}</span>
            {confirmPid === p.pid ? (
              <span className="proc-confirm">
                <button className="tb-btn" onClick={() => kill(p.pid, false)}>term</button>
                <button className="tb-btn" style={{ color: "var(--red)" }} onClick={() => kill(p.pid, true)}>force</button>
                <button className="tb-btn" onClick={() => setConfirmPid(null)}>✕</button>
              </span>
            ) : (
              <button className="db-del" title="kill process" onClick={() => setConfirmPid(p.pid)}>✕</button>
            )}
          </div>
        ))}
      </div>
      <div className="db-foot">
        <span>{shown.length} shown · CPU/MEM as % · auto-refreshes 5s</span>
        {msg && <span style={{ marginLeft: 10, color: "var(--ok)" }}>{msg}</span>}
      </div>
    </div>
  );
}
