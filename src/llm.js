// Direct-to-provider LLM calls for lightweight code operations (fix, complete,
// explain). Uses the same providers/keys the user configured for Hermes, but
// skips the agent loop for one-shot completions where speed > tools.
import { routeModel, classifyTask } from "./routing.js";
const fs = window.require("fs");
const path = window.require("path");
const os = window.require("os");

const CONFIG_PATH = path.join(os.homedir(), ".hermes", "config.yaml");
const ENV_PATH = path.join(os.homedir(), ".hermes", ".env");

// Naive YAML key reader (single-key path, e.g. "model.default").
function yamlGet(text, dotted) {
  const parts = dotted.split(".");
  let indent = 0, idx = 0;
  const lines = text.split("\n");
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

function readEnv() {
  try {
    const t = fs.readFileSync(ENV_PATH, "utf8");
    return Object.fromEntries([...t.matchAll(/^([A-Z0-9_]+)=(.+)$/gm)].map(m => [m[1], m[2]]));
  } catch { return {}; }
}

/**
 * Resolve provider + model + API key. When `tier` is passed and routing is on,
 * downgrades to the tier-appropriate model for the provider.
 * Returns { provider, model, apiKey, endpoint } or throws with a helpful message.
 */
export function llmClient(tier) {
  const cfg = (() => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } })();
  const env = readEnv();
  const provider = yamlGet(cfg, "model.provider") || "anthropic";
  const defaultModel = yamlGet(cfg, "model.default") || "claude-opus-4-7";
  const model = tier ? routeModel(provider, defaultModel, tier) : defaultModel;
  const table = {
    anthropic:  { key: "ANTHROPIC_API_KEY",  endpoint: "https://api.anthropic.com/v1/messages",   kind: "anthropic" },
    openai:     { key: "OPENAI_API_KEY",     endpoint: "https://api.openai.com/v1/chat/completions", kind: "openai" },
    "openai-api":{key: "OPENAI_API_KEY",     endpoint: "https://api.openai.com/v1/chat/completions", kind: "openai" },
    openrouter: { key: "OPENROUTER_API_KEY", endpoint: "https://openrouter.ai/api/v1/chat/completions", kind: "openai" },
    deepseek:   { key: "DEEPSEEK_API_KEY",   endpoint: "https://api.deepseek.com/v1/chat/completions", kind: "openai" },
    gemini:     { key: "GEMINI_API_KEY",     endpoint: "https://generativelanguage.googleapis.com/v1beta/models", kind: "gemini" },
    google:     { key: "GOOGLE_API_KEY",     endpoint: "https://generativelanguage.googleapis.com/v1beta/models", kind: "gemini" },
    xai:        { key: "XAI_API_KEY",        endpoint: "https://api.x.ai/v1/chat/completions",     kind: "openai" },
    groq:       { key: "GROQ_API_KEY",       endpoint: "https://api.groq.com/openai/v1/chat/completions", kind: "openai" },
    zai:        { key: "GLM_API_KEY",        endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", kind: "openai" },
    kimi:       { key: "KIMI_API_KEY",       endpoint: "https://api.moonshot.ai/v1/chat/completions", kind: "openai" },
    "kimi-coding": { key: "KIMI_API_KEY",    endpoint: "https://api.moonshot.ai/v1/chat/completions", kind: "openai" },
  };
  const meta = table[provider];
  if (!meta) throw new Error(`Direct-LLM not supported for provider "${provider}" (use Hermes chat instead)`);
  const apiKey = env[meta.key];
  if (!apiKey) throw new Error(`Missing ${meta.key} in ~/.hermes/.env`);
  return { provider, model, apiKey, endpoint: meta.endpoint, kind: meta.kind };
}

/**
 * One-shot text completion. `messages` is [{role, content}] OpenAI-style;
 * the client re-shapes to whatever the target API expects. Returns the
 * assistant's text (no tool calls, no streaming).
 */
export async function llmComplete({ messages, maxTokens = 400, temperature = 0.2, tier }) {
  const c = llmClient(tier);
  if (c.kind === "anthropic") {
    const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const user = messages.filter(m => m.role !== "system");
    // Newer Anthropic models (Haiku 4.5+, Opus 4.7+) deprecate the `temperature`
    // parameter — sending it causes a 400. Only include it when the caller
    // explicitly asked for a non-default value AND we're on a model that still
    // accepts it. In practice we just always omit it — near-zero temp is fine
    // for our triage/completion tasks.
    const body = {
      model: c.model, max_tokens: maxTokens,
      system: system || undefined,
      messages: user.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    };
    const r = await fetch(c.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": c.apiKey,
        "anthropic-version": "2023-06-01",
        // Required when calling Anthropic from an Electron/browser renderer.
        // Without this header, CORS preflight fails silently on some networks.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.content?.[0]?.text ?? "";
  }
  if (c.kind === "openai") {
    const r = await fetch(c.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.model, messages, max_tokens: maxTokens, temperature }),
    });
    if (!r.ok) throw new Error(`${c.provider} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content ?? "";
  }
  if (c.kind === "gemini") {
    const url = `${c.endpoint}/${c.model}:generateContent?key=${c.apiKey}`;
    const contents = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const systemInstruction = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens },
        systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
      }),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }
  throw new Error(`Unknown LLM kind: ${c.kind}`);
}

/**
 * Get a ghost-text completion continuing the code at the cursor. Returns a
 * short one- or two-line suggestion. `prefix` is text before cursor, `suffix`
 * text after; we ask the model to fill the middle.
 */
export async function ghostComplete({ path, prefix, suffix }) {
  const lang = (path || "").split(".").pop() || "text";
  const text = await llmComplete({
    messages: [
      { role: "system", content:
`You are a code autocompletion service. Given the code before and after the cursor, output ONLY the raw text that should be inserted at the cursor — no code fences, no commentary, no repetition of surrounding text. Keep it short (1-3 lines max). Match the file's language, style, and indentation exactly.` },
      { role: "user", content:
`Language: ${lang}
BEFORE:
${prefix.slice(-1500)}
<CURSOR>
AFTER:
${suffix.slice(0, 300)}` },
    ],
    maxTokens: 120, temperature: 0.15, tier: "cheap",   // small edits → cheapest tier
  });
  // Strip code fences if the model added them anyway.
  return text.replace(/^```[\w-]*\n?|```$/g, "").trimEnd();
}

/**
 * Ask the model to fix a specific problem in a file. Returns the fixed
 * full-file text (caller replaces the buffer).
 */
export async function fixProblem({ path, content, problem }) {
  const lang = (path || "").split(".").pop() || "text";
  const text = await llmComplete({
    messages: [
      { role: "system", content:
`You are a precise code fixer. Given a source file and a diagnostic error, return the ENTIRE fixed file as raw text — no code fences, no commentary. Preserve all unrelated lines exactly. Fix ONLY the reported problem in a minimal way.` },
      { role: "user", content:
`Language: ${lang}
Problem at line ${problem.line}: ${problem.text}

File:
${content}` },
    ],
    maxTokens: Math.max(1000, Math.min(8000, content.length + 500)),
    temperature: 0.1, tier: "mid",   // single-file fix → mid tier
  });
  return text.replace(/^```[\w-]*\n?|```$/g, "").trimEnd();
}
