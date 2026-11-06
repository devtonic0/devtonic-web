// Smart model routing — pick the cheapest capable model for each task.
// Tiers reflect current-gen frontier → mini/cheap. User can override any tier
// in ~/.hermes-mission-control.json under `modelRouting`.
//
// Design goal: nothing surprising. If the user has NOT configured a routing
// override for a tier, we fall back to the currently-selected default model —
// so users who want a single model everywhere get it, and users who opt in to
// routing get automatic cost savings.

import { loadSettings, saveSettings } from "./store.js";

// Default tier assignments per provider — updated as new models ship.
const DEFAULTS = {
  anthropic: {
    top:    "claude-fable-5-1",      // hardest reasoning
    strong: "claude-opus-5-5",       // strong default
    mid:    "claude-sonnet-4-6",     // most work
    cheap:  "claude-haiku-4-5",      // ghost completion, tiny edits
  },
  openai: {
    top: "gpt-5.5-pro", strong: "gpt-5.5", mid: "gpt-5.4-mini", cheap: "gpt-5.4-nano",
  },
  "openai-api": {
    top: "gpt-5.5-pro", strong: "gpt-5.5", mid: "gpt-5.4-mini", cheap: "gpt-5.4-nano",
  },
  openrouter: {
    top: "anthropic/claude-fable-5.1", strong: "anthropic/claude-opus-5.5",
    mid: "anthropic/claude-sonnet-4-6", cheap: "anthropic/claude-haiku-4.5",
  },
  gemini:    { top: "gemini-3.1-pro-preview", strong: "gemini-3-pro-preview", mid: "gemini-3.5-flash", cheap: "gemini-3.1-flash-lite-preview" },
  google:    { top: "gemini-3.1-pro-preview", strong: "gemini-3-pro-preview", mid: "gemini-3.5-flash", cheap: "gemini-3.1-flash-lite-preview" },
  xai:       { top: "grok-4.3", strong: "grok-4.20-0309-reasoning", mid: "grok-4.20-0309-non-reasoning", cheap: "grok-composer-2.5-fast" },
  deepseek:  { top: "deepseek-v4-pro", strong: "deepseek-v4-pro", mid: "deepseek-v4-flash", cheap: "deepseek-v4-flash" },
  zai:       { top: "glm-5.2", strong: "glm-5.1", mid: "glm-5", cheap: "glm-4.5-flash" },
  groq:      { top: "llama-4-70b", strong: "llama-4-70b", mid: "llama-3.3-70b", cheap: "mixtral-9x22b" },
  nous:      { top: "anthropic/claude-fable-5.1", strong: "anthropic/claude-opus-5.5", mid: "anthropic/claude-sonnet-5", cheap: "anthropic/claude-haiku-4.5" },
};

/**
 * Get the model to use for a given task tier ("cheap" | "mid" | "strong" | "top").
 *
 * @param provider  Current provider slug (from Hermes config).
 * @param defaultModel  User's currently-selected model — used when routing is off
 *                      or when the requested tier has no mapping for this provider.
 * @param tier      Task complexity tier.
 * @returns Model id string (or defaultModel if routing disabled / no mapping).
 */
export function routeModel(provider, defaultModel, tier) {
  const settings = loadSettings();
  const enabled = settings.modelRouting?.enabled ?? false;
  if (!enabled) return defaultModel;
  const userOverride = settings.modelRouting?.[provider]?.[tier];
  if (userOverride) return userOverride;
  return DEFAULTS[provider]?.[tier] || defaultModel;
}

/**
 * Classify prompt/task into a tier.
 *
 *  ghost      → cheap    (autocomplete, one-liners)
 *  fix        → mid      (patch a diagnostic in a single file)
 *  refactor   → strong   (multi-file edits, spec conformance)
 *  reason     → top      (planning, debugging, architecture)
 *
 * Callers can hint via `hint`. Chat prompts default to `mid` because they
 * carry conversational context the model needs (short "fix that" style
 * follow-ups still need the full session, so haiku isn't safe).
 */
export function classifyTask({ hint, prompt = "", contextChars = 0 }) {
  if (hint) return hint;
  const p = prompt.toLowerCase();
  // Reasoning/planning verbs → top tier regardless of length
  if (/\b(why|design|plan|architect|debug|root cause|analy[sz]e|investigate|explain|trace|figure out|research)\b/.test(p)) return "top";
  // Refactor/multi-file → strong
  if (/\b(refactor|redesign|migrate|rewrite|large|multi[- ]file|overhaul|restructure)\b/.test(p)) return "strong";
  // Everything else in chat → mid (Sonnet-tier). Only bother with cheap when
  // caller explicitly hints "cheap" — chat follow-ups are never truly cheap.
  const total = prompt.length + contextChars;
  if (total < 80 && /^(yes|no|ok|thanks|nvm|done)\b/i.test(prompt.trim())) return "cheap";
  return "mid";
}

export function routingStatus() {
  const s = loadSettings();
  return {
    enabled: s.modelRouting?.enabled ?? false,
    overrides: s.modelRouting ?? {},
  };
}

export function setRouting(patch) {
  const s = loadSettings();
  const next = { ...(s.modelRouting ?? {}), ...patch };
  saveSettings({ modelRouting: next });
}
