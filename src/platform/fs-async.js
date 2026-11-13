// Async fs for the browser shim: `fs.promises` backed by the bridge's /api/fs
// RPC over fetch(), so panels can read files without blocking the main thread
// on synchronous XHR. Pure logic (no DOM): the transport is injected, which
// lets node --test drive it against a fake or the real bridge.
//
// Method names and return shapes follow Node's `fs/promises` for the subset the
// bridge allow-lists. `exists()` and `readTail()` are non-standard helpers
// (Node has no promise exists(); readTail mirrors the bridge's sync helper).

/** Turn a bridge `{message, code}` error into a Node-style Error. */
export function toError(err) {
  const e = new Error(err?.message || "fs bridge error");
  if (err?.code) e.code = err.code;
  return e;
}

/** Bridge dirent ({name, isDir, isFile}) -> Node-like Dirent. */
export const dirent = d => ({ name: d.name, isDirectory: () => d.isDir, isFile: () => d.isFile });

/** Bridge stat ({size, mtimeMs, mtime, isDir, isFile, mode}) -> Node-like Stats. */
export const stats = s => ({ ...s, mtime: new Date(s.mtime), isDirectory: () => s.isDir, isFile: () => s.isFile });

const encOf = o => (typeof o === "string" ? o : o?.encoding || "utf8");

/**
 * @param rpc  (fn: string, args: any[]) => Promise<{ok: boolean, value?: any, error?: {message, code}}>
 * @returns    Node-like `fs.promises` subset.
 */
export function createFsPromises(rpc) {
  const call = async (fn, ...args) => {
    const r = await rpc(fn, args);
    if (!r || !r.ok) throw toError(r?.error);
    return r.value;
  };
  return {
    readFile: (p, o) => call("readFileSync", p, encOf(o)),
    writeFile: (p, d, o) => call("writeFileSync", p, String(d), o).then(() => undefined),
    access: (p, m) => call("accessSync", p, m).then(() => undefined),
    stat: async p => stats(await call("statSync", p)),
    readdir: async (p, o) => (o?.withFileTypes ? (await call("readdirSync", p, o)).map(dirent) : call("readdirSync", p)),
    mkdir: (p, o) => call("mkdirSync", p, o),
    copyFile: (a, b) => call("copyFileSync", a, b).then(() => undefined),
    chmod: (p, m) => call("chmodSync", p, m).then(() => undefined),
    unlink: p => call("unlinkSync", p).then(() => undefined),
    rename: (a, b) => call("renameSync", a, b).then(() => undefined),
    exists: p => call("existsSync", p),
    readTail: (p, n) => call("readTail", p, n),
  };
}

/** Transport for createFsPromises: POST /api/fs via fetch with the bridge token. */
export function fetchRpc(token, base = "", fetchImpl = globalThis.fetch) {
  return async (fn, args) => {
    const r = await fetchImpl(`${base}/api/fs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-devtonic-token": token },
      body: JSON.stringify({ fn, args }),
    });
    if (r.status === 401) throw new Error("devtonic-web: bad or missing token — open the URL printed by the server");
    return r.json();
  };
}
