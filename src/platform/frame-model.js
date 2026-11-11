// Pure logic for the Browser panel: URL normalisation, a back/forward stack,
// and deciding whether a response's headers forbid framing by our origin.
// Imported by the UI (Browser.jsx) and the bridge (server/frame-check.mjs).

/** Turn what the user typed into an http(s) URL, or null if it can't be one. */
export function normalizeUrl(input) {
  let t = String(input ?? "").trim();
  if (!t) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(t)) {
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|[\d.]+:\d+)/i.test(t);
    t = `${local ? "http" : "https"}://${t}`;
  }
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch { return null; }
}

// ---- navigation stack ------------------------------------------------------
export const emptyNav = url => ({ stack: url ? [url] : [], idx: url ? 0 : -1 });
export function navPush(nav, url) {
  if (nav.stack[nav.idx] === url) return nav;
  const stack = nav.stack.slice(0, nav.idx + 1).concat(url);
  return { stack, idx: stack.length - 1 };
}
export const navBack = nav => (nav.idx > 0 ? { ...nav, idx: nav.idx - 1 } : nav);
export const navForward = nav => (nav.idx < nav.stack.length - 1 ? { ...nav, idx: nav.idx + 1 } : nav);
export const navCurrent = nav => nav.stack[nav.idx] ?? null;

// ---- frame-blocking verdict -------------------------------------------------
const originOf = u => { try { return new URL(u).origin; } catch { return null; } };

// Does a single CSP source expression match the embedding origin?
function sourceMatches(src, embedder, target) {
  const s = src.toLowerCase();
  if (s === "*") return embedder.protocol === "http:" || embedder.protocol === "https:";
  if (s === "'self'") return embedder.origin === originOf(target);
  if (/^[a-z][a-z\d+.-]*:$/.test(s)) return embedder.protocol === s;
  const m = /^(?:([a-z][a-z\d+.-]*):\/\/)?(\*\.)?([^/:]+|\*)(?::(\d+|\*))?(?:\/.*)?$/.exec(s);
  if (!m) return false;
  const [, scheme, wild, host, port] = m;
  if (scheme && `${scheme}:` !== embedder.protocol) return false;
  const eh = embedder.hostname.toLowerCase();
  if (host !== "*") {
    if (wild ? !eh.endsWith(`.${host}`) : eh !== host) return false;
  }
  const defPort = embedder.protocol === "https:" ? "443" : "80";
  const ep = embedder.port || defPort;
  if (port === "*") return true;
  return (port || (scheme ? (scheme === "https" ? "443" : "80") : defPort)) === ep;
}

function frameAncestors(csp) {
  for (const dir of String(csp).split(";")) {
    const parts = dir.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() === "frame-ancestors") return parts.slice(1);
  }
  return null;
}

/**
 * headers: object with lower-case keys; values may be string or string[].
 * Returns { blocked: boolean, reason: string|null }.
 * CSP frame-ancestors takes precedence over X-Frame-Options (as in browsers);
 * every enforced CSP header must allow us. ALLOW-FROM is ignored like Chrome/Firefox do.
 */
export function frameVerdict(headers, embedderOrigin, targetUrl) {
  const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
  let embedder;
  try { embedder = new URL(embedderOrigin); } catch { return { blocked: false, reason: null }; }

  const policies = list(headers["content-security-policy"]).flatMap(h => String(h).split(","))
    .map(frameAncestors).filter(Boolean);
  if (policies.length) {
    for (const srcs of policies) {
      const ok = srcs.some(s => s.toLowerCase() !== "'none'" && sourceMatches(s, embedder, targetUrl));
      if (!ok) return { blocked: true, reason: `Content-Security-Policy: frame-ancestors ${srcs.join(" ") || "(empty)"}` };
    }
    return { blocked: false, reason: null };
  }

  const xfo = list(headers["x-frame-options"]).flatMap(h => String(h).split(","))
    .map(s => s.trim().toUpperCase()).filter(Boolean);
  if (xfo.includes("DENY")) return { blocked: true, reason: "X-Frame-Options: DENY" };
  if (xfo.includes("SAMEORIGIN") && embedder.origin !== originOf(targetUrl))
    return { blocked: true, reason: "X-Frame-Options: SAMEORIGIN" };
  return { blocked: false, reason: null };
}
