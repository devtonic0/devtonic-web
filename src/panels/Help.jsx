import React, { useState } from "react";

// Help: guide for every panel + core workflows.
const SECTIONS = [
  { title: "Getting started", body: `1. Pick or create a project with the project dropdown (top-left).
2. Talk to Hermes in the ⚡ chat — it has full tools, memory, and your project context (open tasks, active phase) on every message.
3. Paste project docs into a fresh session and Hermes scaffolds the trackers: phases, features, architecture — all live in <project>/devtonic.config.json and every panel updates in real time as it's edited (by you or by Hermes).` },
  { title: "⚡ Hermes chat", body: `Real Hermes agent — not a chatbot shim. Session dropdown switches conversation threads; ＋ starts a fresh one. While it works you see a live activity feed (every thinking step, tool call, ±changed files, elapsed time). When done, the feed collapses into "N steps" (click to re-expand) and a "± code changes" dropdown shows the git diff summary or full colorized diff.` },
  { title: "🌐 Map", body: `Your codebase as 3D clusters — one color per top-level folder. Thick colored links are real imports (colored by the source cluster: a blue thread into a red page means "page imports from lib"). The key (left) explains each cluster — click a color to hide/show that section. Click any file node to open it in Code. Drag to orbit, scroll to zoom.` },
  { title: "🏛 Architecture & 🧩 Features", body: `Living diagrams driven by devtonic.config.json. Architecture: layered stack map — click any node for its purpose and code references. Features: every feature grouped LIVE / BUILDING / PLANNED with its stack; click one for overview, start-to-finish flow (each step links into the code), and references. Hermes maintains these as you build.` },
  { title: "⌥ Code", body: `File tree (⇤ collapses it), ripgrep search, and ✨ AI search — toggle the ⌕ button and ask in plain English ("where is the css for the sign-in button"). Search & replace via the ⇄ button. Problems drawer at the bottom runs tsc/eslint on demand — click an error to jump to it. Drag the drawer edge to resize.` },
  { title: "⎇ Git", body: `Branch status, ahead/behind, one-click ⇅ sync (pull --rebase + push), stage-all commits, PR list. ✨ draft with AI has Hermes read the branch diff and write the PR title/body for your review; create normal or draft PRs; squash-merge with branch deletion.` },
  { title: "❯ Terminal", body: `Persistent bash bound to the project root (follows project switches). For full-screen TUI apps use your system terminal — this one is line-based.` },
  { title: "🗄 Database", body: `Auto-connects using SUPABASE_URL + service key found in your project's env files. Browse tables, page through rows, filter, insert/delete rows. Destructive actions confirm first.` },
  { title: "◔ Usage", body: `Estimated API spend parsed from the local Hermes log — today's total vs your warning/limit thresholds, 14-day history, per-model breakdown with editable $/1M rates. Banners fire when you cross thresholds; hard limits are advisory (nothing blocks the API — switch models in ⚙ Config to slow spend).` },
  { title: "🔑 Secrets & ⚙ Config", body: `Secrets: every env file as its own tab, values masked, click to reveal, copy per key, add new keys. Config: the actual Hermes agent — switch model/provider, toggle toolsets, install/enable plugins from git repos.` },
  { title: "⇪ Workspace (machine image)", body: `Export your entire setup — memory, skills, config, chat history, plugins, app settings, project trackers — as one .tar.gz. On a new machine: install Devtonic, run the setup wizard (installs Hermes), then Import the image. Identical brain, new hardware. Secrets export is opt-in.` },
  { title: "Layout", body: `Every tab is dockable: drag tabs between groups, split panes, float windows, close what you don't need (reopen from the toolbar / ⊞ panels). UI scale lives in ⚙ Settings.` },
];

export default function Help() {
  const [open, setOpen] = useState(0);
  return (
    <div className="panel-body">
      <div className="usage-scroll">
        {SECTIONS.map((s, i) => (
          <div key={s.title} className="help-sec">
            <button className="help-head" onClick={() => setOpen(o => (o === i ? -1 : i))}>
              <span className={`chev ${open === i ? "open" : ""}`}>▸</span> {s.title}
            </button>
            {open === i && <div className="help-body">{s.body}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
