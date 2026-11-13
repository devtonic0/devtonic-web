// Secrets panel logic, async and DOM-free. All file access goes through an
// injected Node-style `fs.promises` (`fsp`) and `path`, so the same code runs
// against the browser shim and under node --test.

// Directories we never descend into (huge, no user env files worth reading).
export const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", "dist", "build", "out",
  ".venv", "venv", "__pycache__", ".cache", "coverage", ".pnpm-store",
  "target", ".yarn", ".nuxt", ".output", ".svelte-kit", ".astro",
  ".terraform", "release", "linux-unpacked",
]);

/** Files a dev would actually put env vars in. */
export function isEnvFile(name) {
  return /^\.env(\..+)?$/.test(name) || name === "env" || name === ".envrc";
}

const exists = (fsp, p) => fsp.access(p).then(() => true, () => false);

/**
 * Depth-limited depth-first walk for env files. Returns absolute paths in the
 * same order as the original sync walk (directory entries in readdir order,
 * recursing as directories are met).
 */
export async function findEnvFiles(fsp, path, root, maxDepth = 6, maxFiles = 40) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        // Skip dot dirs except ones that may hold env files.
        if (e.name.startsWith(".") && e.name !== ".env.d" && e.name !== ".config") continue;
        await walk(full, depth + 1);
      } else if (isEnvFile(e.name)) {
        out.push(full);
      }
    }
  }
  await walk(root, 0);
  return out;
}

/**
 * Sections (tabs) for the panel. Explicit `mission.secrets` wins; otherwise
 * project .env/.env.local, every env file found, then the global hermes env.
 * Each section carries `exists` so render never touches the filesystem.
 */
export async function detectSections(fsp, path, root, { mission, homedir }) {
  let list;
  if (mission?.secrets?.length) {
    list = mission.secrets.map(s => ({
      name: s.name,
      file: path.isAbsolute(s.file) ? s.file : path.join(root, s.file),
    }));
  } else {
    const seen = new Set();
    list = [];
    const push = (file, name) => {
      if (seen.has(file)) return;
      seen.add(file);
      list.push({ file, name });
    };
    push(path.join(root, ".env"), `${path.basename(root)} · .env`);
    push(path.join(root, ".env.local"), `${path.basename(root)} · .env.local`);
    for (const file of await findEnvFiles(fsp, path, root)) {
      const rel = path.relative(root, file);
      const parts = rel.split(path.sep);
      const label = parts.length === 1
        ? `${path.basename(root)} · ${rel}`
        : `${parts.slice(0, -1).join("/")} · ${parts[parts.length - 1]}`;
      push(file, label);
    }
    push(path.join(homedir, ".hermes", ".env"), "hermes · global");
  }
  const flags = await Promise.all(list.map(s => exists(fsp, s.file)));
  return list.map((s, i) => ({ ...s, exists: flags[i] }));
}

export const parse = text => text.split("\n").map((line, i) => {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  return m ? { key: m[1], value: m[2].replace(/^["']|["']$/g, ""), line: i } : null;
}).filter(Boolean);

export const mask = v => (v.length <= 6 ? "•".repeat(v.length) : v.slice(0, 3) + "•".repeat(Math.min(v.length - 5, 18)) + v.slice(-2));

/**
 * Set `key` in env text, preserving all other lines; appends when absent.
 * Values with whitespace/#/quotes/$ are double-quoted and escaped so a shell
 * re-parse yields the same value.
 */
export function upsertVar(existing, key, value) {
  const needsQuote = /[\s#"'`$]/.test(value);
  const escaped = needsQuote ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
  if (existing === "") return `${key}=${escaped}`;   // new/empty file: no leading blank line
  let found = false;
  const out = existing.split("\n").map(line => {
    const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    if (m && m[2] === key) { found = true; return `${m[1]}${m[2]}=${escaped}`; }
    return line;
  });
  if (!found) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push(`${key}=${escaped}`);
  }
  return out.join("\n");
}

/** Drop every assignment of `key` from env text. */
export function removeVar(existing, key) {
  return existing.split("\n").filter(line => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !m || m[1] !== key;
  }).join("\n");
}

const readOr = (fsp, file, dflt) => fsp.readFile(file, "utf8").catch(e => {
  if (e?.code === "ENOENT") return dflt;
  throw e;
});

/** Vars in `file`, or [] when it doesn't exist yet. */
export async function readVars(fsp, file) {
  const text = await readOr(fsp, file, null);
  return text == null ? [] : parse(text);
}

/** Create/update a key; creates the file (and parent dirs) mode 0600. */
export async function writeVar(fsp, path, file, key, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const existing = await readOr(fsp, file, "");
  await fsp.writeFile(file, upsertVar(existing, key, value));
  try { await fsp.chmod(file, 0o600); } catch { /* ignore */ }
}

/** Remove a key; a missing file is a no-op. */
export async function deleteVar(fsp, file, key) {
  const existing = await readOr(fsp, file, null);
  if (existing == null) return;
  await fsp.writeFile(file, removeVar(existing, key));
}
