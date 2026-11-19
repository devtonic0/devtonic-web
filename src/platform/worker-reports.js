// Background-worker report scanner used by App's completion poller. DOM-free
// and IO-injected (Node `fs/promises` or the shim's `fs.promises`), so it runs
// under node --test.
//
// Layout: <root>/<id>/report.json, written by a detached fix-worker when it
// finishes. `seen` maps worker id -> report mtime (ms, floored) that has
// already been handled; a changed mtime means a new report.

/**
 * @param {object} o
 * @param {object} o.fsp     fs/promises-like ({ readdir, stat, readFile })
 * @param {(...p: string[]) => string} o.join  path.join
 * @param {string} o.root    fix-workers directory
 * @param {Record<string, number>} o.seen  previously handled report mtimes
 * @param {boolean} o.readNew  read and return new reports (false while priming)
 * @returns {Promise<{ seen: Record<string, number>, changed: boolean, listed: boolean, reports: {id: string, report: object}[] }>}
 */
export async function scanWorkerReports({ fsp, join, root, seen = {}, readNew = true }) {
  const next = { ...seen };
  let names;
  try {
    names = (await fsp.readdir(root, { withFileTypes: true }))
      .filter(d => d.isDirectory() && d.name !== "specs")
      .map(d => d.name);
  } catch {
    return { seen: next, changed: false, reports: [], listed: false };
  }
  const found = await Promise.all(names.map(async id => {
    const rp = join(root, id, "report.json");
    let mtime;
    try { mtime = Math.floor((await fsp.stat(rp)).mtimeMs); } catch { return null; }
    if (seen[id] === mtime) return null;
    let report = null;
    if (readNew) {
      try { report = JSON.parse(await fsp.readFile(rp, "utf8")); } catch { /* partial/invalid */ }
    }
    return { id, mtime, report };
  }));
  const reports = [];
  let changed = false;
  for (const f of found) {
    if (!f) continue;
    changed = true;
    next[f.id] = f.mtime;
    if (f.report) reports.push({ id: f.id, report: f.report });
  }
  return { seen: next, changed, reports, listed: true };
}

/** Chat-stream markdown for a finished worker report. */
export function formatWorkerReport(rep) {
  const git = (rep.git || [])
    .map(g => `${g.repo}: ${g.dirty > 0 ? g.dirty + " uncommitted" : "clean"} — ${g.head}`)
    .join("\n");
  return `${rep.ok ? "✅" : "⚠️"} **${rep.fix_id}** worker finished (rc=${rep.rc}, ${rep.duration_s}s)\n\n${rep.summary || ""}\n\n**git state:**\n${git}`;
}
