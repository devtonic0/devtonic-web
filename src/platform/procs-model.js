// Pure, platform-aware helpers for process and port listing.
// No browser or Node globals: everything is passed in so it can be unit-tested.
//
// Portability notes:
// - `ps -o col=` (empty header) is POSIX and suppresses the header row on both
//   procps (Linux) and BSD ps (macOS). `--no-headers` / `--sort` are procps-only.
// - `-U <user>` selects by real user on both, including processes without a tty.
// - Listening ports: `ss -ltnp` on Linux, `lsof -iTCP -sTCP:LISTEN -Fpn` on macOS
//   (and as the Linux fallback when `ss` is missing).

export const PS_FIELDS = {
  pid: "pid",
  cpu: "pcpu",
  mem: "pmem",
  time: "etime",
  cmd: "args",
};

// Build `ps` argv for the requested columns. `cmd` (args) must be last because
// it may contain spaces; it is moved there automatically.
export function psArgs({ fields = ["pid", "cmd"], user = "" } = {}) {
  const cols = fields.filter(f => f !== "cmd");
  if (fields.includes("cmd")) cols.push("cmd");
  for (const f of cols) if (!PS_FIELDS[f]) throw new Error(`unknown ps field: ${f}`);
  const sel = user ? ["-U", user] : ["-A"];
  return [...sel, "-o", cols.map(f => `${PS_FIELDS[f]}=`).join(",")];
}

// "[[dd-]hh:]mm:ss" → seconds. Returns 0 for anything unparseable.
export function etimeToSeconds(etime) {
  const m = String(etime || "").trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, d = 0, h = 0, mm, ss] = m;
  return ((+d * 24 + +h) * 60 + +mm) * 60 + +ss;
}

// Parse header-less `ps` output produced with psArgs({fields}).
export function parsePs(out, fields = ["pid", "cmd"]) {
  const cols = fields.filter(f => f !== "cmd");
  const hasCmd = fields.includes("cmd");
  const rows = [];
  for (const line of String(out || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    if (parts.length < cols.length + (hasCmd ? 1 : 0)) continue;
    const row = {};
    let ok = true;
    cols.forEach((f, i) => {
      const v = parts[i];
      if (f === "time") row.time = v;
      else {
        const n = Number(v);
        if (!Number.isFinite(n)) ok = false;
        row[f] = n;
      }
    });
    if (!ok) continue;
    if (hasCmd) {
      // Re-split preserving the original spacing inside the command.
      const re = new RegExp(`^${"\\S+\\s+".repeat(cols.length)}`);
      row.cmd = t.replace(re, "");
    }
    rows.push(row);
  }
  return rows;
}

// Sort helpers replacing procps' `--sort`.
export function sortProcs(rows, by) {
  const out = [...rows];
  if (by === "-cpu") out.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0));
  else if (by === "start") out.sort((a, b) => etimeToSeconds(b.time) - etimeToSeconds(a.time));
  return out;
}

// Which tool lists listening TCP ports on this platform, in preference order.
export function portTools(platform) {
  return platform === "linux" ? ["ss", "lsof"] : ["lsof"];
}

export function portToolArgs(tool, pid) {
  if (tool === "ss") return ["-ltnp"];
  if (tool === "lsof") return ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid), "-Fpn"];
  throw new Error(`unknown port tool: ${tool}`);
}

const uniqSorted = set => [...set].sort((a, b) => a - b);

// `ss -ltnp` lines contain `users:(("node",pid=1234,fd=20))`.
export function parseSsPorts(out, pid) {
  const ports = new Set();
  for (const line of String(out || "").split("\n")) {
    if (!line.includes(`pid=${pid},`)) continue;
    const m = line.match(/\s(?:\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|\*):(\d+)\s/);
    if (m) ports.add(+m[1]);
  }
  return uniqSorted(ports);
}

// `lsof -Fpn` emits `p<pid>` then `f<fd>` / `n<addr:port>` records.
export function parseLsofPorts(out, pid) {
  const ports = new Set();
  let cur = null;
  for (const line of String(out || "").split("\n")) {
    if (line.startsWith("p")) cur = Number(line.slice(1));
    else if (line.startsWith("n") && (pid == null || cur === Number(pid))) {
      const m = line.match(/:(\d+)$/);
      if (m) ports.add(+m[1]);
    }
  }
  return uniqSorted(ports);
}

export function parsePorts(tool, out, pid) {
  return tool === "ss" ? parseSsPorts(out, pid) : parseLsofPorts(out, pid);
}
