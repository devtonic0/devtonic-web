// Pure helpers for the in-app file/folder picker (src/platform/picker.js).
// No DOM or bridge access here so they can be unit-tested under `node --test`.

/** Normalise a POSIX-ish absolute path: collapse slashes, resolve "." / "..". */
export function normalize(p) {
  const parts = [];
  for (const seg of String(p || "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** Parent directory of an absolute path ("/" stays "/"). */
export function parentDir(p) {
  const n = normalize(p);
  if (n === "/") return "/";
  return n.slice(0, n.lastIndexOf("/")) || "/";
}

export function joinPath(dir, name) {
  return normalize(`${dir}/${name}`);
}

/** Breadcrumb segments: [{label, path}] from "/" down to `p`. */
export function crumbs(p) {
  const n = normalize(p);
  const out = [{ label: "/", path: "/" }];
  let acc = "";
  for (const seg of n.split("/").filter(Boolean)) {
    acc += "/" + seg;
    out.push({ label: seg, path: acc });
  }
  return out;
}

/** Expand a leading "~" against the home directory. */
export function expandHome(p, home) {
  const s = String(p || "").trim();
  if (s === "~") return normalize(home);
  if (s.startsWith("~/")) return normalize(`${home}/${s.slice(2)}`);
  return normalize(s);
}

/** Collect lower-case extensions from Electron-style dialog filters. */
export function extensionsFrom(filters) {
  const exts = [];
  for (const f of filters || []) for (const e of f?.extensions || []) if (e && e !== "*") exts.push(String(e).toLowerCase());
  return exts;
}

/**
 * Filter + sort raw dirents ({name, isDir, isFile}) for display.
 * mode "folder" shows directories only; mode "file" shows directories plus
 * files matching `extensions` (all files when empty). Dirs first, then by name.
 */
export function visibleEntries(entries, { mode = "folder", extensions = [], showHidden = false } = {}) {
  const exts = extensions.map(e => e.toLowerCase());
  return (entries || [])
    .filter(e => showHidden || !e.name.startsWith("."))
    .filter(e => {
      if (e.isDir) return true;
      if (mode !== "file" || !e.isFile) return false;
      if (!exts.length) return true;
      const lower = e.name.toLowerCase();
      return exts.some(x => lower.endsWith("." + x));
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}
