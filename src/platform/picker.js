// In-app file/folder picker for the browser build. Replaces the old prompt()
// dialogs behind ipcRenderer.invoke("pick-folder" | "pick-file"). Plain DOM so
// the shim can use it before React mounts. Listing goes through the bridge's
// readdirSync (passed in as `listDir`).
import { normalize, parentDir, joinPath, crumbs, expandHome, visibleEntries } from "./picker-model.js";

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
};

/**
 * Open the picker. Resolves to an absolute path, or null when cancelled.
 * @param {object} o
 * @param {"folder"|"file"} o.mode
 * @param {string} o.home     home dir (start dir + "~" expansion)
 * @param {string} [o.start]  initial directory
 * @param {string[]} [o.extensions] file-mode extension filter
 * @param {(dir:string)=>Array<{name,isDir,isFile}>} o.listDir
 */
export function openPicker({ mode = "folder", home, start, extensions = [], listDir, title }) {
  return new Promise(resolve => {
    let cwd = normalize(start || home);
    let showHidden = false;
    let selectedFile = null;

    const back = el("div", { class: "modal-back picker-back" });
    const box = el("div", { class: "modal picker", role: "dialog", "aria-label": title || "Pick" });
    const head = el("div", { class: "modal-title" }, title || (mode === "folder" ? "Choose a folder" : "Choose a file"));
    const crumbBar = el("div", { class: "picker-crumbs" });
    const pathInput = el("input", { class: "picker-path", spellcheck: "false", "aria-label": "Path" });
    const list = el("div", { class: "picker-list", role: "listbox", tabindex: "0" });
    const err = el("div", { class: "picker-err" });
    const hidden = el("input", { type: "checkbox" });
    const okBtn = el("button", { class: "picker-ok" }, mode === "folder" ? "Open this folder" : "Open");
    const cancelBtn = el("button", { class: "picker-cancel" }, "Cancel");
    const foot = el("div", { class: "picker-foot" },
      el("label", { class: "picker-hidden" }, hidden, " show hidden"),
      el("span", { style: "flex:1" }), cancelBtn, okBtn);
    box.append(head, crumbBar, pathInput, list, err, foot);
    back.append(box);

    const done = v => { back.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };

    function render() {
      err.textContent = "";
      crumbBar.replaceChildren(...crumbs(cwd).map((c, i, all) =>
        el("button", { class: "picker-crumb" + (i === all.length - 1 ? " cur" : ""), onclick: () => go(c.path) }, c.label)));
      pathInput.value = selectedFile || cwd;
      let raw;
      try { raw = listDir(cwd); } catch (e) { err.textContent = e.message; raw = []; }
      const rows = visibleEntries(raw, { mode, extensions, showHidden });
      const up = cwd === "/" ? [] : [el("div", { class: "picker-row dir", ondblclick: () => go(parentDir(cwd)), onclick: () => go(parentDir(cwd)) }, "↰ ..")];
      list.replaceChildren(...up, ...rows.map(r => {
        const full = joinPath(cwd, r.name);
        const row = el("div", { class: "picker-row " + (r.isDir ? "dir" : "file") + (full === selectedFile ? " sel" : ""), title: full },
          (r.isDir ? "📁 " : "📄 ") + r.name);
        if (r.isDir) row.addEventListener("click", () => go(full));
        else {
          row.addEventListener("click", () => { selectedFile = full; render(); });
          row.addEventListener("dblclick", () => done(full));
        }
        return row;
      }));
      if (!rows.length && !err.textContent) list.append(el("div", { class: "picker-empty" }, mode === "folder" ? "No subfolders" : "No matching files"));
      okBtn.disabled = mode === "file" && !selectedFile;
    }
    function go(dir) { cwd = normalize(dir); selectedFile = null; render(); }

    pathInput.addEventListener("keydown", e => {
      if (e.key !== "Enter") return;
      const target = expandHome(pathInput.value, home);
      try {
        listDir(target);
        go(target);
      } catch (ex) {
        if (mode === "file" && ex.code === "ENOTDIR") return done(target);
        err.textContent = ex.message;
      }
    });
    hidden.addEventListener("change", () => { showHidden = hidden.checked; render(); });
    cancelBtn.addEventListener("click", () => done(null));
    okBtn.addEventListener("click", () => done(mode === "folder" ? cwd : selectedFile));
    back.addEventListener("mousedown", e => { if (e.target === back) done(null); });
    document.addEventListener("keydown", onKey, true);

    document.body.append(back);
    render();
    list.focus();
  });
}
