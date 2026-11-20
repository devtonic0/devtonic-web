// UI smoke test: boot the bridge against the built UI, load it in headless
// Chrome, open every panel and assert it renders with no console errors,
// uncaught exceptions or failed requests.
//
// Needs `npm run build` first (serves dist/) and a local Chrome/Chromium
// (auto-detected; override with DEVTONIC_CHROME). Without Chrome the test is
// skipped locally but fails in CI, so the check can't silently disappear.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { findChrome, launchChrome, waitFor } from "./helpers/cdp.mjs";

const PORT = 4791, TOKEN = "smoketoken";
const DIST_INDEX = path.resolve("dist", "index.html");
const chrome = findChrome();
const skip = !fs.existsSync(DIST_INDEX)
  ? "dist/ not built (run npm run build)"
  : !chrome && !process.env.CI ? "no Chrome/Chromium found (set DEVTONIC_CHROME)" : false;

// Tab ids from src/App.jsx TABS, keyed by the title text rendered in rc-dock.
const PANELS = [
  "⚡ Hermes", "⚡ Tasks", "⚙ Workers", "◔ Usage", "🚀 Servers", "⚙ Processes",
  "🌐 Map", "◎ Browser", "🏛 Architecture", "🧩 Features",
  "▣ Progress", "❯ Terminal", "⎇ Git", "🗄 Database", "🗺 Flow", "✎ Notes",
  "⌥ Code", "⚙ Config", "🔑 Secrets",
];
// Not in the default layout; opened from the toolbar's "⊞ panels" menu.
const MENU_PANELS = ["⇪ Workspace", "⚙ Settings", "? Help"];

// Isolated HOME with a tiny project so panels have something to read and the
// user's real settings/mission files are never touched.
function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-smoke-"));
  const proj = path.join(home, "demo-project");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "devtonic.config.json"), JSON.stringify({
    notes: "# Demo", todos: [{ id: "t1", text: "ship", done: false }],
    phases: [{ id: "p1", name: "Build", status: "active" }],
    features: [{ name: "Smoke", desc: "renders", status: "live", stack: ["node"] }],
  }, null, 2));
  fs.writeFileSync(path.join(proj, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(home, ".hermes-mission-control.json"), JSON.stringify({
    setupDone: true, lastProject: proj, recentProjects: [proj],
  }));
  return home;
}

async function bootServer(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, DEVTONIC_PORT: String(PORT), DEVTONIC_TOKEN: TOKEN };
  const p = spawn(process.execPath, ["server/index.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((res, rej) => {
    p.stdout.on("data", d => String(d).includes("running") && res());
    p.on("error", rej);
    setTimeout(() => rej(new Error("bridge boot timeout")), 8000);
  });
  return p;
}

// Errors that come from the headless environment rather than the app.
const IGNORED = [/favicon\.ico/i, /WebGL/i, /GPU stall/i, /GroupMarkerNotSet/i];
const ignorable = text => IGNORED.some(re => re.test(text));

test("ui smoke: every panel renders without console errors", { skip, timeout: 120000 }, async () => {
  assert.ok(chrome, "CI needs Chrome/Chromium for the UI smoke test (set DEVTONIC_CHROME)");
  const home = fixtureHome();
  const srv = await bootServer(home);
  const browser = await launchChrome(chrome);
  const errors = [];
  try {
    const { send, on, evaluate } = browser;
    on("Runtime.exceptionThrown", p => {
      const d = p.exceptionDetails;
      errors.push(`exception: ${d.exception?.description ?? d.text}`);
    });
    on("Runtime.consoleAPICalled", p => {
      if (p.type !== "error" && p.type !== "assert") return;
      errors.push(`console.${p.type}: ${p.args.map(a => a.value ?? a.description ?? "").join(" ")}`);
    });
    on("Log.entryAdded", ({ entry }) => {
      if (entry.level === "error") errors.push(`log(${entry.source}): ${entry.text} ${entry.url ?? ""}`.trim());
    });
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.enable");
    await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?token=${TOKEN}` });

    await waitFor(() => evaluate(`!!document.querySelector(".toolbar") && document.querySelectorAll(".dock-tab").length > 0`),
      { label: "app shell", timeout: 20000 });
    assert.match(await evaluate(`document.querySelector(".proj")?.textContent ?? ""`), /demo-project/,
      "project from the fixture settings is open");

    // rc-dock only mounts a tab's content once it is activated, so click each
    // tab and check the active pane in that group has rendered something.
    const activate = title => evaluate(`(() => {
      const tab = [...document.querySelectorAll(".dock-tab")].find(t => t.textContent.trim() === ${JSON.stringify(title)});
      if (!tab) return "missing";
      (tab.querySelector(".dock-tab-btn") ?? tab).click();
      return "ok";
    })()`);
    const rendered = title => evaluate(`(() => {
      const tab = [...document.querySelectorAll(".dock-tab")].find(t => t.textContent.trim() === ${JSON.stringify(title)});
      if (!tab || !tab.classList.contains("dock-tab-active")) return false;
      const pane = tab.closest(".dock-panel")?.querySelector(".dock-tabpane-active");
      return !!pane && pane.childElementCount > 0 && pane.getBoundingClientRect().height > 0;
    })()`);

    for (const title of PANELS) {
      assert.equal(await activate(title), "ok", `tab "${title}" is in the default layout`);
      await waitFor(() => rendered(title), { label: `panel "${title}" to render` });
    }
    for (const title of MENU_PANELS) {
      const opened = await evaluate(`(() => {
        const btn = [...document.querySelectorAll(".tb-btn")].find(b => b.textContent.includes("panels"));
        btn.click();
        return true;
      })()`);
      assert.ok(opened);
      await waitFor(() => evaluate(`!!document.querySelector(".tb-menu")`), { label: "panels menu" });
      await evaluate(`[...document.querySelectorAll(".tb-menu-item")].find(b => b.textContent.trim() === ${JSON.stringify(title)}).click()`);
      await waitFor(() => rendered(title), { label: `panel "${title}" to render from the menu` });
    }

    // Let polling panels (Tasks, Usage, Workers, worker-report poller) tick.
    await new Promise(r => setTimeout(r, 4500));
    const real = errors.filter(e => !ignorable(e));
    assert.deepEqual(real, [], `console errors:\n${real.join("\n")}`);
  } finally {
    await browser.close();
    srv.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
