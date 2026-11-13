import React, { useEffect, useRef, useState } from "react";
import { bus } from "../store.js";

// Workers panel — live view of DETACHED background fix-workers (dispatched via
// ~/.hermes/scripts/dispatch-fix.sh). These outlive the Devtonic oneshot turn
// that launched them, so this panel is the only in-app window into what they're
// doing: live status, a streaming tail of the worker's output (its "thoughts +
// actions as it goes"), and the final git-verified report when done.
const fs = window.require("fs");
const path = window.require("path");
const os = window.require("os");
const { execFile } = window.require("child_process");

const ROOT = path.join(os.homedir(), ".hermes", "fix-workers");

// All reads go through fs.promises (fetch) so the 1.5–2 s polls never block
// the UI thread with synchronous XHR.
const fsp = fs.promises;

async function readText(p, tailBytes) {
  try {
    if (tailBytes) return fsp.readTail ? await fsp.readTail(p, tailBytes) : (await fsp.readFile(p, "utf8")).slice(-tailBytes);
    return await fsp.readFile(p, "utf8");
  } catch { return ""; }
}

async function readJSON(p) {
  try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return null; }
}

// Enumerate worker state dirs and read their status without blocking.
async function scanWorkers() {
  let names = [];
  try {
    names = (await fsp.readdir(ROOT, { withFileTypes: true }))
      .filter(d => d.isDirectory() && d.name !== "specs")
      .map(d => d.name);
  } catch { return []; }
  const rows = await Promise.all(names.map(async id => {
    const dir = path.join(ROOT, id);
    const [stateTxt, pidTxt, startedTxt, report] = await Promise.all([
      readText(path.join(dir, "state")), readText(path.join(dir, "worker.pid")),
      readText(path.join(dir, "started")), readJSON(path.join(dir, "report.json")),
    ]);
    const state = (stateTxt || "").trim();
    const pid = (pidTxt || "").trim();
    const started = parseInt((startedTxt || "0").trim(), 10) || 0;
    // Alive check: state says running AND the pid is live.
    let alive = false;
    if (state === "running" && pid) {
      try { process.kill(+pid, 0); alive = true; } catch { alive = false; }
    }
    return { id, dir, state, pid, started, report, alive };
  }));
  return rows.sort((a, b) => (b.started || 0) - (a.started || 0));
}

function fmtAgo(epoch) {
  if (!epoch) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Live output tail for a running (or finished) worker — the "thinking" stream.
// While running, prefer live.log (the tailed agent.log = step-by-step thoughts +
// tool activity, like the CLI feed). worker.out only gets the FINAL answer, so on
// completion we show that plus stderr. `hermes -z` writes nothing to stdout until
// the end, which is why a running worker needs live.log to look alive.
function WorkerTail({ dir, live }) {
  const [text, setText] = useState("");
  const preRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [liveLog, out, err] = await Promise.all([
        live ? readText(path.join(dir, "live.log"), 40000) : "",
        readText(path.join(dir, "worker.out"), 24000),
        readText(path.join(dir, "worker.err"), 6000),
      ]);
      if (cancelled) return;
      const body = (liveLog.trim() || out || "");
      setText(body + (err ? `\n\n─── stderr ───\n${err}` : ""));
    };
    load();
    const iv = setInterval(load, live ? 1500 : 10000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [dir, live]);
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [text]);
  return (
    <pre className="worker-tail" ref={preRef}>
      {text.trim() || "(no output yet — worker starting up)"}
    </pre>
  );
}

export default function Workers() {
  const [workers, setWorkers] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [, tick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => scanWorkers().then(w => { if (!cancelled) setWorkers(w); });
    refresh();
    const iv = setInterval(() => { refresh(); tick(x => x + 1); }, 2000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  function kill(pid) {
    if (!pid) return;
    execFile("kill", ["-15", String(pid)], () => setTimeout(() => scanWorkers().then(setWorkers), 600));
  }

  const open = workers.find(w => w.id === openId);

  return (
    <div className="panel-body">
      <div className="db-head">
        <span style={{ fontWeight: 600 }}>⚙ Background workers</span>
        <span style={{ marginLeft: "auto", opacity: 0.6, fontSize: 11 }}>
          {workers.filter(w => w.alive).length} running · {workers.length} total · auto-refresh 2s
        </span>
      </div>
      <div className="worker-layout">
        <div className="worker-list">
          {workers.length === 0 && (
            <div className="empty-hint">
              No workers yet. Dispatch one from chat:<br />
              <code>~/.hermes/scripts/dispatch-fix.sh FIX-6 &lt;workdir&gt; &lt;spec.md&gt;</code>
            </div>
          )}
          {workers.map(w => {
            const ok = w.report?.ok;
            const badge = w.alive ? "run" : w.report ? (ok ? "ok" : "fail") : "?";
            return (
              <button
                key={w.id}
                className={`worker-row ${w.id === openId ? "sel" : ""} ${w.alive ? "alive" : ""}`}
                onClick={() => setOpenId(w.id)}
              >
                <span className={`worker-badge ${badge}`}>
                  {w.alive ? <span className="dot busy" /> : <span className="dot" />}
                  {badge}
                </span>
                <span className="worker-id">{w.id}</span>
                <span className="worker-meta">
                  {w.alive ? `running ${fmtAgo(w.started)}` : w.report ? `${w.report.duration_s}s` : w.state}
                </span>
              </button>
            );
          })}
        </div>
        <div className="worker-detail">
          {!open && <div className="empty-hint">select a worker to see live output + report</div>}
          {open && (
            <>
              <div className="worker-detail-head">
                <b>{open.id}</b>
                <span className={`worker-badge ${open.alive ? "run" : open.report?.ok ? "ok" : open.report ? "fail" : "?"}`}>
                  {open.alive ? "running" : open.report ? (open.report.ok ? "done ✓" : `exit ${open.report.rc}`) : open.state}
                </span>
                {open.alive && (
                  <>
                    <span className="worker-meta">pid {open.pid} · {fmtAgo(open.started)}</span>
                    <button className="tb-btn" style={{ marginLeft: "auto", color: "var(--red)" }}
                            onClick={() => kill(open.pid)}>stop</button>
                  </>
                )}
              </div>

              {open.report && (
                <div className="worker-report">
                  <div className="worker-report-title">git state (source of truth)</div>
                  {(open.report.git || []).map(g => (
                    <div key={g.repo} className={`worker-git ${g.dirty > 0 ? "dirty" : ""}`}>
                      <span className="worker-git-repo">{g.repo}</span>
                      <span className="worker-git-branch">{g.branch}</span>
                      <span className="worker-git-dirty">{g.dirty > 0 ? `${g.dirty} uncommitted` : "clean"}</span>
                      <span className="worker-git-head" title={g.head}>{g.head}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="worker-report-title">
                {open.alive ? "live output — worker thoughts + actions" : "final output"}
              </div>
              <WorkerTail dir={open.dir} live={open.alive} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
