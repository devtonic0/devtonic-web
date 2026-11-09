import React, { useEffect, useRef, useState } from "react";
import DockLayout from "rc-dock";
import "rc-dock/dist/rc-dock.css";
import Chat from "./panels/Chat.jsx";
import Map3D from "./panels/Map3D.jsx";
import Flow from "./panels/Flow.jsx";
import Progress from "./panels/Progress.jsx";
import Notes from "./panels/Notes.jsx";
import Code from "./panels/Code.jsx";
import Browser from "./panels/Browser.jsx";
import Terminal from "./panels/Terminal.jsx";
import Git from "./panels/Git.jsx";
import Architecture from "./panels/Architecture.jsx";
import FeatureMap from "./panels/FeatureMap.jsx";
import Config from "./panels/Config.jsx";
import Secrets from "./panels/Secrets.jsx";
import Usage from "./panels/Usage.jsx";
import Workspace from "./panels/Workspace.jsx";
import Setup from "./panels/Setup.jsx";
import Database from "./panels/Database.jsx";
import Settings from "./panels/Settings.jsx";
import Help from "./panels/Help.jsx";
import Processes from "./panels/Processes.jsx";
import Workers from "./panels/Workers.jsx";
import Servers from "./panels/Servers.jsx";
import Tasks from "./panels/Tasks.jsx";
import Autosetup from "./panels/Autosetup.jsx";
import { bus } from "./store.js";
import { projectRoot, setProject, recentProjects, loadSettings, saveSettings } from "./store.js";
import logoUrl from "../assets/logo-small.png";

import { pickFolder, reloadApp, setUiScale, notify } from "./platform/web.js";
import { hermesFound } from "./platform/hermes.js";

const TABS = {
  chat: { id: "chat", title: "⚡ Hermes", content: <Chat />, closable: true },
  usage: { id: "usage", title: "◔ Usage", content: <Usage />, closable: true },
  tasks: { id: "tasks", title: "⚡ Tasks", content: <Tasks />, closable: true },
  workers: { id: "workers", title: "⚙ Workers", content: <Workers />, closable: true },
  procs: { id: "procs", title: "⚙ Processes", content: <Processes />, closable: true },
  servers: { id: "servers", title: "🚀 Servers", content: <Servers />, closable: true },
  map: { id: "map", title: "🌐 Map", content: <Map3D />, closable: true },
  browser: { id: "browser", title: "◎ Browser", content: <Browser />, closable: true },
  arch: { id: "arch", title: "🏛 Architecture", content: <Architecture />, closable: true },
  features: { id: "features", title: "🧩 Features", content: <FeatureMap />, closable: true },
  flow: { id: "flow", title: "🗺 Flow", content: <Flow />, closable: true },
  progress: { id: "progress", title: "▣ Progress", content: <Progress />, closable: true },
  terminal: { id: "terminal", title: "❯ Terminal", content: <Terminal />, closable: true },
  git: { id: "git", title: "⎇ Git", content: <Git />, closable: true },
  notes: { id: "notes", title: "✎ Notes", content: <Notes />, closable: true },
  code: { id: "code", title: "⌥ Code", content: <Code />, closable: true },
  config: { id: "config", title: "⚙ Config", content: <Config />, closable: true },
  secrets: { id: "secrets", title: "🔑 Secrets", content: <Secrets />, closable: true },
  workspace: { id: "workspace", title: "⇪ Workspace", content: <Workspace />, closable: true },
  database: { id: "database", title: "🗄 Database", content: <Database />, closable: true },
  settings: { id: "settings", title: "⚙ Settings", content: <Settings />, closable: true },
  help: { id: "help", title: "? Help", content: <Help />, closable: true },
};

const DEFAULT_LAYOUT = {
  dockbox: {
    mode: "horizontal",
    children: [
      { mode: "vertical", size: 340, children: [{ tabs: [TABS.chat, TABS.tasks, TABS.workers, TABS.usage, TABS.servers, TABS.procs] }] },
      {
        mode: "vertical",
        size: 640,
        children: [
          { tabs: [TABS.map, TABS.browser, TABS.arch, TABS.features] },
          { size: 260, tabs: [TABS.progress, TABS.terminal, TABS.git, TABS.database, TABS.flow, TABS.notes] },
        ],
      },
      { mode: "vertical", size: 460, children: [{ tabs: [TABS.code, TABS.config, TABS.secrets] }] },
    ],
  },
};

// Global restart banner — surfaces whenever any panel emits `config-dirty`.
// Config panel emits it after `hermes config set`; Secrets emits it after
// any env-file edit; extend anywhere else you save state that requires re-init.
function RestartBanner() {
  const [reason, setReason] = React.useState("");
  React.useEffect(() => bus.on("config-dirty", ({ reason }) => setReason(reason || "settings changed")), []);
  if (!reason) return null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "8px 14px", background: "rgba(125,211,252,0.10)",
      borderBottom: "1px solid var(--accent)", color: "var(--text)", fontSize: 12,
    }}>
      <span style={{ color: "var(--accent)" }}>↻</span>
      <span style={{ flex: 1 }}>{reason} — reload Devtonic to apply everywhere.</span>
      <button className="send-btn" onClick={reloadApp}>Reload now</button>
      <button className="tb-btn" onClick={() => setReason("")}>Later</button>
    </div>
  );
}

export default function App() {
  const dockRef = useRef(null);
  useEffect(() => {
    const z = loadSettings().uiScale;
    if (z && z !== 100) setUiScale(z);
    // Notification permission is requested from Settings → notifications,
    // because browsers only allow the prompt from a user gesture.
  }, []);

  // Global background-worker completion poller. Detached fix-workers (dispatched
  // via ~/.hermes/scripts/dispatch-fix.sh) outlive the chat turn that launched
  // them and drop a report.json when done. We watch for NEW reports and surface
  // them right in the chat stream + an OS notification — so worker results land
  // in-app, not only in Telegram. Dedup by report file mtime we've already seen.
  useEffect(() => {
    const fsn = window.require("fs");
    const pth = window.require("path");
    const oss = window.require("os");
    const ROOT = pth.join(oss.homedir(), ".hermes", "fix-workers");
    const seen = loadSettings().workerReportsSeen ?? {};
    let stopped = false;
    // Prime the seen-set on first run so we don't replay old reports as "new".
    let primed = false;
    const tick = () => {
      if (stopped) return;
      let dirs = [];
      try {
        dirs = fsn.readdirSync(ROOT, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name !== "specs").map(d => d.name);
      } catch { return; }
      const store = loadSettings().workerReportsSeen ?? {};
      let changed = false;
      for (const id of dirs) {
        const rp = pth.join(ROOT, id, "report.json");
        let mtime = 0;
        try { mtime = Math.floor(fsn.statSync(rp).mtimeMs); } catch { continue; }
        if (store[id] === mtime) continue;      // already surfaced this report
        changed = true;
        store[id] = mtime;
        if (primed && !stopped) {
          let rep = null;
          try { rep = JSON.parse(fsn.readFileSync(rp, "utf8")); } catch {}
          if (rep) {
            const ok = rep.ok;
            const git = (rep.git || [])
              .map(g => `${g.repo}: ${g.dirty > 0 ? g.dirty + " uncommitted" : "clean"} — ${g.head}`)
              .join("\n");
            const text = `${ok ? "✅" : "⚠️"} **${rep.fix_id}** worker finished (rc=${rep.rc}, ${rep.duration_s}s)\n\n${rep.summary || ""}\n\n**git state:**\n${git}`;
            bus.emit("worker-report", { id, text, ok });
            if (loadSettings().workerNotifications !== false) {
              notify(`${ok ? "✅" : "⚠️"} ${rep.fix_id} worker done`, {
                body: rep.summary || "",
                tag: `worker-${id}`,
                onClick: () => bus.emit("open-tab", { id: "workers" }),
              });
            }
          }
        }
      }
      if (changed) saveSettings({ workerReportsSeen: store });
      primed = true;
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  const [proj, setProj] = useState(projectRoot);
  const [theme, setTheme] = useState(loadSettings().theme ?? "dark");
  const [menuOpen, setMenuOpen] = useState(false);
  const [projMenu, setProjMenu] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(() => {
    const done = loadSettings().setupDone;
    return !done && !hermesFound();
  });
  const [ask, setAsk] = useState(null); // { title, value, cb }
  const [setupRoot, setSetupRoot] = useState(null); // trigger auto-setup modal
  // Check if project needs setup; show modal or open it as-is.
  // A project is "set up" if it has devtonic.config.json at root OR the legacy
  // .hermes/mission.json (which we'll migrate on first load).
  function openProject(root) {
    const fsn = window.require("fs");
    const p = window.require("path");
    const nu = p.join(root, "devtonic.config.json");
    const legacy = p.join(root, ".hermes", "mission.json");
    if (!fsn.existsSync(nu) && !fsn.existsSync(legacy)) {
      setSetupRoot(root);
    } else {
      switchProject(root);
    }
  }

  function switchProject(root) {
    setProject(root);
    setProj(root);
    setProjMenu(false);
  }

  // New project: create folder + git init + starter mission.json, then focus
  // the chat — Hermes sets everything else up from the docs you paste.
  async function newProject() {
    const base = await pickFolder({ title: "Create the new project inside…" });
    if (!base) return;
    setAsk({
      title: "Project name",
      value: "new-project",
      cb: name => createProject(base, name),
    });
  }

  function createProject(base, name) {
    if (!name?.trim()) return;
    const fs = window.require("fs");
    const path = window.require("path");
    const { execFileSync } = window.require("child_process");
    const root = path.join(base, name.trim());
    fs.mkdirSync(root, { recursive: true });
    try { execFileSync("git", ["init"], { cwd: root }); } catch {}
    // Empty project → open the auto-setup modal so Hermes scans and populates.
    openProject(root);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    saveSettings({ theme });
  }, [theme]);

  async function pickProject() {
    const folder = await pickFolder({ title: "Open project" });
    if (folder) openProject(folder);
  }

  function openTab(key) {
    const dock = dockRef.current;
    if (!dock) return;
    const existing = dock.find(key);
    if (existing) {
      dock.updateTab(key, TABS[key], true);
    } else {
      dock.dockMove(TABS[key], null, "float", {
        left: 200 + Math.random() * 200, top: 120 + Math.random() * 120, width: 640, height: 480,
      });
    }
    setMenuOpen(false);
  }

  // Cross-panel navigation: e.g. Alerts panel's "open" button on a Gmail
  // arrival broadcasts `open-tab` → this bridges to openTab().
  useEffect(() => bus.on("open-tab", ({ id }) => id && openTab(id)), []);

  // Primary tabs pinned in the bar; the rest in the ⊞ menu.
  const primary = ["chat", "servers", "map", "git", "terminal", "config"];
  const overflow = Object.keys(TABS).filter(k => !primary.includes(k));

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="toolbar">
        <img src={logoUrl} alt="Devtonic" className="brand-logo" />
        <span className="brand">DEVTONIC</span>
        <div className="tb-menu-wrap">
          <button className="proj" onClick={() => setProjMenu(o => !o)} title="Switch project">
            <span className="proj-dot" /> {proj.split("/").pop() || proj} <span style={{ opacity: .5 }}>▾</span>
          </button>
          {projMenu && (
            <div className="tb-menu" style={{ left: 0, right: "auto" }}>
              {recentProjects().map(r => (
                <button key={r} className="tb-menu-item" onClick={() => { setProjMenu(false); openProject(r); }}>
                  {r.split("/").pop()} <span className="tb-menu-dim">{r}</span>
                </button>
              ))}
              <button className="tb-menu-item" onClick={() => { setProjMenu(false); pickProject(); }}>📂 open folder…</button>
              <button className="tb-menu-item" onClick={() => { setProjMenu(false); newProject(); }}>✦ new project…</button>
              <button className="tb-menu-item" onClick={() => { setProjMenu(false); setSetupRoot(proj); }}>✨ re-scan this project</button>
            </div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {primary.map(k => (
          <button key={k} className="tb-btn" onClick={() => openTab(k)}>{TABS[k].title}</button>
        ))}
        <div className="tb-menu-wrap">
          <button className={`tb-btn ${menuOpen ? "active" : ""}`} onClick={() => setMenuOpen(o => !o)}>⊞ panels</button>
          {menuOpen && (
            <div className="tb-menu">
              {overflow.map(k => (
                <button key={k} className="tb-menu-item" onClick={() => openTab(k)}>{TABS[k].title}</button>
              ))}
            </div>
          )}
        </div>
        <button
          className="tb-btn theme-toggle"
          title="Reload Devtonic (fully re-init the UI)"
          onClick={() => { if (confirm("Reload Devtonic now?")) reloadApp(); }}
        >↻</button>
        <button
          className="tb-btn theme-toggle"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </div>
      {needsSetup && <Setup onDone={() => { saveSettings({ setupDone: true }); setNeedsSetup(false); }} />}
      <RestartBanner />
      {setupRoot && (
        <Autosetup
          root={setupRoot}
          onDone={() => { const r = setupRoot; setSetupRoot(null); switchProject(r); }}
          onCancel={() => setSetupRoot(null)}
        />
      )}
      {ask && (
        <div className="modal-back" onClick={() => setAsk(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{ask.title}</div>
            <input
              autoFocus
              defaultValue={ask.value}
              onKeyDown={e => {
                if (e.key === "Enter") { ask.cb(e.target.value); setAsk(null); }
                if (e.key === "Escape") setAsk(null);
              }}
            />
            <div className="modal-hint">Enter to confirm · Esc to cancel</div>
          </div>
        </div>
      )}
      <div style={{ flex: 1, position: "relative" }} onClick={() => { menuOpen && setMenuOpen(false); projMenu && setProjMenu(false); }}>
        <DockLayout
          ref={dockRef}
          defaultLayout={DEFAULT_LAYOUT}
          style={{ position: "absolute", inset: 6 }}
        />
      </div>
    </div>
  );
}
