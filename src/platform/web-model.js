// Pure helpers behind src/platform/web.js. No DOM access, so they run under node --test.

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Return a normalized URL string if it is safe to open externally, else null. */
export function safeExternalUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  return SAFE_SCHEMES.has(u.protocol) ? u.href : null;
}

/**
 * Decide whether a Web Notification should be shown.
 * We skip it when the tab is visible and focused, because the in-app chat
 * message already covers that case.
 */
export function shouldNotify({ supported, permission, visible, focused }) {
  if (!supported || permission !== "granted") return false;
  return !(visible && focused);
}

/** Human label, plus whether the "enable" button should be offered. */
export function notificationStatus({ supported, permission, secure }) {
  if (!supported) return { label: "not supported by this browser", canRequest: false };
  if (!secure) return { label: "needs a secure context (use 127.0.0.1 or localhost)", canRequest: false };
  if (permission === "granted") return { label: "enabled", canRequest: false };
  if (permission === "denied") return { label: "blocked in browser site settings", canRequest: false };
  return { label: "not enabled", canRequest: true };
}

/** Clamp a UI-scale percentage to the supported range. */
export function clampScale(pct, min = 70, max = 160) {
  if (pct === null || pct === undefined || pct === "") return 100;
  const n = Number(pct);
  if (!Number.isFinite(n)) return 100;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Truncate a notification body, avoiding a split in the last word when possible. */
export function notificationBody(text, max = 140) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + "…";
}
