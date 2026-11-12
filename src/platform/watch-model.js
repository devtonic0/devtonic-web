// Pure polling-watch logic for the browser fs shim. No DOM / timers here, so
// it runs under node --test; shim.js drives tick() from setInterval.
//
// Node's fs.watch(path, cb) calls cb(eventType, filename). The shim can't get
// real inotify/FSEvents events over the bridge, so it polls the path's mtime.
// To stay compatible with callers that filter on `filename`, the poller reports
// the watched path's basename (Node reports the same for a watched file) and
// distinguishes appear/disappear ("rename") from content edits ("change").

const basename = p => String(p).replace(/\/+$/, "").split("/").pop() || String(p);

/**
 * Create a poller for `p`.
 * @param p        Watched path.
 * @param readMtime  () => number; throws when the path doesn't exist.
 * @param onEvent  (eventType: "change" | "rename", filename: string) => void
 * @returns {{ tick: () => void }}  Call tick() on every poll interval. The first
 *   tick only records the baseline and never fires.
 */
export function createMtimePoller(p, readMtime, onEvent) {
  const name = basename(p);
  let primed = false;
  let last; // number = mtime, null = missing
  return {
    tick() {
      let cur;
      try { cur = readMtime(); } catch { cur = null; }
      if (primed && cur !== last) onEvent((cur === null) !== (last === null) ? "rename" : "change", name);
      last = cur;
      primed = true;
    },
  };
}
