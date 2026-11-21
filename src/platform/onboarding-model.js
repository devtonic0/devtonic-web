// First-run onboarding logic: decides when to show the setup wizard / the
// "agent missing" banner and what install instructions to offer. DOM-free and
// IO-free so it is unit-tested in test/onboarding-model.test.mjs.
//
// `info` is the bridge's Hermes resolution from /api/env
// (`{ path, source: "env" | "path" | "fallback" | "missing", found }`).

export const DOCS_URL = "https://hermes-agent.nousresearch.com/docs";
export const INSTALL_SH = "https://hermes-agent.nousresearch.com/install.sh";
export const INSTALL_PS1 = "https://hermes-agent.nousresearch.com/install.ps1";

// → { state: "ok" | "missing" | "bad-override", path, source, title, detail }
export function agentStatus(info) {
  const i = info || {};
  const path = i.path || "hermes";
  const source = i.source || "missing";
  if (i.found) {
    return { state: "ok", path, source, title: "Hermes agent found", detail: `${path} (${source === "env" ? "DEVTONIC_HERMES" : source === "path" ? "on PATH" : "common install dir"})` };
  }
  if (source === "env") {
    return {
      state: "bad-override", path, source,
      title: "DEVTONIC_HERMES points at a missing binary",
      detail: `DEVTONIC_HERMES=${path} is not an executable file. Fix the path (or unset it) and restart the server.`,
    };
  }
  return {
    state: "missing", path, source,
    title: "Hermes agent not found",
    detail: "Chat, auto-setup and the other AI features need the Hermes CLI. Install it, then re-check.",
  };
}

// Show the blocking wizard only on a real first run; after "skip for now"
// the non-blocking banner takes over until the agent appears.
export function shouldShowWizard({ setupDone, found }) {
  return !setupDone && !found;
}

export function shouldShowBanner({ setupDone, found, dismissed }) {
  return !!setupDone && !found && !dismissed;
}

// Manual install steps for the given platform (process.platform values).
// Each step: { label, command? , url? }.
export function installSteps(platform) {
  const steps = [];
  if (platform === "win32") {
    steps.push({ label: "Install Hermes Agent (PowerShell)", command: `iwr -useb ${INSTALL_PS1} | iex` });
  } else {
    steps.push({ label: "Install Hermes Agent", command: `curl -fsSL ${INSTALL_SH} | bash` });
    steps.push({ label: "Make sure the install dir is on PATH (then restart the server)", command: 'export PATH="$HOME/.local/bin:$PATH"' });
  }
  steps.push({ label: "Pick a model provider", command: "hermes model" });
  steps.push({
    label: "Or use another agent build (e.g. devtonic-agent): point the bridge at it",
    command: platform === "win32" ? "$env:DEVTONIC_HERMES=\"C:\\path\\to\\agent\"; npm start" : "DEVTONIC_HERMES=/path/to/agent npm start",
  });
  steps.push({ label: "Full documentation", url: DOCS_URL });
  return steps;
}

// Package-manager hint for missing system tools, or "" when none apply.
export function systemToolsHint(platform, missing) {
  const tools = (missing || []).filter(k => k !== "hermes");
  if (!tools.length) return "";
  if (platform === "darwin") return `brew install ${tools.map(t => (t === "python" ? "python3" : t)).join(" ")}`;
  if (platform === "win32") {
    const ids = { git: "Git.Git", python: "Python.Python.3", curl: "cURL.cURL", tar: "GnuWin32.Tar" };
    return `winget install ${tools.map(t => ids[t] || t).join(" ")}`;
  }
  return `sudo apt install ${tools.map(t => (t === "python" ? "python3" : t)).join(" ")}`;
}
