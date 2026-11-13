// Tiny project store + event bus. mission.json lives in <project>/.hermes/.
const fs = window.require("fs");
const path = window.require("path");
const os = window.require("os");

const listeners = new Map();
export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  },
  emit(evt, data) {
    (listeners.get(evt) ?? []).forEach(fn => fn(data));
  },
};

const SETTINGS = path.join(os.homedir(), ".hermes-mission-control.json");

export function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { return {}; }
}
export function saveSettings(patch) {
  const cur = loadSettings();
  fs.writeFileSync(SETTINGS, JSON.stringify({ ...cur, ...patch }, null, 2));
}

export let projectRoot = loadSettings().lastProject ?? os.homedir();

let missionWatcher = null;
function watchMission(root) {
  missionWatcher?.close();
  missionWatcher = null;
  try {
    // Watch devtonic.config.json itself. The browser shim's fs.watch polls the
    // watched path's mtime, and a directory's mtime doesn't change when a file
    // inside it is edited, so watching the root never fired. The shim reports
    // the basename (and tolerates the file not existing yet).
    let t = null;
    missionWatcher = fs.watch(missionPath(root), (_evt, file) => {
      if (file && file !== CONFIG_FILE) return;
      clearTimeout(t);
      t = setTimeout(() => bus.emit("mission", loadMission(root)), 250);
    });
  } catch { /* dir unreadable */ }
}

export function setProject(root) {
  projectRoot = root;
  const s = loadSettings();
  const recent = [root, ...(s.recentProjects ?? []).filter(r => r !== root)].slice(0, 8);
  saveSettings({ lastProject: root, recentProjects: recent });
  watchMission(root);
  bus.emit("project", root);
}

export const recentProjects = () => loadSettings().recentProjects ?? [projectRoot];

// ---------- per-project chat sessions ----------
// Chat sessions AND their message history are scoped per project so switching
// projects shows that project's own conversations instead of a single global
// list. Legacy global keys (chatSessions / chatHistory[name]) are read as a
// fallback so existing history isn't lost on upgrade.
export const defaultSessionName = root => `${(root || "").split("/").pop() || "project"}-main`;
export const chatHistoryKey = (root, session) => `${root}::${session}`;

export function sessionsForProject(root = projectRoot) {
  const map = loadSettings().chatSessionsByProject ?? {};
  const list = map[root];
  return (Array.isArray(list) && list.length) ? list : [defaultSessionName(root)];
}
export function activeSessionForProject(root = projectRoot) {
  const active = loadSettings().chatActiveByProject ?? {};
  const list = sessionsForProject(root);
  const want = active[root];
  return (want && list.includes(want)) ? want : list[0];
}
export function setProjectSessions(root, list, activeSession) {
  const s = loadSettings();
  const map = { ...(s.chatSessionsByProject ?? {}), [root]: list };
  const active = { ...(s.chatActiveByProject ?? {}), [root]: activeSession };
  saveSettings({ chatSessionsByProject: map, chatActiveByProject: active });
}
// Returns stored messages for (root, session), or null when none exist yet.
// Falls back to a legacy un-scoped history slot keyed by session name alone.
export function historyForProject(root, session) {
  const hist = loadSettings().chatHistory ?? {};
  return hist[chatHistoryKey(root, session)] ?? hist[session] ?? null;
}

// Compact context block injected into every chat turn so Hermes knows
// the project state AND the mission.json contract it maintains.
export function chatContext() {
  const m = loadMission();
  const todo = (m.todos ?? []).filter(t => !t.done).slice(0, 6).map(t => "- " + t.text).join("\n");
  const active = (m.phases ?? []).find(p => p.status === "active")?.name ?? "?";

  // Integrations status — so Hermes knows what's already wired up and can
  // use configured credentials WITHOUT asking the user for them.
  const s = loadSettings();
  const integrations = [];
  integrations.push("None configured (devtonic-web ships without third-party integrations).");

  return `[MISSION CONTROL CONTEXT — not from the user]
Target project: ${projectRoot}
Active phase: ${active}
Open tasks:
${todo || "- (none)"}

Integrations:
${integrations.map(l => "- " + l).join("\n")}

You are running inside Devtonic Mission Control. Devtonic is the CHAT UI you appear in; ${projectRoot} is the SEPARATE project you are working on for the user. Do NOT confuse them:
  • When the user asks about "the project" / builds / tests / deploys / commits, they mean ${projectRoot}.
  • Devtonic's own build system (npm run build, vite, electron-builder, dpkg) is NOT relevant unless the user is explicitly working on Devtonic itself (path: ~/hermes-mission-control).
  • Never run npm/vite/build commands from Devtonic against the target project. Use the target's own tooling.
  • Never claim "npm build passes" for a JSON/markdown/config change — those files aren't compiled.

The file ${missionPath(projectRoot)} drives the Devtonic UI panels (JSON keys: notes(md), todos[{id,text,done}], phases[{id,name,status:done|active|pending}], architecture{layers[{name,items[{name,detail,color}]}]}, features[{name,desc,status:live|building|planned,stack[]}]).
NOTE: this file used to live at <project>/.hermes/mission.json — that path is DEPRECATED. Read/write ${CONFIG_FILE} at the project root instead. If you find a legacy .hermes/mission.json without the new file, migrate its contents to ${CONFIG_FILE} at project root.
READ FIRST: when asked to build/continue/review project work, read that file for the full feature/architecture/phase detail before acting.
KEEP IT CURRENT: whenever you add/finish features, change stack, or complete tasks in this project, update that file with your file tools in the same turn — the UI live-reloads it. Create it if missing.
RESPONSE STYLE — be terse. When you update mission.json, say "task list updated" or "phase X → done" and stop. Do NOT restate the JSON, do NOT explain what the UI will do, do NOT add a "verification passed" block or list of routes/checks. The user sees the diff panel and the mission panel already. One-line confirmation is enough.

WHAT COUNTS AS A REPLY — the visible reply is what the user reads. It MUST be an actual answer to what they asked, in their voice, not a work log. Do NOT reply with a raw completion log (things like "▸ 0 steps · Verified. · pnpm run check: 0 errors, 0 warnings · vitest 72/72 passing · Blocker for full test: …"). That is diagnostic output, NOT a reply. The Devtonic UI already shows the tool activity + diff, so the user has that context — your job is to summarize what changed in one or two plain-English sentences answering their prompt, then (only if relevant) mention one concrete blocker in one line. Never lead with "Verified." or a checklist of passed steps.

ENV VARS — Devtonic intercepts every missing-env-var error and automatically pops a secure paste modal for the user. NEVER instruct the user to "paste this into the Secrets tab", "add this to .env", "put your API key in ~/.hermes/.env", or otherwise ask them to edit env files. Do NOT print export commands, .env snippets, or "please set X" instructions. Just let the tool fail once — the modal handles it. If a key is truly missing after retry, say only "still missing X — try again" and stop.

BACKGROUND WORKERS — CRITICAL. You are running as a \`hermes -z\` oneshot: your process EXITS the instant you send your reply, which KILLS any child you spawn. So NEVER use delegate_task, \`hermes &\`, nohup-in-a-tool-call, or any inline subprocess for long work like "run FIX-N" / "implement across repos" / builds that outlast the turn — it dies the moment you reply and lands NOTHING (this is the real cause of the recurring "worker died again" pattern, NOT memory pressure). Instead ALWAYS dispatch via the durable script, which fully detaches (setsid+nohup) so the worker outlives your turn and reports to BOTH Telegram and the Devtonic Workers panel on completion:
  1. Write the full self-contained spec to a file (worker has NO conversation context): repo layout + absolute paths, authoritative spec location, baseline test counts, memory discipline (targeted \`forge test --match-*\` while iterating, full suite ONCE at end, one repo at a time), and explicit COMMIT+PUSH rules (prior workers left work uncommitted).
  2. Dispatch ONE terminal call: \`~/.hermes/scripts/dispatch-fix.sh <ID> ${projectRoot} <spec-file>\` — it returns immediately with a pid; then you may end your turn.
  3. Tell the user it'll report to the Workers panel + Telegram when done. Check a running worker with \`cat ~/.hermes/fix-workers/<ID>/state\` and cross-check real git state — NEVER trust a worker's self-report of "landed"; verify HEAD moved. Full playbook: skill durable-fix-workers.
[/CONTEXT]

`;
}



// ---------- devtonic.config.json (project config) ----------
// Location: <project>/devtonic.config.json (project root, discoverable next to package.json).
// Legacy location: <project>/.hermes/mission.json — auto-migrated on first load.
const CONFIG_FILE = "devtonic.config.json";
const LEGACY_FILE = path.join(".hermes", "mission.json");
const missionPath = root => path.join(root, CONFIG_FILE);
const legacyPath = root => path.join(root, LEGACY_FILE);

function migrateLegacy(root) {
  const nu = missionPath(root), old = legacyPath(root);
  if (fs.existsSync(nu) || !fs.existsSync(old)) return;
  try {
    fs.copyFileSync(old, nu);
    // Leave the old file in place with a stub pointer so any external tool
    // still poking at it doesn't error, but the source of truth is the new path.
    fs.writeFileSync(old, JSON.stringify({
      _moved: `→ ${CONFIG_FILE} at project root (migrated by Devtonic)`,
    }, null, 2));
  } catch { /* migration is best-effort */ }
}

const DEFAULT_MISSION = {
  notes: "# Notes\n\nProject notes live here — markdown supported.\n",
  todos: [],
  phases: [
    { id: "p1", name: "Plan", status: "done" },
    { id: "p2", name: "Build", status: "active" },
    { id: "p3", name: "Verify", status: "pending" },
    { id: "p4", name: "Ship", status: "pending" },
  ],
};

export function loadMission(root = projectRoot) {
  migrateLegacy(root);
  try {
    return { ...DEFAULT_MISSION, ...JSON.parse(fs.readFileSync(missionPath(root), "utf8")) };
  } catch {
    return structuredClone(DEFAULT_MISSION);
  }
}

export function saveMission(mission, root = projectRoot) {
  const p = missionPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(mission, null, 2));
  bus.emit("mission", mission);
}

// ---------- async variants (fs.promises — no sync XHR in the browser) ----------
// Panels that load on mount or react to user edits use these so the main
// thread never blocks on the bridge. Only standard Node `fs/promises` methods
// are used, so the same code runs against the shim and against real Node.
const fsp = () => fs.promises;
const existsAsync = p => fsp().access(p).then(() => true, () => false);

async function migrateLegacyAsync(root) {
  const nu = missionPath(root), old = legacyPath(root);
  if (await existsAsync(nu) || !(await existsAsync(old))) return;
  try {
    await fsp().copyFile(old, nu);
    await fsp().writeFile(old, JSON.stringify({
      _moved: `→ ${CONFIG_FILE} at project root (migrated by Devtonic)`,
    }, null, 2));
  } catch { /* migration is best-effort */ }
}

export async function loadMissionAsync(root = projectRoot) {
  await migrateLegacyAsync(root);
  try {
    return { ...DEFAULT_MISSION, ...JSON.parse(await fsp().readFile(missionPath(root), "utf8")) };
  } catch {
    return structuredClone(DEFAULT_MISSION);
  }
}

export async function saveMissionAsync(mission, root = projectRoot) {
  const p = missionPath(root);
  await fsp().mkdir(path.dirname(p), { recursive: true });
  await fsp().writeFile(p, JSON.stringify(mission, null, 2));
  bus.emit("mission", mission);
}

export async function readFileSafeAsync(p, limit = 400_000) {
  try {
    const text = await fsp().readFile(p, "utf8");
    if (text.length > limit) return text.slice(0, limit) + "\n\n… (truncated)";
    return text;
  } catch (e) {
    return `⚠️ ${e.message}`;
  }
}

/** Same BFS/budget semantics as scanTree, but each directory level is listed
 *  and stat'ed concurrently via fs.promises. */
export async function scanTreeAsync(root = projectRoot, maxDepth = 6, maxNodes = 2000) {
  const nodes = [], links = [];
  let count = 0;
  nodes.push({ id: root, name: path.basename(root), dir: true, ext: "root", size: 12, depth: 0 });
  const queue = [{ dir: root, parentId: root, depth: 1 }];
  while (queue.length && count < maxNodes) {
    const { dir, parentId, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let entries = [];
    try { entries = await fsp().readdir(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    const kept = [];
    for (const e of entries) {
      if (count + kept.length >= maxNodes) break;
      if (e.name.startsWith(".") && e.name !== ".hermes") continue;
      if (IGNORE.has(e.name)) continue;
      kept.push(e);
    }
    const sizes = await Promise.all(kept.map(e => e.isDirectory()
      ? 1
      : fsp().stat(path.join(dir, e.name)).then(s => Math.max(1, Math.min(40, s.size / 2000)), () => 1)));
    kept.forEach((e, i) => {
      const full = path.join(dir, e.name);
      nodes.push({
        id: full,
        name: e.name,
        dir: e.isDirectory(),
        ext: e.isDirectory() ? "dir" : (e.name.split(".").pop() || "").toLowerCase(),
        size: sizes[i],
        depth,
      });
      links.push({ source: parentId, target: full });
      count++;
      if (e.isDirectory()) queue.push({ dir: full, parentId: full, depth: depth + 1 });
    });
  }
  return { nodes, links };
}

// ---------- filesystem scan (for map + code tree) ----------
const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__", ".venv", "venv", ".cache", "coverage"]);

export function scanTree(root = projectRoot, maxDepth = 6, maxNodes = 2000) {
  const nodes = [], links = [];
  let count = 0;
  // Breadth-first traversal: without this, a depth-first walk spends the entire
  // node budget inside the FIRST subtree it descends. In a parent repo that
  // contains several child repos, that means only the first child shows up on
  // the map and its siblings are silently dropped. A BFS queue spreads the
  // budget evenly across every branch, so all sibling repos appear.
  nodes.push({ id: root, name: path.basename(root), dir: true, ext: "root", size: 12, depth: 0 });
  const queue = [{ dir: root, parentId: root, depth: 1 }];
  while (queue.length && count < maxNodes) {
    const { dir, parentId, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    // Directories first so nested repos/folders are discovered before the
    // budget is spent on leaf files in shallow folders.
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (count >= maxNodes) break;
      if (e.name.startsWith(".") && e.name !== ".hermes") continue;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const id = full;
      let size = 1;
      if (!e.isDirectory()) {
        try { size = Math.max(1, Math.min(40, fs.statSync(full).size / 2000)); } catch {}
      }
      nodes.push({
        id,
        name: e.name,
        dir: e.isDirectory(),
        ext: e.isDirectory() ? "dir" : (e.name.split(".").pop() || "").toLowerCase(),
        size,
        depth,
      });
      links.push({ source: parentId, target: id });
      count++;
      if (e.isDirectory()) queue.push({ dir: full, parentId: id, depth: depth + 1 });
    }
  }
  return { nodes, links };
}

export function readFileSafe(p, limit = 400_000) {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length > limit) return buf.slice(0, limit).toString("utf8") + "\n\n… (truncated)";
    return buf.toString("utf8");
  } catch (e) {
    return `⚠️ ${e.message}`;
  }
}

// initialize watcher for the boot project (after all declarations)
watchMission(projectRoot);
