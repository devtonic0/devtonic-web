// Hermes CLI location for panels. The bridge resolves it (DEVTONIC_HERMES, then
// PATH, then common install dirs; see server/hermes.mjs) and ships the result
// in /api/env. Call hermesPath() at spawn time rather than caching it, so a
// refreshHermes() after an in-app install takes effect immediately.

const info = () => window.process?.devtonicHermes || { path: "hermes", source: "missing", found: false };

export const hermesPath = () => info().path;
export const hermesFound = () => !!info().found;
export const hermesInfo = () => ({ ...info() });

// Re-ask the bridge (e.g. after the Setup panel installs Hermes).
export async function refreshHermes() {
  const token = localStorage.getItem("devtonic-token") || "";
  try {
    const r = await fetch("/api/env", { headers: { "x-devtonic-token": token } });
    if (r.ok) {
      const env = await r.json();
      if (env.hermes && window.process) window.process.devtonicHermes = env.hermes;
    }
  } catch {}
  return hermesInfo();
}
