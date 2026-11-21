import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentStatus, shouldShowWizard, shouldShowBanner, installSteps, systemToolsHint, DOCS_URL, INSTALL_SH, INSTALL_PS1,
} from "../src/platform/onboarding-model.js";

test("agentStatus: found on PATH, via override, via fallback", () => {
  const p = agentStatus({ path: "/usr/bin/hermes", source: "path", found: true });
  assert.equal(p.state, "ok");
  assert.match(p.detail, /\/usr\/bin\/hermes \(on PATH\)/);
  assert.match(agentStatus({ path: "/x/agent", source: "env", found: true }).detail, /DEVTONIC_HERMES/);
  assert.match(agentStatus({ path: "/h/.local/bin/hermes", source: "fallback", found: true }).detail, /common install dir/);
});

test("agentStatus: missing and broken override are distinguished", () => {
  const m = agentStatus({ path: "hermes", source: "missing", found: false });
  assert.equal(m.state, "missing");
  assert.match(m.title, /not found/);
  const b = agentStatus({ path: "/nope/agent", source: "env", found: false });
  assert.equal(b.state, "bad-override");
  assert.match(b.detail, /DEVTONIC_HERMES=\/nope\/agent/);
});

test("agentStatus: tolerates missing info", () => {
  assert.equal(agentStatus(undefined).state, "missing");
  assert.equal(agentStatus({}).path, "hermes");
});

test("wizard only on a real first run; banner after skip until found or dismissed", () => {
  assert.equal(shouldShowWizard({ setupDone: false, found: false }), true);
  assert.equal(shouldShowWizard({ setupDone: true, found: false }), false);
  assert.equal(shouldShowWizard({ setupDone: false, found: true }), false);
  assert.equal(shouldShowBanner({ setupDone: true, found: false, dismissed: false }), true);
  assert.equal(shouldShowBanner({ setupDone: true, found: false, dismissed: true }), false);
  assert.equal(shouldShowBanner({ setupDone: true, found: true, dismissed: false }), false);
  assert.equal(shouldShowBanner({ setupDone: false, found: false, dismissed: false }), false);
});

test("installSteps: unix uses install.sh + PATH hint, windows uses PowerShell", () => {
  for (const plat of ["linux", "darwin"]) {
    const s = installSteps(plat);
    assert.equal(s[0].command, `curl -fsSL ${INSTALL_SH} | bash`);
    assert.ok(s.some(x => /\.local\/bin/.test(x.command || "")));
    assert.ok(s.some(x => x.command === "hermes model"));
    assert.ok(s.some(x => /DEVTONIC_HERMES=/.test(x.command || "")));
    assert.equal(s.at(-1).url, DOCS_URL);
  }
  const w = installSteps("win32");
  assert.equal(w[0].command, `iwr -useb ${INSTALL_PS1} | iex`);
  assert.ok(!w.some(x => /curl -fsSL/.test(x.command || "")));
});

test("systemToolsHint: per-platform package manager, ignores hermes", () => {
  assert.equal(systemToolsHint("linux", ["hermes"]), "");
  assert.equal(systemToolsHint("linux", []), "");
  assert.equal(systemToolsHint("linux", ["git", "python", "hermes"]), "sudo apt install git python3");
  assert.equal(systemToolsHint("darwin", ["python"]), "brew install python3");
  assert.equal(systemToolsHint("win32", ["git", "python"]), "winget install Git.Git Python.Python.3");
});
