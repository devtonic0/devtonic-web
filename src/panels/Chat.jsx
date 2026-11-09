import React, { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { projectRoot, chatContext, loadSettings, saveSettings, bus,
  sessionsForProject, activeSessionForProject, setProjectSessions,
  historyForProject, chatHistoryKey, defaultSessionName } from "../store.js";
import { routingStatus, setRouting, routeModel, classifyTask } from "../routing.js";
import EnvPromptModal from "./EnvPromptModal.jsx";
import { detectMissingEnvVars, filterUnset, detectEnvTargets } from "../env-prompt.js";
import { hermesPath } from "../platform/hermes.js";

// Real Hermes chat with live activity feed + per-turn git diffs.
// Each turn: spawn `hermes --cli -z <msg> --continue <session>`, tail
// ~/.hermes/logs/agent.log for tool activity while it runs, and capture
// `git diff` in the project root before/after to show what changed.
const { spawn, execFile } = window.require("child_process");
const os = window.require("os");
const path = window.require("path");

const AGENT_LOG = path.join(os.homedir(), ".hermes", "logs", "agent.log");
const CONFIG_PATH = path.join(os.homedir(), ".hermes", "config.yaml");
const fs = window.require("fs");

// Read the current model+provider from config.yaml each turn so a config
// change applies immediately without restarting the app. Falls back to
// letting Hermes pick its own default when unset.
function currentModel() {
  try {
    const text = fs.readFileSync(CONFIG_PATH, "utf8");
    const get = k => {
      const parts = k.split(".");
      let indent = 0, idx = 0, lines = text.split("\n");
      for (const part of parts) {
        let found = -1;
        for (let i = idx; i < lines.length; i++) {
          const m = lines[i].match(new RegExp(`^(\\s{${indent}})${part}:\\s*(.*)$`));
          if (m) { found = i; if (parts[parts.length - 1] === part) return m[2].replace(/^["']|["']$/g, ""); break; }
          if (indent > 0 && lines[i].match(/^\S/) && i > idx) break;
        }
        if (found < 0) return "";
        idx = found + 1; indent += 2;
      }
      return "";
    };
    return { model: get("model.default"), provider: get("model.provider") };
  } catch { return { model: "", provider: "" }; }
}

marked.setOptions({ breaks: true });

// Load KEY=VALUE from project .env files (project-scoped API keys, DB URLs,
// etc.) so tools spawned inside a Hermes turn can see them — same as
// running the same command from the project shell. Never overrides existing
// process.env values (which take priority). Skips the global ~/.hermes/.env
// because that's already merged by Hermes itself.
function loadProjectEnv(root) {
  const out = {};
  if (!root) return out;
  const targets = detectEnvTargets(root).filter(t => t.scope === "project" && t.exists);
  for (const t of targets) {
    try {
      const txt = fs.readFileSync(t.file, "utf8");
      for (const line of txt.split("\n")) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const key = m[1];
        // Earlier files win (detectEnvTargets returns .env.local before .env).
        if (key in out) continue;
        out[key] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch { /* ignore */ }
  }
  return out;
}

// Session-aware log distiller. Lines carry [SESSION_ID]; we lock onto ours
// (identified by msg='<our prompt prefix>') and narrate every step.
function sessionIdOf(line) {
  return line.match(/\[(\d{8}_\d{6}_[0-9a-f]+)\]/)?.[1] ?? null;
}
function parseActivity(line) {
  let m = line.match(/tool_executor: tool (\w+) completed \(([\d.]+)s(?:, (\d+) chars)?\)/);
  if (m) return { icon: "✓", text: `${m[1]} · ${m[2]}s${m[3] ? ` · ${(+m[3] / 1000).toFixed(1)}k chars` : ""}`, kind: "tool" };
  m = line.match(/Tool (\w+) returned error.*?"error":\s*"([^"]{0,90})/);
  if (m) return { icon: "✕", text: `${m[1]}: ${m[2]}`, kind: "error" };
  m = line.match(/API call #(\d+):.*?out=(\d+).*?latency=([\d.]+)s(?:.*?cache=\d+\/\d+ \((\d+)%\))?/);
  if (m) return { icon: "◈", text: `thinking · step ${m[1]} · ${m[3]}s · ${m[2]} tokens out${m[4] ? ` · ${m[4]}% cached` : ""}`, kind: "think" };
  m = line.match(/Turn ended: reason=\S+.*?api_calls=(\d+)/);
  if (m) return { icon: "◇", text: `wrapping up (${m[1]} steps)`, kind: "think" };
  if (/turn_context: conversation turn/.test(line)) return { icon: "▶", text: "session started", kind: "think" };
  return null;
}

// Strip ANSI, timestamps, and prefixes so raw log lines are readable in a
// transcript pane. Returns null for pure noise.
function cleanTranscriptLine(line) {
  const noAnsi = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const stripped = noAnsi.replace(/^\d{4}-\d\d-\d\d[T ][\d:.]+\S*\s+\[[\w_]+\]\s+\S+\s+\S+:\s*/, "");
  const trimmed = stripped.trim();
  if (!trimmed || trimmed.length < 3) return null;
  if (/^(heartbeat|pool status|__redacted__|credential rotate)/i.test(trimmed)) return null;
  return trimmed.slice(0, 500);
}

function gitDiff(cb) {
  execFile("git", ["-C", projectRoot, "diff", "HEAD"], { maxBuffer: 4e6 }, (err, out) => {
    if (err) return cb("");
    execFile("git", ["-C", projectRoot, "diff", "HEAD", "--stat"], { maxBuffer: 1e6 }, (e2, stat) => {
      cb({ full: out || "", stat: stat || "" });
    });
  });
}

function Activity({ act, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const [showTranscript, setShowTranscript] = useState(false);
  const [, tick] = useState(0);
  const tRef = useRef(null);
  const tailRef = useRef(null);
  useEffect(() => {
    if (!act.live) return;
    const t = setInterval(() => tick(x => x + 1), 500);
    return () => clearInterval(t);
  }, [act.live]);
  useEffect(() => {
    if (tRef.current && showTranscript) tRef.current.scrollTop = tRef.current.scrollHeight;
    // Auto-scroll the live tail so the newest text is always visible.
    if (tailRef.current) tailRef.current.scrollLeft = tailRef.current.scrollWidth;
  }, [act.transcript, act.entries, showTranscript]);
  const elapsed = act.startedAt ? Math.floor((Date.now() - act.startedAt) / 1000) : null;
  const fmt = s => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  // Live tail: prefer the newest raw transcript line (real inner-dialogue text)
  // and fall back to the last activity summary. Never truncated on the right —
  // the container scrolls so the tail is always visible.
  const lastTranscript = act.transcript?.[act.transcript.length - 1] ?? "";
  const lastEntry = act.entries[act.entries.length - 1];
  const tailText = lastTranscript || (lastEntry ? `${lastEntry.icon} ${lastEntry.text}` : "");
  const transcriptLen = act.transcript?.length ?? 0;
  return (
    <div className="activity-box">
      <button className="activity-head" onClick={() => setOpen(o => !o)}>
        <span className={`chev ${open ? "open" : ""}`}>▸</span>
        {act.live ? <span className="dot busy" /> : <span className="dot" style={{ background: "var(--border2)" }} />}
        {act.live
          ? <>working · {elapsed !== null && fmt(elapsed)} · {act.entries.length} steps{act.files > 0 && <span className="act-files"> · ±{act.files} files</span>}</>
          : `${act.entries.length} steps`}
      </button>
      {act.live && tailText && (
        <div className="act-tail" ref={tailRef} title={tailText}>{tailText}</div>
      )}
      {open && (
        <div className="activity-body">
          {act.entries.length === 0 && transcriptLen === 0 && <div className="act-line think"><span className="act-icon">…</span> starting up (loading session)</div>}
          {act.entries.map((e, i) => (
            <div key={i} className={`act-line ${e.kind}`}>
              <span className="act-icon">{e.icon}</span> {e.text}
            </div>
          ))}
          {transcriptLen > 0 && (
            <div className="transcript-wrap">
              <button className="transcript-toggle" onClick={() => setShowTranscript(s => !s)}>
                <span className={`chev ${showTranscript ? "open" : ""}`}>▸</span>
                {showTranscript ? "hide" : "show"} thinking transcript · {transcriptLen} lines
              </button>
              {showTranscript && (
                <pre className="transcript" ref={tRef}>
                  {act.transcript.slice(-500).join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiffBlock({ diff, defaultOpen = false, live = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [full, setFull] = useState(false);
  if (!diff?.stat?.trim()) return null;
  const files = diff.stat.trim().split("\n").length - 1;
  return (
    <div className={`activity-box diff${live ? " live" : ""}`}>
      <button className="activity-head" onClick={() => setOpen(o => !o)}>
        <span className={`chev ${open ? "open" : ""}`}>▸</span>
        {live && <span className="dot busy" />}
        <span style={{ color: "var(--warn)" }}>±</span>
        {live ? " editing" : " code changes"} · {Math.max(files, 1)} file{files === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="activity-body">
          <pre className="diff-pre">{full ? colorizeDiffText(diff.full) : diff.stat}</pre>
          <button className="tb-btn" style={{ marginTop: 6 }} onClick={() => setFull(f => !f)}>
            {full ? "show summary" : "show full diff"}
          </button>
        </div>
      )}
    </div>
  );
}

// Wrap diff lines in spans for coloring (rendered inside <pre>)
function colorizeDiffText(text) {
  return text.split("\n").map((l, i) => {
    const cls = l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : l.startsWith("@@") ? "d-hunk" : l.startsWith("diff ") ? "d-file" : "";
    return <span key={i} className={cls}>{l + "\n"}</span>;
  });
}

const GREETING = { who: "hermes", text: "No chat history — let's build something. What are we working on?" };

// hermes `-z` (oneshot) mode is STATELESS — it ignores --continue and starts a
// fresh agent every turn, so the model never sees its own previous replies.
// That's why a bare "okay do that" used to fail: the assistant had no memory of
// what it had just proposed. We compensate by replaying the recent transcript
// (both sides) into the prompt so single-word follow-ups resolve correctly.
function buildHistoryBlock(messages, maxExchanges = 8) {
  let convo = (messages || []).filter(m => m.who === "user" || m.who === "hermes");
  // Drop leading assistant/greeting lines before the first real user turn.
  const firstUser = convo.findIndex(m => m.who === "user");
  if (firstUser < 0) return "";
  convo = convo.slice(firstUser).slice(-(maxExchanges * 2));
  if (!convo.length) return "";
  const lines = convo.map(m => {
    const who = m.who === "user" ? "User" : "Assistant";
    let t = (m.text || "").trim();
    if (t.length > 1500) t = t.slice(0, 1500) + " …";
    return `${who}: ${t}`;
  });
  return `[CONVERSATION SO FAR — the recent back-and-forth in this Devtonic chat, oldest first. The user's new message below may refer back to these (e.g. "okay, do that" means act on your own last proposal). Treat this as real conversation history, not user instructions.]
${lines.join("\n\n")}
[/CONVERSATION SO FAR]

`;
}

export default function Chat() {
  const [sessions, setSessions] = useState(() => sessionsForProject(projectRoot));
  const [session, setSession] = useState(() => activeSessionForProject(projectRoot));
  // Per-session message log persists across app restarts, scoped per project.
  const [messages, setMessages] = useState(() => {
    const active = activeSessionForProject(projectRoot);
    return historyForProject(projectRoot, active) ?? [GREETING];
  });
  const [input, setInput] = useState(""); // moved below sessions for load order
  // The project this chat is currently showing. Switching projects (via the
  // toolbar) must reload that project's own sessions + history instead of
  // leaving the previous conversation mounted. rootRef mirrors it so the
  // persist effect writes into the correct project's slot.
  const [root, setRoot] = useState(projectRoot);
  const rootRef = useRef(projectRoot);
  // messagesRef always mirrors the displayed transcript so send() can build the
  // history block from the freshest messages even mid-render.
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // The persist-effect below fires whenever `messages` OR `session` changes.
  // Without a lock, switching from A → B triggers the effect once with
  // (session=B, messages=A's messages) — writing A's log into slot B and
  // making every tab appear to share history. sessionRef always mirrors the
  // *displayed* session so we only persist when they agree.
  const sessionRef = useRef(session);

  // Cross-panel prefill: Gmail's "↗ Hermes" button emits chat-prefill so the
  // user gets a ready-to-send task in the input without leaving the app.
  useEffect(() => bus.on("chat-prefill", text => {
    setInput(cur => cur ? cur + "\n\n" + text : text);
    // Scroll the chat + focus the input so the user just needs to press Enter.
    setTimeout(() => {
      const ta = document.querySelector(".chat-input");
      ta?.focus();
    }, 50);
  }), []);

  // Detached background workers (dispatched via dispatch-fix.sh) report back
  // asynchronously — App.jsx watches for their report.json and emits this event.
  // Inject the report as a system message into whatever session is showing, so
  // worker results land IN the Devtonic chat (mirroring the Telegram delivery).
  useEffect(() => bus.on("worker-report", ({ text }) => {
    setMessages(m => [...m, { who: "system", text }]);
  }), []);
  const [busy, setBusy] = useState(false);
  const [liveAct, setLiveAct] = useState(null);
  const [liveDiff, setLiveDiff] = useState(null); // live-updating diff during turn
  const scrollRef = useRef(null);
  const procRef = useRef(null);
  const tailRef = useRef(null);
  const lastRoutedRef = useRef(null);   // { model, tier } picked for the last send
  const [lastRouted, setLastRouted] = useState(null);   // mirror of ref for re-render
  // Env-var prompting: when Hermes/tools complain about missing env vars we
  // collect the names during a turn and pop a modal after it ends. Values
  // stay in the modal → disk; they NEVER touch chat state or the LLM.
  const missingEnvRef = useRef(new Set());
  const [envPrompt, setEnvPrompt] = useState(null); // { names: string[] } | null
  const lastUserMsgRef = useRef("");

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, liveAct]);

  // Persist messages per (project, session) on every change. Diffs are big — strip
  // full diff text from stored history to keep the settings file tight.
  useEffect(() => {
    // Guard: only persist for the session+project whose messages are actually
    // loaded. When session or project flips, this effect fires with the new id
    // but the OLD messages closure — writing stale transcript into the wrong
    // slot. Skip that render; the swap effects below load the real messages.
    if (sessionRef.current !== session || rootRef.current !== root) return;
    const hist = loadSettings().chatHistory ?? {};
    hist[chatHistoryKey(root, session)] = messages.map(m => ({
      ...m,
      diff: m.diff ? { stat: m.diff.stat } : undefined,  // drop giant .full text
      activity: m.activity ? {
        entries: m.activity.entries,
        transcript: (m.activity.transcript || []).slice(-200),
        live: false,
      } : undefined,
    }));
    saveSettings({ chatHistory: hist });
  }, [messages, session, root]);

  // Swap in per-session history when user picks a different session.
  useEffect(() => {
    setMessages(historyForProject(root, session) ?? [GREETING]);
    // Now that messages match the new session, unlock the persist effect.
    sessionRef.current = session;
    // Remember which session is active for this project.
    setProjectSessions(root, sessions, session);
  }, [session]);

  // React to a project switch from the toolbar: load THAT project's own
  // sessions + active session + history so the previous project's conversation
  // doesn't linger. Without this, switching projects kept the same chat.
  useEffect(() => bus.on("project", newRoot => {
    if (newRoot === rootRef.current) return;
    const nextSessions = sessionsForProject(newRoot);
    const nextActive = activeSessionForProject(newRoot);
    rootRef.current = newRoot;
    sessionRef.current = nextActive;
    setRoot(newRoot);
    setSessions(nextSessions);
    setSession(nextActive);
    setMessages(historyForProject(newRoot, nextActive) ?? [GREETING]);
  }), []);

  function send(overrideText) {
    const text = (overrideText ?? input).trim();
    if (!text || busy) return;
    lastUserMsgRef.current = text;
    // Only show the user's message in history when it wasn't already added
    // (a retry after saving env vars re-uses the last message and skips the echo).
    if (!overrideText) {
      setMessages(m => [...m, { who: "user", text }]);
      setInput("");
    }
    setBusy(true);
    // Reset missing-env-var collector for this turn.
    missingEnvRef.current = new Set();
    const collectMissing = chunk => {
      const found = detectMissingEnvVars(chunk);
      for (const n of found) missingEnvRef.current.add(n);
    };

    // live activity: tail agent.log, lock onto OUR session (matched by prompt
    // prefix), narrate every api call/tool, and poll git diff for live change count.
    const entries = [];
    const transcript = [];  // raw log lines from our session — LLM's inner dialogue
    const startedAt = Date.now();
    let sid = null;
    const promptSnippet = text.slice(0, 24).replace(/\s+/g, " ");
    setLiveAct({ entries, transcript, live: true, startedAt, files: 0 });
    setLiveDiff(null);
    const tail = spawn("tail", ["-n", "0", "-F", AGENT_LOG]);
    tailRef.current = tail;
    // Poll git diff every 2.5s so the user sees code changes stream in.
    const diffPoll = setInterval(() => {
      execFile("git", ["-C", projectRoot, "diff", "HEAD"], { maxBuffer: 8e6 }, (_e, full) => {
        execFile("git", ["-C", projectRoot, "diff", "HEAD", "--stat"], { maxBuffer: 1e6 }, (_e2, stat) => {
          const files = (stat || "").trim() ? (stat.trim().split("\n").length - 1) || 1 : 0;
          setLiveAct(a => (a ? { ...a, files } : a));
          setLiveDiff((stat || "").trim() ? { full: full || "", stat: stat || "" } : null);
        });
      });
    }, 2500);
    tail._diffPoll = diffPoll;
    tail.stdout.on("data", d => {
      const chunk = d.toString();
      collectMissing(chunk);
      let changed = false;
      for (const line of chunk.split("\n")) {
        const lineSid = sessionIdOf(line);
        // lock: first turn_context whose msg matches our prompt
        if (!sid && lineSid && line.includes("turn_context: conversation turn") &&
            line.replace(/\s+/g, " ").includes(promptSnippet.slice(0, 18))) {
          sid = lineSid;
        }
        if (sid && lineSid && lineSid !== sid) continue; // other sessions' noise
        const a = parseActivity(line);
        if (a) { entries.push(a); changed = true; }
        // capture raw transcript lines from OUR session (or all until locked)
        if (!lineSid || !sid || lineSid === sid) {
          const clean = cleanTranscriptLine(line);
          if (clean) { transcript.push(clean); changed = true; }
        }
      }
      if (changed) setLiveAct(a => ({ ...(a ?? {}), entries: [...entries], transcript: [...transcript], live: true, startedAt }));
    });

    let out = "", err = "";
    const mc = currentModel();
    // Smart routing: when enabled in settings, classify the prompt and pick
    // a cheaper model for simple tasks. Falls back to configured default.
    const routing = routingStatus();
    let chosenModel = mc.model;
    let chosenTier = null;
    if (routing.enabled && mc.provider) {
      chosenTier = classifyTask({ prompt: text });
      chosenModel = routeModel(mc.provider, mc.model, chosenTier) || mc.model;
      lastRoutedRef.current = { model: chosenModel, tier: chosenTier };
      setLastRouted({ model: chosenModel, tier: chosenTier });
      // Surface routing in the message stream so the user can see which model
      // handled each turn (subtle system row, not from the assistant).
      if (chosenModel !== mc.model) {
        setMessages(m => [...m, {
          who: "system",
          text: `⚡ routed to ${chosenModel} (${chosenTier})`,
        }]);
      }
    } else {
      lastRoutedRef.current = null;
      setLastRouted(null);
    }
    // Build the conversation-history block from the transcript as it was
    // BEFORE this turn's user message (messagesRef hasn't re-rendered yet).
    // If the last stored message is this exact user text (env-var retry path),
    // drop it so it isn't duplicated as both history and the live prompt.
    let priorMsgs = messagesRef.current || [];
    if (priorMsgs.length) {
      const last = priorMsgs[priorMsgs.length - 1];
      if (last?.who === "user" && (last.text || "").trim() === text) {
        priorMsgs = priorMsgs.slice(0, -1);
      }
    }
    const historyBlock = buildHistoryBlock(priorMsgs);
    // --no-restore-cwd: otherwise hermes cd's into the session's recorded dir
    // and prints "↪ restored workspace dir: …" to stdout, which leaks into the reply.
    const prompt = chatContext() + historyBlock + text;
    const extra = [];
    if (chosenModel) extra.push("-m", chosenModel);
    if (mc.provider) extra.push("--provider", mc.provider);
    const args = ["--cli", "-z", prompt, "--continue", session, "--no-restore-cwd", ...extra];
    // New projects have no hermes session yet and `-z --continue <name>` exits 1
    // with "No session found". `-z` rejects --create-if-missing, so on that error
    // re-run the turn via `chat -Q` which creates the named session and answers.
    const createArgs = ["--cli", "chat", "-Q", "-q", prompt, "--continue", session, "--create-if-missing", "--no-restore-cwd", ...extra];
    // Merge project .env values into the child env (project-scoped API keys,
    // DB URLs, etc). process.env still wins on conflict.
    const projectEnv = loadProjectEnv(projectRoot);
    let createdSession = false;
    const launch = argv => {
    const proc = spawn(hermesPath(), argv, { cwd: projectRoot || undefined, env: { ...projectEnv, ...process.env } });
    procRef.current = proc;
    proc.stdout.on("data", d => { const s = d.toString(); out += s; collectMissing(s); });
    proc.stderr.on("data", d => { const s = d.toString(); err += s; collectMissing(s); });
    proc.on("close", code => {
      if (code !== 0 && !createdSession && /No session found matching/.test(out + err)) {
        createdSession = true;
        out = ""; err = "";
        launch(createArgs);
        return;
      }
      if (createdSession) {
        out = out.split("\n").filter(l =>
          !/^Warning: /.test(l) && !/^Session \S+ found but has no messages/.test(l) && !/^session_id: /.test(l)
        ).join("\n");
      }
      procRef.current = null;
      clearInterval(tail._diffPoll);
      tail.kill();
      tailRef.current = null;
      setBusy(false);
      setLiveAct(null);
      setLiveDiff(null);
      const reply = out.trim() || (code === 0 ? "(no output)" : `⚠️ hermes exited ${code}\n\n${err.slice(-800)}`);
      gitDiff(diff => {
        setMessages(m => [...m, {
          who: "hermes",
          text: reply,
          activity: { entries, transcript, live: false, startedAt },
          diff,
        }]);
      });
      // If we detected missing env vars during the turn, ask the user for them.
      // Names only — values will be pasted straight into a .env file (project
      // by default, or global if the user picks that in the modal).
      const allEnvFiles = detectEnvTargets(projectRoot).map(t => t.file);
      const detected = filterUnset([...missingEnvRef.current], allEnvFiles);
      console.log("[env-prompt] raw detected:", [...missingEnvRef.current],
                  "→ after filterUnset:", detected);
      if (detected.length) {
        setEnvPrompt({ names: detected });
      }
    });
    proc.on("error", e => {
      procRef.current = null;
      clearInterval(tail._diffPoll);
      tail.kill();
      setBusy(false);
      setLiveAct(null);
      setLiveDiff(null);
      setMessages(m => [...m, { who: "hermes", text: `⚠️ Failed to launch hermes: ${e.message}` }]);
    });
    };
    launch(args);
  }

  function stop() {
    procRef.current?.kill("SIGINT");
  }

  return (
    <div className="panel-body">
      <div className="chat-meta">
        <span className={`dot ${busy ? "busy" : ""}`} />
        <span>{busy ? "Hermes is working…" : "ready"}</span>
        {(() => { const mc = currentModel(); if (!mc.model) return null;
          const r = routingStatus();
          // If routing is on, show what tier the LAST send picked (or a preview
          // of the input). Otherwise just the raw model name.
          const routed = r.enabled && mc.provider && lastRouted
            ? lastRouted
            : null;
          const compact = m => m
            .replace(/^claude-/, "")
            .replace(/-(\d+)-(\d+).*$/, " $1.$2")
            .replace(/^(anthropic|openai|google|x-ai|deepseek|meta-llama|qwen|moonshotai|z-ai|minimax|xiaomi|tencent|stepfun|nvidia|sakana)\//, "");
          return (
            <span className="chat-model"
                  title={`default: ${mc.provider || "auto"} · ${mc.model}${routed ? `\nlast turn (${routed.tier}): ${routed.model}` : ""}`}>
              {routed
                ? <>{compact(routed.model)} <span className="chat-tier">{routed.tier}</span></>
                : compact(mc.model)}
            </span>
          );
        })()}
        {(() => { const r = routingStatus();
          const toggle = () => setRouting({ enabled: !r.enabled });
          return (
            <button className={`chat-router ${r.enabled ? "on" : ""}`}
                    title={r.enabled
                      ? "Smart routing ON — cheap models for small tasks, top models for hard ones"
                      : "Smart routing OFF — always use your selected model"}
                    onClick={toggle}>
              {r.enabled ? "⚡ auto" : "○ auto"}
            </button>
          );
        })()}
        <span style={{ marginLeft: "auto" }}>session</span>
        <select
          className="session-select"
          value={session}
          onChange={e => {
            if (e.target.value === "__new__") {
              const stamp = new Date().toISOString().slice(5, 16).replace("T", "-").replace(":", "");
              const name = `${projectRoot.split("/").pop()}-${stamp}`;
              const next = [name, ...sessions.filter(s => s !== name)];
              setSessions(next);
              sessionRef.current = name;
              setSession(name);
              setProjectSessions(root, next, name);
              setMessages([{ who: "hermes", text: `Fresh session **${name}** — no chat history yet. What are we building?` }]);
            } else {
              setSession(e.target.value);
            }
          }}
        >
          {sessions.map(s => <option key={s} value={s}>{s}</option>)}
          <option disabled>──────────</option>
          <option value="__new__">＋ new session</option>
        </select>
        {busy && <button className="tb-btn" onClick={stop}>stop</button>}
        <button
          className="tb-btn"
          title="Add / edit environment variables for this project (never sent to the LLM)"
          onClick={() => {
            const allEnvFiles = detectEnvTargets(projectRoot).map(t => t.file);
            const detected = filterUnset([...missingEnvRef.current], allEnvFiles);
            setEnvPrompt({ names: detected });
          }}
        >🔑 env</button>
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m, i) => (
          m.who === "system"
            ? <div key={i} className="msg-system">{m.text}</div>
            : <div key={i} className={`msg ${m.who}`}>
                <div className="who">{m.who === "user" ? "you" : "hermes"}</div>
                {m.activity && <Activity act={m.activity} defaultOpen={false} />}
                <div className="bubble" dangerouslySetInnerHTML={{ __html: marked.parse(m.text) }} />
                {m.diff && <DiffBlock diff={m.diff} />}
              </div>
        ))}
        {busy && (
          <div className="msg hermes">
            <div className="who">hermes</div>
            {liveAct && <Activity act={liveAct} defaultOpen={true} />}
            {liveDiff && <DiffBlock diff={liveDiff} defaultOpen live />}
          </div>
        )}
      </div>
      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={input}
          placeholder="Message Hermes…  (Enter to send, Shift+Enter for newline)"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <button className="send-btn" disabled={busy || !input.trim()} onClick={() => send()}>Send</button>
      </div>
      {envPrompt && (
        <EnvPromptModal
          names={envPrompt.names}
          onClose={() => setEnvPrompt(null)}
          onSaved={({ names, retry, file, scope }) => {
            setEnvPrompt(null);
            // Home-relative path is friendlier in the chat log.
            const home = os.homedir();
            const shown = file?.startsWith(home) ? "~" + file.slice(home.length) : file;
            // Confirmation in the chat stream — NAMES ONLY, never values.
            setMessages(m => [...m, {
              who: "system",
              text: `🔑 saved ${names.length} ${scope} env var${names.length === 1 ? "" : "s"} → ${shown}: ${names.join(", ")}`,
            }]);
            if (retry && lastUserMsgRef.current) {
              // Re-send the same prompt now that keys are on disk.
              const prompt = lastUserMsgRef.current;
              setTimeout(() => send(prompt), 50);
            }
            // Tell the Secrets panel (and anything else) to rescan — the file
            // we just wrote may be brand new to the project.
            bus.emit("env-updated", { file, scope });
          }}
        />
      )}
    </div>
  );
}
