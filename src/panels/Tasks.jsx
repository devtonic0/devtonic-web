import React, { useCallback, useEffect, useState } from "react";
import { listProcesses } from "../platform/procs.js";
import { hermesPath } from "../platform/hermes.js";

// AI Tasks: scheduled cron jobs + currently-running Hermes/agent processes.
// Cron: pause/resume/run-now/remove via `hermes cron`. Running: SIGINT via kill.
const { execFile } = window.require("child_process");
const os = window.require("os");
const path = window.require("path");
const fs = window.require("fs");

const JOBS_PATH = path.join(os.homedir(), ".hermes", "cron", "jobs.json");
const OUT_DIR = path.join(os.homedir(), ".hermes", "cron", "output");

const AGENT_RE = /hermes.*(?:--cli|-z |chat|--continue)|cron_run|delegated_task/i;

function loadJobs() {
  try { return JSON.parse(fs.readFileSync(JOBS_PATH, "utf8")).jobs ?? []; }
  catch { return []; }
}

function fetchRunning(cb) {
  listProcesses({ fields: ["pid", "time", "cmd"], sort: "start" },
    rows => cb(rows.filter(p => AGENT_RE.test(p.cmd))));
}

function lastOutput(id) {
  try {
    const files = fs.readdirSync(OUT_DIR)
      .filter(f => f.startsWith(id + "_") && f.endsWith(".txt"))
      .sort().reverse();
    if (!files[0]) return null;
    const full = path.join(OUT_DIR, files[0]);
    return { file: full, text: fs.readFileSync(full, "utf8"), at: fs.statSync(full).mtime };
  } catch { return null; }
}

const rel = ts => {
  if (!ts) return "—";
  const d = (new Date(ts) - Date.now()) / 1000;
  const abs = Math.abs(d), s = d < 0 ? "ago" : "in";
  if (abs < 60) return `${s} ${Math.round(abs)}s`;
  if (abs < 3600) return `${s} ${Math.round(abs / 60)}m`;
  if (abs < 86400) return `${s} ${Math.round(abs / 3600)}h`;
  return `${s} ${Math.round(abs / 86400)}d`;
};

export default function Tasks() {
  const [jobs, setJobs] = useState(loadJobs);
  const [running, setRunning] = useState([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [expanded, setExpanded] = useState(null); // job id
  const [tab, setTab] = useState("all"); // all|scheduled|running

  const refresh = useCallback(() => {
    setJobs(loadJobs());
    fetchRunning(setRunning);
  }, []);
  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 4000);
    return () => clearInterval(iv);
  }, [refresh]);

  function cronCmd(action, id, label) {
    setBusy(`${action} ${id.slice(0, 6)}…`);
    execFile(hermesPath(), ["cron", action, id], { timeout: 30000 }, (err, out, errOut) => {
      setBusy("");
      setMsg(err ? `⚠️ ${errOut || err.message}` : `✓ ${label || action} · ${id.slice(0, 6)}`);
      refresh();
    });
  }
  function killProc(pid, force) {
    execFile("kill", [force ? "-9" : "-15", String(pid)], () => {
      setMsg(`sent ${force ? "SIGKILL" : "SIGINT"} to ${pid}`);
      setTimeout(refresh, 500);
    });
  }

  const scheduled = jobs.filter(j => j.enabled || j.state === "running");
  const paused = jobs.filter(j => !j.enabled && j.state !== "running");
  const showSched = tab !== "running";
  const showRun = tab !== "scheduled";

  return (
    <div className="panel-body">
      <div className="db-head">
        <button className={`cfg-tool ${tab === "all" ? "on" : ""}`} onClick={() => setTab("all")}>
          <span className="cfg-tool-dot" /> all
        </button>
        <button className={`cfg-tool ${tab === "scheduled" ? "on" : ""}`} onClick={() => setTab("scheduled")}>
          <span className="cfg-tool-dot" /> scheduled · {jobs.length}
        </button>
        <button className={`cfg-tool ${tab === "running" ? "on" : ""}`} onClick={() => setTab("running")}>
          <span className="cfg-tool-dot" /> running · {running.length}
        </button>
        <div style={{ flex: 1 }} />
        <button className="tb-btn" onClick={refresh}>↻ refresh</button>
      </div>
      <div className="db-scroll">
        {showRun && (
          <>
            <div className="git-section">running now · {running.length}</div>
            {running.length === 0 && <div className="empty-hint">no active agent tasks</div>}
            {running.map(p => (
              <div key={p.pid} className="task-row live">
                <div className="task-head">
                  <span className="task-dot busy" />
                  <span className="task-name">agent · pid {p.pid}</span>
                  <span className="task-meta">running {p.time}</span>
                  <div style={{ flex: 1 }} />
                  <button className="tb-btn" title="SIGINT (graceful)" onClick={() => killProc(p.pid, false)}>stop</button>
                  <button className="tb-btn" style={{ color: "var(--red)" }} title="SIGKILL"
                    onClick={() => killProc(p.pid, true)}>kill</button>
                </div>
                <div className="task-cmd" title={p.cmd}>{p.cmd}</div>
              </div>
            ))}
          </>
        )}

        {showSched && scheduled.length > 0 && (
          <>
            <div className="git-section">active schedules · {scheduled.length}</div>
            {scheduled.map(j => <Job key={j.id} job={j} expanded={expanded === j.id}
              onToggle={() => setExpanded(e => e === j.id ? null : j.id)}
              onCron={cronCmd} busy={busy} />)}
          </>
        )}
        {showSched && paused.length > 0 && (
          <>
            <div className="git-section">paused · {paused.length}</div>
            {paused.map(j => <Job key={j.id} job={j} expanded={expanded === j.id}
              onToggle={() => setExpanded(e => e === j.id ? null : j.id)}
              onCron={cronCmd} busy={busy} />)}
          </>
        )}
        {showSched && jobs.length === 0 && <div className="empty-hint">no scheduled jobs · <code>hermes cron create …</code></div>}
      </div>
      <div className="db-foot">
        <span>auto-refreshes 4s · cron via <code>hermes cron</code></span>
        {busy && <span style={{ marginLeft: 10, color: "var(--warn)" }}>{busy}</span>}
        {msg && <span style={{ marginLeft: 10, color: "var(--ok)" }}>{msg}</span>}
      </div>
    </div>
  );
}

function Job({ job: j, expanded, onToggle, onCron, busy }) {
  const out = expanded ? lastOutput(j.id) : null;
  const running = j.state === "running";
  return (
    <div className={`task-row ${running ? "live" : j.enabled ? "" : "off"}`}>
      <div className="task-head" onClick={onToggle}>
        <span className={`task-dot ${running ? "busy" : j.enabled ? "ok" : ""}`} />
        <span className="task-name">{j.name || j.id}</span>
        <span className="task-meta">
          {j.schedule_display} · next {rel(j.next_run_at)}
          {j.last_run_at && <> · last {rel(j.last_run_at)}{j.last_status === "error" && " ⚠️"}</>}
          {j.repeat?.completed > 0 && <> · {j.repeat.completed} runs</>}
        </span>
        <div style={{ flex: 1 }} />
        <span className="chev" style={{ transform: expanded ? "rotate(90deg)" : "" }}>▸</span>
      </div>
      <div className="task-actions">
        <button className="tb-btn" disabled={!!busy} onClick={() => onCron("run", j.id, "queued")}>▶ run now</button>
        <button className="tb-btn" disabled={!!busy}
          onClick={() => onCron(j.enabled ? "pause" : "resume", j.id, j.enabled ? "paused" : "resumed")}>
          {j.enabled ? "⏸ pause" : "▶ resume"}
        </button>
        <button className="tb-btn" disabled={!!busy} style={{ color: "var(--red)" }}
          onClick={() => window.confirm(`Delete cron "${j.name}"?`) && onCron("remove", j.id, "removed")}>
          ✕ remove
        </button>
      </div>
      {expanded && (
        <div className="task-body">
          <div className="cfg-hint" style={{ whiteSpace: "pre-wrap", maxHeight: 140, overflow: "auto" }}>
            {j.prompt?.slice(0, 800)}{j.prompt?.length > 800 ? "…" : ""}
          </div>
          {j.skills?.length > 0 && (
            <div className="cfg-hint">skills: {j.skills.join(", ")}</div>
          )}
          {j.workdir && <div className="cfg-hint">workdir: <code>{j.workdir}</code></div>}
          {out ? (
            <>
              <div className="cfg-hint" style={{ marginTop: 6 }}>
                last output ({rel(out.at)}) — <code>{out.file}</code>
              </div>
              <pre className="git-output" style={{ maxHeight: 200, overflow: "auto" }}>
                {out.text.slice(0, 4000)}{out.text.length > 4000 ? "\n…" : ""}
              </pre>
            </>
          ) : (
            <div className="cfg-hint" style={{ marginTop: 6 }}>no output yet</div>
          )}
        </div>
      )}
    </div>
  );
}
