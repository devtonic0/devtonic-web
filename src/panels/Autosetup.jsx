import React, { useEffect, useRef, useState } from "react";
import { hermesPath } from "../platform/hermes.js";

// Auto-setup modal: shown when a project is opened without .hermes/mission.json.
// Spawns Hermes with a prompt that tells it to scan the codebase and write a
// fully-populated mission.json (notes, todos, phases, features, architecture,
// clusterInfo). Live-tails agent.log for progress.
const { spawn } = window.require("child_process");
const os = window.require("os");
const path = window.require("path");
const fs = window.require("fs");

const AGENT_LOG = path.join(os.homedir(), ".hermes", "logs", "agent.log");

const SETUP_PROMPT = (root) => `You are setting up Devtonic Mission Control for an existing project.

Project root: ${root}

Task: scan the codebase and write a fully-populated ${root}/devtonic.config.json with the schema below. Use your file/terminal tools to read package.json, README, source layout, framework configs, git log, tests — whatever gives real signal. This is the source of truth the Devtonic UI reads to render phases, features, architecture, and cluster descriptions.

Schema (write the whole file, valid JSON):
{
  "notes": "<markdown> project purpose in one paragraph, then a short bullet list of what's here",
  "todos": [ { "id": "<uuid>", "text": "<actionable next step you inferred from the code>", "done": false } ],
  "phases": [ { "id": "p1|p2|p3|p4", "name": "<Plan|Build|Verify|Ship or your own labels>", "status": "done|active|pending" } ],
  "features": [ { "name": "<feature>", "desc": "<one line>", "status": "live|building|planned", "stack": ["<lib>", "..."] } ],
  "architecture": {
    "layers": [ { "name": "<Frontend|API|Data|...>", "items": [ { "name": "<component>", "detail": "<what it does>", "color": "<hex or hue name>" } ] } ]
  },
  "clusterInfo":  { "<top-level dir>": "<one-paragraph description shown on hover in the map>" },
  "clusterShort": { "<top-level dir>": "<3-5 word tag>" }
}

Rules:
- Include clusterInfo/clusterShort for EVERY top-level directory (src, lib, app, components, pages, api, public, supabase, electron, assets, etc.) that exists in this project.
- Features must reflect what actually exists in the code today (mark speculative work as "planned").
- Todos should be 3-6 concrete next steps you'd tackle after reading the code — real gaps, not busywork.
- Phases: mark whichever phase best fits the code's maturity as "active".
- Keep prose tight. Prefer inferring from code over guessing.

When done, ensure the file is valid JSON, then reply with exactly: SETUP DONE.`;

export default function Autosetup({ root, onDone, onCancel }) {
  const [status, setStatus] = useState("ready"); // ready|running|done|error
  const [log, setLog] = useState([]);
  const [output, setOutput] = useState("");
  const procRef = useRef(null);
  const tailRef = useRef(null);

  const hasExisting = fs.existsSync(path.join(root, "devtonic.config.json"))
                    || fs.existsSync(path.join(root, ".hermes", "mission.json"));

  useEffect(() => () => { procRef.current?.kill("SIGINT"); tailRef.current?.kill(); }, []);

  function start() {
    setStatus("running");
    setLog([]);
    const entries = [];
    const push = e => { entries.push(e); setLog([...entries]); };

    // tail agent.log for tool activity
    const tail = spawn("tail", ["-n", "0", "-F", AGENT_LOG]);
    tailRef.current = tail;
    tail.stdout.on("data", d => {
      for (const line of d.toString().split("\n")) {
        let m = line.match(/tool_executor: tool (\w+) completed \(([\d.]+)s/);
        if (m) push({ icon: "✓", text: `${m[1]} · ${m[2]}s` });
        m = line.match(/API call #(\d+):.*?latency=([\d.]+)s/);
        if (m) push({ icon: "◈", text: `thinking · step ${m[1]} · ${m[2]}s` });
      }
    });

    let out = "", err = "";
    const proc = spawn(hermesPath(), [
      "--cli", "-z", SETUP_PROMPT(root),
    ], { env: { ...process.env } });
    procRef.current = proc;
    proc.stdout.on("data", d => (out += d.toString()));
    proc.stderr.on("data", d => (err += d.toString()));
    proc.on("close", code => {
      tail.kill();
      procRef.current = null;
      tailRef.current = null;
      setOutput(out.trim() || err.trim() || `(no output, exit ${code})`);
      // success if devtonic.config.json now exists with expected keys
      try {
        const nu = path.join(root, "devtonic.config.json");
        const legacy = path.join(root, ".hermes", "mission.json");
        const file = fs.existsSync(nu) ? nu : legacy;
        const m = JSON.parse(fs.readFileSync(file, "utf8"));
        if (m.features || m.architecture || m.clusterInfo) return setStatus("done");
      } catch {}
      setStatus(code === 0 && /SETUP DONE/.test(out) ? "done" : "error");
    });
    proc.on("error", e => {
      setStatus("error");
      setOutput(`⚠️ Failed to launch hermes: ${e.message}`);
    });
  }

  function skip() {
    // write minimal stub so we don't re-prompt every time the folder opens
    fs.mkdirSync(path.join(root, ".hermes"), { recursive: true });
    fs.writeFileSync(path.join(root, ".hermes", "mission.json"), JSON.stringify({
      notes: `# ${path.basename(root)}\n\nAuto-setup skipped. Ask Hermes in chat to populate this file when ready.`,
      todos: [], phases: [{ id: "p1", name: "Explore", status: "active" }], features: [],
    }, null, 2));
    onDone();
  }

  return (
    <div className="modal-back">
      <div className="modal" style={{ minWidth: 520, maxWidth: 680 }}>
        <div className="modal-title">✨ {hasExisting ? "Re-scan" : "Set up"} <code>{path.basename(root)}</code></div>
        <div className="cfg-hint" style={{ marginBottom: 10 }}>
          {hasExisting
            ? <>This will overwrite <code>.hermes/mission.json</code> by re-scanning the codebase.</>
            : <>No <code>.hermes/mission.json</code> here yet. Hermes will scan the codebase and populate features,
              architecture, phases, todos, and cluster labels.</>}
          {" "}Takes ~30-90s.
        </div>

        {status === "ready" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="send-btn" onClick={start}>✨ scan & populate</button>
            <button className="tb-btn" onClick={skip}>skip (empty stub)</button>
            <button className="tb-btn" onClick={onCancel}>cancel</button>
          </div>
        )}

        {status === "running" && (
          <>
            <div className="cfg-hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="dot busy" /> Hermes is reading your code…
            </div>
            <div className="activity-body" style={{ maxHeight: 260, overflow: "auto", marginTop: 8 }}>
              {log.length === 0 && <div className="act-line think"><span className="act-icon">…</span> starting up</div>}
              {log.map((e, i) => (
                <div key={i} className="act-line"><span className="act-icon">{e.icon}</span> {e.text}</div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="tb-btn" onClick={() => { procRef.current?.kill("SIGINT"); setStatus("error"); }}>stop</button>
            </div>
          </>
        )}

        {status === "done" && (
          <>
            <div className="cfg-hint" style={{ color: "var(--ok)" }}>✓ mission.json populated — panels will reload.</div>
            <button className="send-btn" style={{ marginTop: 10 }} onClick={onDone}>open project</button>
          </>
        )}

        {status === "error" && (
          <>
            <div className="cfg-hint" style={{ color: "var(--warn)" }}>⚠️ Setup didn't complete.</div>
            <pre className="git-output" style={{ maxHeight: 200, overflow: "auto", marginTop: 6 }}>{output.slice(-2000)}</pre>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="tb-btn" onClick={() => setStatus("ready")}>retry</button>
              <button className="tb-btn" onClick={skip}>skip (empty stub)</button>
              <button className="tb-btn" onClick={onCancel}>cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
