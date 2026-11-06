import React, { useCallback, useEffect, useMemo, useState } from "react";
import catalog from "../providers-catalog.json";
import { bus } from "../store.js";

// Hermes Config: provider/model dropdowns with API-key management + OAuth
// sign-in for capable providers (nous, anthropic, openai-codex, xai-oauth,
// qwen-oauth, minimax-oauth), curated settings selectors for the full
// config surface, personality prompt editor, toolset toggles, plugin
// management. Writes via `hermes config set` + ~/.hermes/.env.
const { execFile, spawn } = window.require("child_process");
const os = window.require("os");
const path = window.require("path");
const fs = window.require("fs");

const HERMES = path.join(os.homedir(), ".local", "bin", "hermes");
const CONFIG_PATH = path.join(os.homedir(), ".hermes", "config.yaml");
const ENV_PATH = path.join(os.homedir(), ".hermes", ".env");

const hermes = (...args) =>
  new Promise(resolve => {
    execFile(HERMES, args, { maxBuffer: 4e6, timeout: 60000 }, (err, out, errOut) =>
      resolve({ ok: !err, out: (out || "").trim(), err: (errOut || err?.message || "").trim() })
    );
  });

// ── providers: loaded from generated catalog (mirrors hermes_cli/models.py) ──
// Each provider: { label, models[], env, oauth }
const PROVIDERS = catalog;

// ── curated settings schema: the config surface, right widget per option ──
const SETTINGS = [
  { section: "agent behavior", items: [
    { key: "agent.reasoning_effort", label: "reasoning effort", type: "select", options: ["none", "minimal", "low", "medium", "high", "xhigh"] },
    { key: "agent.max_turns", label: "max tool turns per message", type: "number" },
    { key: "agent.tool_use_enforcement", label: "tool use enforcement", type: "select", options: ["auto", "always", "never"] },
    { key: "agent.verbose", label: "verbose logging", type: "bool" },
  ]},
  { section: "display & personality", items: [
    { key: "display.personality", label: "personality", type: "personality" },
    { key: "display.streaming", label: "stream responses", type: "bool" },
    { key: "display.show_cost", label: "show cost per turn", type: "bool" },
    { key: "display.show_reasoning", label: "show reasoning", type: "bool" },
    { key: "display.tool_progress", label: "tool progress", type: "bool" },
    { key: "display.skin", label: "cli skin", type: "select", options: ["default", "mono", "solarized", "matrix", "hacker"] },
  ]},
  { section: "tools & backends", items: [
    { key: "terminal.backend", label: "terminal backend", type: "select", options: ["local", "docker", "ssh", "modal", "singularity", "daytona"] },
    { key: "web.backend", label: "web search backend", type: "select", options: ["auto", "firecrawl", "exa", "tavily", "brave-free", "ddgs", "searxng"] },
    { key: "browser.engine", label: "browser engine", type: "select", options: ["auto", "playwright", "camofox", "browser-use", "browserbase"] },
    { key: "tts.provider", label: "text-to-speech", type: "select", options: ["edge", "openai", "elevenlabs", "xai", "piper", "neutts", "minimax", "mistral"] },
    { key: "stt.provider", label: "speech-to-text", type: "select", options: ["local", "groq", "openai", "mistral"] },
  ]},
  { section: "safety & approvals", items: [
    { key: "approvals.mode", label: "command approvals", type: "select", options: ["manual", "smart", "off"] },
    { key: "security.redact_secrets", label: "redact secrets in output", type: "bool" },
    { key: "privacy.redact_pii", label: "redact PII in gateway", type: "bool" },
  ]},
  { section: "memory & compression", items: [
    { key: "memory.memory_enabled", label: "persistent memory", type: "bool" },
    { key: "memory.user_profile_enabled", label: "user profile memory", type: "bool" },
    { key: "memory.provider", label: "memory provider", type: "select", options: ["builtin", "honcho", "mem0"] },
    { key: "compression.enabled", label: "context compression", type: "bool" },
    { key: "compression.threshold", label: "compression threshold", type: "number" },
    { key: "checkpoints.enabled", label: "filesystem checkpoints", type: "bool" },
  ]},
  { section: "logging", items: [
    { key: "logging.level", label: "log level", type: "select", options: ["DEBUG", "INFO", "WARNING", "ERROR"] },
  ]},
];

// naive yaml getters (read-only display; writes go through `hermes config set`)
function readConfig() {
  try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; }
}
function yamlGet(text, dotted) {
  const parts = dotted.split(".");
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
}
function readEnvKeys() {
  try {
    const text = fs.readFileSync(ENV_PATH, "utf8");
    const keys = {};
    for (const m of text.matchAll(/^([A-Z0-9_]+)=(.+)$/gm)) keys[m[1]] = m[2];
    return keys;
  } catch { return {}; }
}
function writeEnvKey(name, value) {
  let text = "";
  try { text = fs.readFileSync(ENV_PATH, "utf8"); } catch { /* new file */ }
  if (new RegExp(`^${name}=`, "m").test(text)) {
    text = text.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`);
  } else {
    text = text.trimEnd() + (text ? "\n" : "") + `${name}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
}

export default function Config() {
  const [cfgText, setCfgText] = useState(readConfig);
  const [envKeys, setEnvKeys] = useState(readEnvKeys);
  const [provider, setProvider] = useState(() => yamlGet(readConfig(), "model.provider") || "anthropic");
  const [model, setModel] = useState(() => yamlGet(readConfig(), "model.default"));
  const [liveModels, setLiveModels] = useState({}); // provider -> [ids]
  const [keyInput, setKeyInput] = useState("");
  const [showKeyEdit, setShowKeyEdit] = useState(false);
  const [toolsets, setToolsets] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [installRepo, setInstallRepo] = useState("");
  const [busy, setBusy] = useState("");
  const [output, setOutput] = useState("");
  const [personalities, setPersonalities] = useState({});
  const [editPersona, setEditPersona] = useState(null); // {name, text}
  const [oauthLog, setOauthLog] = useState(""); // OAuth flow output
  const [oauthRunning, setOauthRunning] = useState(false);
  const [authList, setAuthList] = useState("");

  const refresh = useCallback(async () => {
    const text = readConfig();
    setCfgText(text);
    setEnvKeys(readEnvKeys());
    setProvider(yamlGet(text, "model.provider") || "anthropic");
    setModel(yamlGet(text, "model.default"));
    // personalities from config
    const pMatch = text.match(/^  personalities:\n((?:    \S[^\n]*\n(?:      [^\n]*\n)*)+)/m);
    if (pMatch) {
      const ps = {};
      for (const m of pMatch[1].matchAll(/^    ([\w-]+):\s*(?:"([^"]*)"|'([^']*)'|(.*))$/gm)) {
        ps[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
      }
      setPersonalities(ps);
    }
    const t = await hermes("tools", "list");
    if (t.ok) {
      setToolsets(t.out.split("\n")
        .map(l => l.match(/([✓✗]) (?:enabled|disabled)\s+(\S+)\s+(.*)$/u))
        .filter(Boolean).map(m => ({ enabled: m[1] === "✓", name: m[2], label: m[3].trim() })));
    }
    const p = await hermes("plugins", "list");
    if (p.ok) {
      setPlugins(p.out.split("\n").filter(l => l.includes("│"))
        .map(l => l.split("│").map(c => c.trim()).filter(Boolean))
        .filter(c => c.length >= 2 && c[0] !== "Name" && c[0])
        .map(c => ({ name: c[0], status: c[1], version: c[2] ?? "", desc: c[3] ?? "" })));
    }
    const al = await hermes("auth", "list");
    if (al.ok) setAuthList(al.out);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Load live model catalog from installed Hermes on disk (single source of truth).
  useEffect(() => {
    const venvPy = path.join(os.homedir(), ".hermes", "hermes-agent", "venv", "bin", "python3");
    execFile(fs.existsSync(venvPy) ? venvPy : "python3", ["-c",
      "import sys,json; sys.path.insert(0,'" + path.join(os.homedir(), ".hermes", "hermes-agent") + "');" +
      "from hermes_cli.models import _PROVIDER_MODELS;" +
      "print(json.dumps({p: list(m) for p,m in _PROVIDER_MODELS.items()}))"
    ], { maxBuffer: 4e6, timeout: 8000 }, (err, out) => {
      if (!err && out) { try { setLiveModels(JSON.parse(out)); } catch {} }
    });
  }, []);

  const models = useMemo(() => {
    const fromLive = liveModels[provider] ?? [];
    const base = PROVIDERS[provider]?.models ?? [];
    return [...new Set([...fromLive, ...base])];
  }, [provider, liveModels]);

  const providerInfo = PROVIDERS[provider] || { env: null, oauth: false, label: provider };
  const envVar = providerInfo.env;
  const hasKey = envVar && !!envKeys[envVar];
  const canOAuth = providerInfo.oauth;

  async function act(label, args) {
    setBusy(label);
    const r = await hermes(...args);
    setOutput(r.ok ? (r.out || "✓ done") : `⚠️ ${r.err || r.out}`);
    setBusy("");
    refresh();
  }

  async function applyModel(newProvider, newModel) {
    setBusy("applying model…");
    await hermes("config", "set", "model.provider", newProvider);
    if (newModel) await hermes("config", "set", "model.default", newModel);
    bus.emit("config-dirty", { reason: "provider/model changed" });
    setBusy("");
    setOutput(`✓ ${newProvider} · ${newModel || "(pick a model)"} — restart chat session for it to apply mid-conversation`);
    refresh();
  }

  function saveKey() {
    if (!envVar || !keyInput.trim()) return;
    writeEnvKey(envVar, keyInput.trim());
    setKeyInput("");
    setShowKeyEdit(false);
    setEnvKeys(readEnvKeys());
    setOutput(`✓ ${envVar} saved to ~/.hermes/.env`);
  }

  // OAuth flow: spawn `hermes auth add <provider> --type oauth` streaming so
  // the user sees the device code / URL to complete sign-in.
  function startOAuth() {
    setOauthLog("");
    setOauthRunning(true);
    const p = spawn(HERMES, ["auth", "add", provider, "--type", "oauth", "--no-browser"],
      { env: { ...process.env } });
    let log = "";
    const push = d => { log += d.toString(); setOauthLog(log); };
    p.stdout.on("data", push);
    p.stderr.on("data", push);
    p.on("close", code => {
      setOauthRunning(false);
      setOauthLog(l => l + `\n[exit ${code}]`);
      refresh();
    });
    p.on("error", e => {
      setOauthRunning(false);
      setOauthLog(l => l + `\n⚠️ ${e.message}`);
    });
  }

  function savePersona() {
    if (!editPersona?.name?.trim()) return;
    act(`saving ${editPersona.name}…`,
      ["config", "set", `agent.personalities.${editPersona.name.trim()}`, editPersona.text]);
    setEditPersona(null);
  }

  const mask = v => (v ? v.slice(0, 4) + "•".repeat(8) + v.slice(-4) : "");

  return (
    <div className="panel-body">
      <div className="cfg-scroll">
        {/* ── provider / model ── */}
        <div className="git-section">model & provider</div>
        <div className="cfg-row">
          <select className="session-select" style={{ maxWidth: 180 }} value={provider}
            onChange={e => { setProvider(e.target.value); setShowKeyEdit(false); setOauthLog(""); }}>
            {Object.entries(PROVIDERS).map(([slug, info]) =>
              <option key={slug} value={slug}>{info.label || slug}</option>
            )}
          </select>
          <select className="session-select" style={{ flex: 1 }} value={model}
            onChange={e => setModel(e.target.value)}>
            <option value="" disabled>select model…</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
            {model && !models.includes(model) && <option value={model}>{model} (current)</option>}
          </select>
          <button className="send-btn" disabled={!!busy || !model} onClick={() => applyModel(provider, model)}>apply</button>
        </div>
        <div className="cfg-hint" style={{ marginTop: 4 }}>
          Model applies to <b>new chat sessions</b>. Click <b>＋</b> in the Chat panel to start a fresh session with the new model.
        </div>

        {/* Auth state for the selected provider */}
        {(envVar || canOAuth) && (
          <div className="cfg-key" style={{ flexWrap: "wrap", gap: 6 }}>
            {envVar && hasKey && !showKeyEdit && (
              <>
                <span className="cfg-key-status ok">✓ {envVar}</span>
                <span className="cfg-key-val">{mask(envKeys[envVar])}</span>
                <button className="tb-btn" onClick={() => setShowKeyEdit(true)}>edit key</button>
              </>
            )}
            {envVar && (!hasKey || showKeyEdit) && (
              <>
                <span className={`cfg-key-status ${hasKey ? "" : "missing"}`}>
                  {hasKey ? envVar : `⚠ ${envVar} not set`}
                </span>
                <input type="password" value={keyInput} placeholder="paste API key…"
                  onChange={e => setKeyInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveKey()} />
                <button className="send-btn" disabled={!keyInput.trim()} onClick={saveKey}>save</button>
                {showKeyEdit && <button className="tb-btn" onClick={() => setShowKeyEdit(false)}>cancel</button>}
              </>
            )}
            {canOAuth && (
              <button className="send-btn" disabled={oauthRunning}
                onClick={startOAuth} title={`hermes auth add ${provider} --type oauth`}>
                {oauthRunning ? "signing in…" : `🔐 sign in with ${providerInfo.label}`}
              </button>
            )}
            {!envVar && !canOAuth && (
              <span className="cfg-key-status">no credentials required</span>
            )}
          </div>
        )}
        {oauthLog && (
          <pre className="git-output" style={{ maxHeight: 200, overflow: "auto", marginTop: 4 }}>
            {oauthLog}
          </pre>
        )}

        {/* ── curated settings ── */}
        {SETTINGS.map(sec => (
          <React.Fragment key={sec.section}>
            <div className="git-section">{sec.section}</div>
            {sec.items.map(item => {
              const cur = yamlGet(cfgText, item.key);
              return (
                <div key={item.key} className="cfg-set-row">
                  <span className="cfg-set-label" title={item.key}>{item.label}</span>
                  {item.type === "select" && (
                    <select className="session-select" value={cur || item.options[0]}
                      onChange={e => act(`setting ${item.label}…`, ["config", "set", item.key, e.target.value])}>
                      {item.options.map(o => <option key={o} value={o}>{o}</option>)}
                      {cur && !item.options.includes(cur) && <option value={cur}>{cur}</option>}
                    </select>
                  )}
                  {item.type === "bool" && (
                    <button className={`cfg-tool ${cur === "true" ? "on" : ""}`}
                      onClick={() => act(`toggling ${item.label}…`, ["config", "set", item.key, cur === "true" ? "false" : "true"])}>
                      <span className="cfg-tool-dot" /> {cur === "true" ? "on" : "off"}
                    </button>
                  )}
                  {item.type === "number" && (
                    <input className="cfg-num" type="number" defaultValue={cur}
                      onBlur={e => e.target.value !== cur && act(`setting ${item.label}…`, ["config", "set", item.key, e.target.value])} />
                  )}
                  {item.type === "personality" && (
                    <select className="session-select" value={cur}
                      onChange={e => act("setting personality…", ["config", "set", item.key, e.target.value])}>
                      {Object.keys(personalities).map(p => <option key={p} value={p}>{p}</option>)}
                      {cur && !personalities[cur] && <option value={cur}>{cur}</option>}
                    </select>
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}

        {/* ── personality / prompt editor ── */}
        <div className="git-section">
          personality prompts
          <div style={{ flex: 1 }} />
          <button className="tb-btn" onClick={() => setEditPersona({ name: "", text: "" })}>+ new</button>
        </div>
        <div className="cfg-tools">
          {Object.entries(personalities).map(([name, text]) => (
            <button key={name} className="cfg-tool" title={text}
              onClick={() => setEditPersona({ name, text })}>
              ✎ {name}
            </button>
          ))}
        </div>
        {editPersona && (
          <div className="git-pr-form" style={{ marginTop: 8 }}>
            <input value={editPersona.name} placeholder="personality name"
              onChange={e => setEditPersona(p => ({ ...p, name: e.target.value }))} />
            <textarea rows={4} value={editPersona.text} placeholder="system prompt for this personality…"
              onChange={e => setEditPersona(p => ({ ...p, text: e.target.value }))} />
            <div style={{ display: "flex", gap: 6 }}>
              <button className="send-btn" onClick={savePersona} disabled={!editPersona.name.trim()}>save</button>
              <button className="tb-btn" onClick={() => setEditPersona(null)}>cancel</button>
            </div>
          </div>
        )}

        {/* ── credentials pool ── */}
        {authList && (
          <>
            <div className="git-section">credentials pool · hermes auth</div>
            <pre className="git-output" style={{ maxHeight: 160, overflow: "auto" }}>{authList}</pre>
          </>
        )}

        {/* ── toolsets ── */}
        <div className="git-section">toolsets · {toolsets.filter(t => t.enabled).length}/{toolsets.length} enabled</div>
        <div className="cfg-tools">
          {toolsets.map(t => (
            <button key={t.name} className={`cfg-tool ${t.enabled ? "on" : ""}`} disabled={!!busy} title={t.label}
              onClick={() => act(`${t.enabled ? "disabling" : "enabling"} ${t.name}…`, ["tools", t.enabled ? "disable" : "enable", t.name])}>
              <span className="cfg-tool-dot" /> {t.name}
            </button>
          ))}
        </div>

        {/* ── plugins ── */}
        <div className="git-section">plugins · {plugins.length}</div>
        {plugins.map(p => (
          <div key={p.name} className="cfg-plugin">
            <span className="cfg-plugin-name">{p.name}</span>
            <span className={`cfg-plugin-status ${p.status.includes("enabled") && !p.status.includes("not") ? "on" : ""}`}>{p.status}</span>
            <span className="cfg-plugin-desc">{p.desc}</span>
            <button className="tb-btn" disabled={!!busy}
              onClick={() => act("toggling…", ["plugins", p.status.includes("not") ? "enable" : "disable", p.name])}>
              {p.status.includes("not") ? "enable" : "disable"}
            </button>
          </div>
        ))}
        <div className="cfg-row" style={{ marginTop: 8 }}>
          <input value={installRepo} onChange={e => setInstallRepo(e.target.value)} placeholder="install: owner/repo or git URL" />
          <button className="send-btn" disabled={!!busy || !installRepo.trim()}
            onClick={() => act("installing…", ["plugins", "install", installRepo.trim()])}>install</button>
        </div>

        {(busy || output) && (
          <>
            <div className="git-section">{busy || "output"}</div>
            <pre className="git-output">{output || "…"}</pre>
          </>
        )}
        <div className="cfg-hint" style={{ marginTop: 10 }}>
          Everything writes through <code>hermes config set</code> / <code>~/.hermes/.env</code> / <code>hermes auth</code>. Full interactive pickers: run <code>hermes model</code> or <code>hermes setup</code> in the Terminal panel.
        </div>
      </div>
    </div>
  );
}
