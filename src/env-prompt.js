// Detect missing environment variables from Hermes/tool output and safely
// upsert user-provided values into ~/.hermes/.env. Secrets never leave this
// module — Chat.jsx only receives the list of KEY NAMES, and the modal writes
// values straight to disk without ever handing them back to the LLM.
const fs = window.require("fs");
const path = window.require("path");
const os = window.require("os");

export const HERMES_ENV_PATH = path.join(os.homedir(), ".hermes", ".env");

// Candidate project env files, in preferred write order. First match that
// EXISTS is the default target; if none exist we suggest creating <root>/.env.
const PROJECT_CANDIDATES = [
  ".env.local", ".env",
  "frontend/.env.local", "frontend/.env", "web/.env.local", "web/.env",
  "api/.env", "backend/.env", "server/.env",
  ".env.development", ".env.production",
];

/**
 * Detect env-file targets for the current project + the global Hermes env.
 * Returns [{ label, file, exists, scope }]. Scope is "project" or "global".
 * The first entry is the SUGGESTED default (project .env if any exists,
 * else <root>/.env as a to-be-created file). Global ~/.hermes/.env is
 * always last so the user has to opt into shared/global keys explicitly.
 */
export function detectEnvTargets(projectRoot) {
  const out = [];
  const seen = new Set();
  const push = (file, label, scope) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ file, label, scope, exists: fs.existsSync(file) });
  };
  if (projectRoot) {
    for (const rel of PROJECT_CANDIDATES) {
      const abs = path.join(projectRoot, rel);
      if (fs.existsSync(abs)) push(abs, `${path.basename(projectRoot)} · ${rel}`, "project");
    }
    // Always include a "create <root>/.env" fallback so brand-new projects
    // have somewhere obvious to land.
    const fallback = path.join(projectRoot, ".env");
    if (!seen.has(fallback)) push(fallback, `${path.basename(projectRoot)} · .env (create)`, "project");
  }
  push(HERMES_ENV_PATH, "hermes · ~/.hermes/.env (global)", "global");
  return out;
}

// Env vars we should never prompt for even if a pattern matches — these are
// system/shell things, not API credentials.
const BLOCKLIST = new Set([
  "PATH", "HOME", "USER", "SHELL", "PWD", "OLDPWD", "TERM", "LANG", "LC_ALL",
  "DISPLAY", "XAUTHORITY", "TMPDIR", "EDITOR", "VISUAL", "HOSTNAME", "LOGNAME",
  "SHLVL", "PS1", "PS2", "IFS", "MAIL", "PYTHONPATH", "NODE_PATH", "SSH_AUTH_SOCK",
  "SSH_AGENT_PID", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE",
  "GDM_LANG", "DESKTOP_SESSION",
]);

// Look "env-var-y": all caps + digits + underscore, 3-64 chars, has a letter,
// not purely digits, not a common English word we sometimes see in error text.
const NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const COMMON_WORDS = new Set([
  "ERROR", "WARN", "WARNING", "INFO", "DEBUG", "TRACE", "FATAL", "OK", "TRUE", "FALSE",
  "NULL", "NONE", "NAN", "GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS",
  "HTTP", "HTTPS", "TCP", "UDP", "IP", "URL", "URI", "JSON", "XML", "YAML", "CSV",
  "API", "CLI", "GUI", "TUI", "SDK", "LLM", "AI", "ID", "UUID", "SHA", "MD5", "PID",
  "CPU", "GPU", "RAM", "SSD", "HDD", "USB", "SSH", "TLS", "SSL", "DNS",
  "README", "TODO", "FIXME", "HACK", "XXX", "NOTE", "BUG",
]);

function looksLikeEnvVar(name) {
  if (!NAME_RE.test(name)) return false;
  if (BLOCKLIST.has(name)) return false;
  if (COMMON_WORDS.has(name)) return false;
  // Require either an underscore, or ending in a "credential-ish" hint,
  // OR length >= 6 with mixed digits/letters. Cuts false positives from
  // random shouted words in tracebacks.
  if (name.includes("_")) return true;
  if (name.length >= 8) return true;
  if (/(?:KEY|TOKEN|SECRET|PASS|PWD|URL|URI|HOST|USER|USERNAME|ID)$/.test(name)) return true;
  return false;
}

// Ordered strongest→weakest so we don't over-match. Each regex must have the
// variable name in capture group 1.
const PATTERNS = [
  // llm.js: `Missing OPENAI_API_KEY in ~/.hermes/.env`
  /\bMissing\s+([A-Z][A-Z0-9_]{2,})\b/g,
  // Common error shapes across Node/Python tools:
  /\b([A-Z][A-Z0-9_]{2,})\s+(?:is\s+)?(?:not\s+set|is\s+missing|is\s+required|is\s+undefined|is\s+empty|not\s+found|not\s+defined|not\s+configured|not\s+available)\b/g,
  /\benvironment\s+variable\s+["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s+(?:is\s+)?(?:not\s+set|missing|required|undefined|empty)/gi,
  /\b(?:please\s+)?set\s+(?:the\s+|your\s+)?["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s+(?:environment\s+variable|env\s+var|in\s+your\s+env)/gi,
  /\bset\s+\$?([A-Z][A-Z0-9_]{2,})\s+(?:to|before|first)\b/g,
  /\b(?:you\s+need\s+to|need\s+to)\s+(?:set|provide|add|configure)\s+(?:the\s+|a\s+|your\s+)?["'`]?([A-Z][A-Z0-9_]{2,})["'`]?/gi,
  /\bprovide\s+(?:a\s+|your\s+|the\s+)?["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s+(?:key|token|value|env)/gi,
  /\b(?:add|export)\s+["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s*=/g,
  /\brequires?\s+(?:the\s+|a\s+|your\s+)?["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s+(?:environment\s+variable|env\s+var|to\s+be\s+set|to\s+be\s+configured)/gi,
  /\bexpected\s+(?:the\s+)?["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s+(?:environment\s+variable|env\s+var|to\s+be\s+set)/gi,
  /\bno\s+["'`]?([A-Z][A-Z0-9_]{2,})["'`]?\s+(?:configured|set|found|in\s+env)/gi,
  // KeyError: 'FOO_KEY' in a stack we know is env-lookup
  /KeyError:\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]/g,
  // os.environ['X'] / process.env.X missing
  /os\.environ(?:\.get)?\[?\(?['"`]([A-Z][A-Z0-9_]{2,})['"`]/g,
  /process\.env\.([A-Z][A-Z0-9_]{2,})\s+is\s+(?:undefined|not\s+defined|missing|falsy)/g,
  // "401 Unauthorized ... OPENAI_API_KEY" — hint that the key is bad/missing
  /\b(?:401|403|Unauthorized|invalid\s+api\s+key).{0,80}?\b([A-Z][A-Z0-9_]{4,}(?:_KEY|_TOKEN|_SECRET))\b/gi,
];

/**
 * Scan a chunk of text for missing-env-var hints. Returns an array of unique
 * uppercase var names in first-seen order. Never returns values, only names.
 */
export function detectMissingEnvVars(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1].toUpperCase();
      if (!looksLikeEnvVar(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Which of the given names are ALREADY set in any of the given env FILES?
 * We deliberately ignore process.env — a key inherited from the login shell
 * still belongs in a project .env for reproducibility, and Hermes may be
 * complaining precisely because the value in shell env is wrong/stale.
 * "Set but empty" counts as unset.
 */
export function filterUnset(names, envPaths = [HERMES_ENV_PATH]) {
  const disks = envPaths.map(p => readEnvFile(p));
  return names.filter(n => {
    for (const d of disks) {
      if (d[n] && String(d[n]).trim()) return false;
    }
    return true;
  });
}

function readEnvFile(envPath) {
  try {
    const t = fs.readFileSync(envPath, "utf8");
    const out = {};
    for (const line of t.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch { return {}; }
}

/**
 * Upsert key=value pairs into `envPath` (defaults to ~/.hermes/.env).
 * Existing keys are updated in place; new keys are appended. File is created
 * (with parent dir) if missing. Values with special chars get double-quoted.
 * Returns { written: [names], path }.
 */
export function saveEnvVars(pairs, envPath = HERMES_ENV_PATH) {
  const dir = path.dirname(envPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  let text = "";
  try { text = fs.readFileSync(envPath, "utf8"); } catch { text = ""; }
  const lines = text.split("\n");
  const written = [];

  for (const [key, rawVal] of Object.entries(pairs)) {
    if (!key || rawVal == null || rawVal === "") continue;
    const val = String(rawVal);
    const needsQuote = /[\s#"'\\$`]/.test(val);
    const encoded = needsQuote ? `"${val.replace(/(["\\$`])/g, "\\$1")}"` : val;
    const line = `${key}=${encoded}`;
    const idx = lines.findIndex(l =>
      new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = line;
    else {
      // Trim trailing empties so appends don't stack blank lines.
      while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      lines.push(line);
    }
    written.push(key);
  }

  // Ensure trailing newline.
  let output = lines.join("\n");
  if (!output.endsWith("\n")) output += "\n";
  // Restrict permissions to owner only (best-effort; ignored on non-POSIX).
  fs.writeFileSync(envPath, output, { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch { /* ignore */ }
  return { written, path: envPath };
}

/**
 * Human-friendly hint for a var name — helps the user know what to paste.
 * Purely cosmetic; no network calls, no LLM.
 */
export function hintFor(name) {
  const n = name.toUpperCase();
  const hints = [
    [/^ANTHROPIC_API_KEY$/,       "Anthropic key — starts with sk-ant-…"],
    [/^OPENAI_API_KEY$/,          "OpenAI key — starts with sk-…"],
    [/^OPENROUTER_API_KEY$/,      "OpenRouter key — starts with sk-or-…"],
    [/^DEEPSEEK_API_KEY$/,        "DeepSeek key — starts with sk-…"],
    [/^(GEMINI|GOOGLE)_API_KEY$/, "Google AI Studio key — starts with AIza…"],
    [/^XAI_API_KEY$/,             "xAI key — starts with xai-…"],
    [/^GROQ_API_KEY$/,            "Groq key — starts with gsk_…"],
    [/^GLM_API_KEY$/,             "Z.ai / GLM key"],
    [/^KIMI_API_KEY$/,            "Moonshot Kimi key"],
    [/^REPLICATE(_API)?_TOKEN$/,  "Replicate token — starts with r8_…"],
    [/^HUGGING(FACE)?_?TOKEN$/,   "Hugging Face token — starts with hf_…"],
    [/^GITHUB_TOKEN$/,            "GitHub PAT — starts with ghp_ or github_pat_…"],
    [/^NOTION_TOKEN$/,            "Notion integration token — starts with secret_ or ntn_…"],
    [/^SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY)$/, "Supabase project value"],
    [/_API_KEY$/,                 "API key"],
    [/_TOKEN$/,                   "Auth token"],
    [/_SECRET$/,                  "Secret / signing key"],
    [/_URL$/,                     "URL / endpoint"],
    [/_HOST$/,                    "Hostname"],
    [/(PASS|PWD|PASSWORD)$/,      "Password"],
  ];
  for (const [re, msg] of hints) if (re.test(n)) return msg;
  return "";
}
