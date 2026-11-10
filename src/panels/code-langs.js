// File-extension → CodeMirror language mapping. Each language pack is loaded
// on demand so the Code panel chunk only carries the editor core; opening a
// .py file fetches @codemirror/lang-python the first time, and so on.
// Pure mapping (langKeyFor) is unit-tested; loaders are thin dynamic imports.

const EXT_TO_KEY = {
  js: "js", mjs: "js", cjs: "js",
  jsx: "jsx", ts: "ts", tsx: "tsx",
  css: "css", scss: "css", sass: "css", less: "css",
  html: "html", htm: "html", svelte: "html", vue: "html",
  json: "json",
  md: "markdown", mdx: "markdown",
  py: "python", xml: "xml", sql: "sql", rs: "rust",
  c: "cpp", cpp: "cpp", cc: "cpp", h: "cpp", hpp: "cpp",
};

/** Language key for a file path, or null when there is no language pack. */
export function langKeyFor(path) {
  const base = String(path || "").split(/[\\/]/).pop();
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(EXT_TO_KEY, ext) ? EXT_TO_KEY[ext] : null;
}

/** Keys that also get the emmet abbreviation tracker. */
export const EMMET_KEYS = new Set(["jsx", "tsx", "html"]);

const emmet = async () => (await import("@emmetio/codemirror6-plugin")).abbreviationTracker();

const LOADERS = {
  js: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: false }),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  css: async () => (await import("@codemirror/lang-css")).css(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  xml: async () => (await import("@codemirror/lang-xml")).xml(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
};

export const LANG_KEYS = Object.keys(LOADERS);

/** Resolve the extension array for a path ([] when unknown). */
export async function loadLanguage(path) {
  const key = langKeyFor(path);
  if (!key) return [];
  const parts = [LOADERS[key]()];
  if (EMMET_KEYS.has(key)) parts.push(emmet());
  return Promise.all(parts);
}
