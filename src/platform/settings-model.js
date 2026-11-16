// In-memory settings cache with async, coalesced persistence.
//
// Settings (~/.hermes-mission-control.json) are read by many modules, often
// synchronously during render or at import time. Re-reading the file on every
// call meant a blocking bridge round-trip (sync XHR) per read. Instead the file
// is read once at boot (`prime()`), reads come from memory, and writes update
// memory immediately and persist in the background through `fs.promises`.
//
// Pure logic: the file IO is injected, so node --test drives it against real
// Node fs or a fake.

/**
 * @param io  { read(): Promise<string>, write(text: string): Promise<void> }
 * @param opts.onError  called with write errors (default: console.warn)
 */
export function createSettingsStore(io, { onError = e => console.warn("devtonic: settings write failed:", e) } = {}) {
  let cache = {};
  let primed = false;
  let pendingEarly = false; // saved before prime(): write once primed
  let writing = null;   // promise of the in-flight write loop, or null
  let dirty = false;    // a save happened while a write was in flight

  const parse = text => {
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch { return {}; }
  };

  async function writeLoop() {
    // Always write the latest cache; saves made during a write are coalesced
    // into one follow-up write, so the file ends up matching memory.
    do {
      dirty = false;
      try { await io.write(JSON.stringify(cache, null, 2)); }
      catch (e) { onError(e); }
    } while (dirty);
    writing = null;
  }

  return {
    /** Read the file into memory. Missing or corrupt files give {}. */
    async prime() {
      let text = "";
      try { text = await io.read(); } catch { /* missing file */ }
      // Saves made before priming win over what's on disk, and are only
      // written now, so they can't clobber the file before it was read.
      cache = { ...parse(text), ...cache };
      primed = true;
      if (pendingEarly) { pendingEarly = false; this.save({}); }
      return this.load();
    },
    /** Re-read from disk, discarding the in-memory copy (waits for pending writes). */
    async reload() {
      await this.flush();
      let text = "";
      try { text = await io.read(); } catch { /* missing file */ }
      cache = parse(text);
      primed = true;
      return this.load();
    },
    get primed() { return primed; },
    /** A deep copy, so callers can't mutate the cache without saving. */
    load() { return structuredClone(cache); },
    /** Shallow-merge `patch` into memory now; persist in the background. */
    save(patch) {
      cache = { ...cache, ...structuredClone(patch) };
      if (!primed) { pendingEarly = true; return Promise.resolve(); }
      if (writing) dirty = true;
      else writing = writeLoop();
      return writing;
    },
    /** Resolves once every save so far has been written. */
    flush() { return writing ?? Promise.resolve(); },
  };
}
