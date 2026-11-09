// Locate the Hermes CLI for the bridge. Pure apart from the injected `isExec`
// probe, so it is unit-tested in test/hermes.test.mjs.
//
// Order:
//   1. DEVTONIC_HERMES (explicit override; reported even if it isn't executable)
//   2. every directory on PATH (same as `which hermes`)
//   3. common install locations that a GUI-launched server's PATH often lacks
//      (~/.local/bin is where the official installer puts it)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// devtonic-agent users can point DEVTONIC_HERMES at its binary.
export const HERMES_NAMES = ["hermes"];

export function fallbackDirs(homedir) {
  return [
    path.join(homedir, ".local", "bin"),
    path.join(homedir, ".hermes", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
}

export function defaultIsExec(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

const expandHome = (p, homedir) => (p === "~" ? homedir : p.startsWith("~/") ? path.join(homedir, p.slice(2)) : p);

// → { path, source: "env" | "path" | "fallback" | "missing", found }
export function resolveHermes({ env = process.env, homedir = os.homedir(), isExec = defaultIsExec, names = HERMES_NAMES } = {}) {
  const override = (env.DEVTONIC_HERMES || "").trim();
  if (override) {
    const p = path.resolve(expandHome(override, homedir));
    return { path: p, source: "env", found: isExec(p) };
  }
  const pathDirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of pathDirs) {
      const p = path.join(dir, name);
      if (isExec(p)) return { path: p, source: "path", found: true };
    }
  }
  for (const name of names) {
    for (const dir of fallbackDirs(homedir)) {
      const p = path.join(dir, name);
      if (isExec(p)) return { path: p, source: "fallback", found: true };
    }
  }
  // Not installed: hand back the bare name so spawn() fails with a clear ENOENT.
  return { path: names[0], source: "missing", found: false };
}
