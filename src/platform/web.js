// Browser-native platform helpers. These replace the Electron APIs the panels
// used to reach through window.require("electron"): shell, clipboard,
// webFrame, ipcRenderer, and desktop notifications.
import { openPicker } from "./picker.js";
import { extensionsFrom } from "./picker-model.js";
import { safeExternalUrl, shouldNotify, notificationStatus, clampScale, notificationBody } from "./web-model.js";

/**
 * Open a URL in a new browser tab. If the popup is blocked (for example when
 * this isn't called from a user gesture), fall back to the OS opener on the
 * bridge host. The bridge only binds 127.0.0.1, so that host is this machine.
 */
export function openExternal(url) {
  const href = safeExternalUrl(url);
  if (!href) return false;
  const w = window.open(href, "_blank");
  if (w) { try { w.opener = null; } catch {} return true; }
  // Popup blocked (usually because this isn't running from a click).
  try {
    const { execFile } = window.require("child_process");
    const plat = window.process?.platform;
    if (plat === "darwin") execFile("open", [href], {}, () => {});
    else if (plat === "win32") execFile("cmd", ["/c", "start", "", href], {}, () => {});
    else execFile("xdg-open", [href], {}, () => {});
    return true;
  } catch { return false; }
}

/** Copy text to the clipboard. Resolves to true on success. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text)); return true; } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = String(text);
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

/** Reload the UI. This is the browser equivalent of the desktop "restart app". */
export function reloadApp() { location.reload(); }

/** Apply a UI scale (percent) to the whole document. Returns the clamped value. */
export function setUiScale(pct) {
  const v = clampScale(pct);
  document.documentElement.style.zoom = v === 100 ? "" : String(v / 100);
  return v;
}

function listDir(dir) {
  const fs = window.require("fs");
  return fs.readdirSync(dir, { withFileTypes: true })
    .map(d => ({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile() }));
}
const home = () => window.require("os").homedir();

/** In-app folder picker. Resolves to an absolute path, or null if cancelled. */
export function pickFolder(opts = {}) {
  return openPicker({ mode: "folder", home: home(), listDir, ...opts });
}

/** In-app file picker. `filters` uses the [{name, extensions}] dialog shape. */
export function pickFile(filters, opts = {}) {
  return openPicker({ mode: "file", home: home(), extensions: extensionsFrom(filters), listDir, ...opts });
}

// ---- Web Notifications ----
const supported = () => typeof window !== "undefined" && "Notification" in window;

export function notificationState() {
  return notificationStatus({
    supported: supported(),
    permission: supported() ? Notification.permission : "default",
    secure: window.isSecureContext !== false,
  });
}

/** Ask for permission. Browsers only allow this from a user gesture (a click). */
export async function requestNotifications() {
  if (!supported()) return "unsupported";
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/**
 * Show a desktop notification when the tab is hidden or unfocused.
 * Returns the Notification or null. Clicking it focuses the tab and runs onClick.
 */
export function notify(title, { body = "", tag, onClick } = {}) {
  const ok = shouldNotify({
    supported: supported(),
    permission: supported() ? Notification.permission : "default",
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
  });
  if (!ok) return null;
  try {
    const n = new Notification(title, { body: notificationBody(body), tag });
    n.onclick = () => { window.focus(); n.close(); onClick?.(); };
    return n;
  } catch { return null; }
}
