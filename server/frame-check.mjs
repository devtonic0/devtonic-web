// Fetches a URL from the bridge (no CORS limits there) and reports whether its
// response headers would stop the Browser panel's <iframe> from rendering it.
import { frameVerdict } from "../src/platform/frame-model.js";

export async function checkFrame(url, embedderOrigin, { timeoutMs = 6000 } = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: "invalid url" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "only http(s) urls can be checked" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(u.href, { redirect: "follow", signal: ctl.signal,
      headers: { "user-agent": "Mozilla/5.0 devtonic-web frame-check", accept: "text/html,*/*" } });
    const headers = {};
    for (const [k, v] of res.headers) (headers[k] = headers[k] || []).push(v);
    res.body?.cancel().catch(() => {});
    const finalUrl = res.url || u.href;
    return { ok: true, status: res.status, finalUrl, ...frameVerdict(headers, embedderOrigin, finalUrl) };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timed out" : (e.cause?.code || e.message) };
  } finally { clearTimeout(timer); }
}
