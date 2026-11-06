// Open a URL in the user's system default browser reliably across platforms.
// Electron's `shell.openExternal` can hang on Linux (MimeDB init in the sandbox);
// spawning xdg-open / open / start directly bypasses that.
const { spawn } = window.require("child_process");
const { shell } = window.require("electron");

export function openInBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" :
    platform === "win32"  ? "start" :
    "xdg-open";
  try {
    const args = platform === "win32" ? ["", url] : [url];
    const p = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      shell: platform === "win32",
    });
    p.unref();
    return true;
  } catch {
    try { shell.openExternal(url); return true; } catch { return false; }
  }
}
