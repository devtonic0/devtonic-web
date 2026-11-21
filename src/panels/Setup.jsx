import React, { useEffect, useRef, useState } from "react";
import { hermesInfo, refreshHermes } from "../platform/hermes.js";
import { agentStatus, installSteps, systemToolsHint } from "../platform/onboarding-model.js";
import { copyText, openExternal } from "../platform/web.js";

// First-run setup wizard: detects missing dependencies (hermes, git, system
// tools), shows manual install instructions and can run the official
// installer. Shown on first launch when hermes isn't on the machine; later
// launches show the non-blocking AgentBanner instead (see App.jsx).
const { execFile, spawn } = window.require("child_process");

const PLATFORM = process.platform; // linux | darwin | win32

const which = cmd => new Promise(r => execFile(PLATFORM === "win32" ? "where" : "which", [cmd], e => r(!e)));

function Steps() {
  const [copied, setCopied] = useState(-1);
  return (
    <ol className="setup-steps">
      {installSteps(PLATFORM).map((s, i) => (
        <li key={i}>
          <div className="setup-step-label">{s.label}</div>
          {s.command && (
            <div className="setup-cmd">
              <code>{s.command}</code>
              <button className="tb-btn" title="Copy command"
                onClick={async () => { if (await copyText(s.command)) { setCopied(i); setTimeout(() => setCopied(-1), 1500); } }}>
                {copied === i ? "copied" : "copy"}
              </button>
            </div>
          )}
          {s.url && <a href={s.url} onClick={e => { e.preventDefault(); openExternal(s.url); }}>{s.url}</a>}
        </li>
      ))}
    </ol>
  );
}

export default function Setup({ onDone }) {
  const [checks, setChecks] = useState(null);
  const [agent, setAgent] = useState(() => agentStatus(hermesInfo()));
  const [installing, setInstalling] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [log, setLog] = useState("");
  const logRef = useRef(null);

  async function runChecks() {
    setRechecking(true);
    const a = agentStatus(await refreshHermes());
    const [git, python3, python, curl, tar] = await Promise.all(["git", "python3", "python", "curl", "tar"].map(which));
    setAgent(a);
    setChecks({ hermes: a.state === "ok", git, python: python3 || python, curl: curl || PLATFORM === "win32", tar });
    setRechecking(false);
  }

  useEffect(() => { runChecks(); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);

  function installHermes() {
    setInstalling(true);
    setLog("Installing Hermes Agent…\n");
    // Official installer: the first install step (curl | bash, or PowerShell on Windows).
    const command = installSteps(PLATFORM)[0].command;
    const [cmd, args] = PLATFORM === "win32" ? ["powershell", ["-Command", command]] : ["bash", ["-c", command]];
    const p = spawn(cmd, args, { env: { ...process.env } });
    p.stdout.on("data", d => setLog(l => l + d.toString()));
    p.stderr.on("data", d => setLog(l => l + d.toString()));
    p.on("close", code => {
      setInstalling(false);
      if (code === 0) {
        setLog(l => l + "\n✓ Installer finished. Run `hermes model` in the Terminal tab to pick your provider, or import a workspace image to bring everything from another machine.\n");
        // Re-resolve so Chat & co. spawn the freshly installed binary.
        runChecks();
      } else {
        setLog(l => l + `\n⚠️ Installer exited ${code}. Follow the manual steps above instead.\n`);
      }
    });
  }

  if (!checks) return null;
  const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  const toolsHint = systemToolsHint(PLATFORM, missing);

  return (
    <div className="modal-back">
      <div className="modal setup" data-testid="setup-wizard">
        <div className="modal-title">Devtonic — first-run setup</div>
        <div className="setup-checks">
          {Object.entries(checks).map(([k, ok]) => (
            <div key={k} className="setup-check">
              <span style={{ color: ok ? "var(--ok)" : "var(--red)" }}>{ok ? "✓" : "✕"}</span> {k}
              {k === "hermes" && ok && <span className="cfg-hint">{agent.detail}</span>}
              {k === "hermes" && !ok && <span className="ws-warn">required — the AI core</span>}
            </div>
          ))}
        </div>
        {agent.state !== "ok" && (
          <>
            <div className="setup-agent-msg"><b>{agent.title}.</b> {agent.detail}</div>
            <Steps />
            <div style={{ display: "flex", gap: 8 }}>
              {agent.state === "missing" && (
                <button className="send-btn" onClick={installHermes} disabled={installing}>
                  {installing ? "installing…" : "⇩ run the installer for me"}
                </button>
              )}
              <button className="tb-btn" onClick={runChecks} disabled={installing || rechecking}>
                {rechecking ? "checking…" : "↻ re-check"}
              </button>
            </div>
          </>
        )}
        {toolsHint && (
          <div className="cfg-hint" style={{ marginTop: 8 }}>
            Missing system tools — install via your package manager: <code>{toolsHint}</code>
          </div>
        )}
        {log && <pre className="git-output setup-log" ref={logRef}>{log}</pre>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="tb-btn" onClick={onDone} disabled={installing}>
            {checks.hermes ? "continue →" : "skip for now"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Non-blocking reminder shown after the wizard was skipped while the agent is
// still missing. Dismissal lasts until the next reload.
export function AgentBanner({ onOpenSetup, onDismiss }) {
  const [agent, setAgent] = useState(() => agentStatus(hermesInfo()));
  const [busy, setBusy] = useState(false);
  if (agent.state === "ok") return null;
  return (
    <div className="agent-banner" data-testid="agent-banner">
      <span style={{ color: "var(--warn)" }}>⚠</span>
      <span style={{ flex: 1 }}><b>{agent.title}.</b> {agent.detail}</span>
      <button className="send-btn" onClick={onOpenSetup}>install instructions</button>
      <button className="tb-btn" disabled={busy} onClick={async () => {
        setBusy(true);
        setAgent(agentStatus(await refreshHermes()));
        setBusy(false);
      }}>{busy ? "checking…" : "↻ re-check"}</button>
      <button className="tb-btn" title="Hide until next reload" onClick={onDismiss}>✕</button>
    </div>
  );
}
