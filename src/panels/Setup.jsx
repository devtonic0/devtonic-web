import React, { useEffect, useRef, useState } from "react";

// First-run setup wizard: detects missing dependencies (hermes, git, node
// runtime pieces) and installs them. Shown when hermes isn't on the machine.
const { execFile, spawn } = window.require("child_process");
const os = window.require("os");
const path = window.require("path");
const fs = window.require("fs");

const HERMES = path.join(os.homedir(), ".local", "bin", "hermes");
const PLATFORM = process.platform; // linux | darwin | win32

const which = cmd => new Promise(r => execFile(PLATFORM === "win32" ? "where" : "which", [cmd], e => r(!e)));

export default function Setup({ onDone }) {
  const [checks, setChecks] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState("");
  const logRef = useRef(null);

  useEffect(() => {
    (async () => {
      setChecks({
        hermes: fs.existsSync(HERMES) || (await which("hermes")),
        git: await which("git"),
        python: (await which("python3")) || (await which("python")),
        curl: (await which("curl")) || PLATFORM === "win32",
        tar: await which("tar"),
      });
    })();
  }, []);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);

  function installHermes() {
    setInstalling(true);
    setLog("Installing Hermes Agent…\n");
    // Official installer (curl | bash on unix; powershell on windows)
    const cmd = PLATFORM === "win32"
      ? ["powershell", ["-Command", "iwr -useb https://hermes-agent.nousresearch.com/install.ps1 | iex"]]
      : ["bash", ["-c", "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"]];
    const p = spawn(cmd[0], cmd[1], { env: { ...process.env } });
    p.stdout.on("data", d => setLog(l => l + d.toString()));
    p.stderr.on("data", d => setLog(l => l + d.toString()));
    p.on("close", code => {
      setInstalling(false);
      if (code === 0) {
        setLog(l => l + "\n✓ Hermes installed. Run `hermes model` in the Terminal tab to pick your provider, or import a workspace image to bring everything from another machine.\n");
        setChecks(c => ({ ...c, hermes: true }));
      } else {
        setLog(l => l + `\n⚠️ Installer exited ${code}. You can install manually: https://hermes-agent.nousresearch.com/docs\n`);
      }
    });
  }

  if (!checks) return null;
  const missing = Object.entries(checks).filter(([, ok]) => !ok);

  return (
    <div className="modal-back">
      <div className="modal setup">
        <div className="modal-title">Devtonic — first-run setup</div>
        <div className="setup-checks">
          {Object.entries(checks).map(([k, ok]) => (
            <div key={k} className="setup-check">
              <span style={{ color: ok ? "var(--ok)" : "var(--red)" }}>{ok ? "✓" : "✕"}</span> {k}
              {k === "hermes" && !ok && <span className="ws-warn">required — the AI core</span>}
            </div>
          ))}
        </div>
        {!checks.hermes && (
          <button className="send-btn" onClick={installHermes} disabled={installing}>
            {installing ? "installing…" : "⇩ install Hermes Agent"}
          </button>
        )}
        {missing.some(([k]) => k !== "hermes") && (
          <div className="cfg-hint" style={{ marginTop: 8 }}>
            Missing system tools — install via your package manager:
            {PLATFORM === "darwin" && <code> brew install git python3</code>}
            {PLATFORM === "linux" && <code> sudo apt install git python3 curl tar</code>}
            {PLATFORM === "win32" && <code> winget install Git.Git Python.Python.3</code>}
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
