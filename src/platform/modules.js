// Pure module-resolution helpers for the window.require shim. No DOM access,
// so this runs under node --test.

/** Modules the browser shim provides through window.require(). */
export const SHIM_MODULES = Object.freeze(["fs", "path", "os", "child_process"]);

// Removed modules with a pointer to their replacement, so old panels fail
// with an actionable message instead of a generic one.
const MIGRATIONS = {
  electron:
    'window.require("electron") was removed. Import the browser-native helpers from ' +
    "src/platform/web.js instead: shell.openExternal -> openExternal, clipboard.writeText -> copyText, " +
    'webFrame.setZoomFactor -> setUiScale, ipcRenderer "pick-folder"/"pick-file" -> pickFolder/pickFile, ' +
    '"app-restart" -> reloadApp, desktop notifications -> notify.',
};

/** Build the error thrown when a panel requires a module the shim doesn't provide. */
export function unavailableModuleError(name) {
  const hint = Object.prototype.hasOwnProperty.call(MIGRATIONS, name) ? MIGRATIONS[name] : null;
  const msg = hint
    ? `devtonic-web: ${hint}`
    : `devtonic-web: module "${name}" is not available in the browser build (available: ${SHIM_MODULES.join(", ")})`;
  const e = new Error(msg);
  e.code = "MODULE_NOT_FOUND";
  return e;
}

/** Resolve `name` from `mods`, throwing unavailableModuleError for anything else. */
export function resolveModule(mods, name) {
  if (SHIM_MODULES.includes(name) && Object.prototype.hasOwnProperty.call(mods, name)) return mods[name];
  throw unavailableModuleError(name);
}
