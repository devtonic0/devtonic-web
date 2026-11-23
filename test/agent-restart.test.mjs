import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { restartAgentGateway, GATEWAY_RESTART_ARGS } from "../server/agent-api.mjs";
import { agentApiHint, waitForAgent } from "../src/platform/agent-stream.js";

const cfg = { url: "http://127.0.0.1:1", key: "", keySource: "none", disabled: false };
const found = { path: "/opt/agent/bin/hermes", source: "path", found: true };

test("restartAgentGateway runs the resolved CLI with fixed argv and reports output", async () => {
  const calls = [];
  const execFileImpl = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, "Gateway restarted\n", ""); };
  const r = await restartAgentGateway(cfg, { hermes: found, execFileImpl });
  assert.deepEqual(r, { ok: true, output: "Gateway restarted" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, found.path);
  assert.deepEqual(calls[0].args, GATEWAY_RESTART_ARGS);
  assert.equal(calls[0].opts.shell, undefined, "never through a shell");
});

test("restartAgentGateway: disabled, missing CLI, failure and timeout", async () => {
  const never = () => { throw new Error("must not exec"); };
  assert.equal((await restartAgentGateway({ ...cfg, disabled: true }, { hermes: found, execFileImpl: never })).code, "disabled");
  assert.equal((await restartAgentGateway(cfg, { hermes: null, execFileImpl: never })).code, "no-hermes");
  const bad = await restartAgentGateway(cfg, { hermes: { path: "/x/h", source: "env", found: false }, execFileImpl: never });
  assert.equal(bad.code, "no-hermes");
  assert.match(bad.error, /DEVTONIC_HERMES=\/x\/h/);
  const failed = await restartAgentGateway(cfg, { hermes: found,
    execFileImpl: (f, a, o, cb) => cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "no gateway service installed\n") });
  assert.deepEqual([failed.ok, failed.code, failed.error], [false, "failed", "no gateway service installed"]);
  const slow = await restartAgentGateway(cfg, { hermes: found, timeoutMs: 5000,
    execFileImpl: (f, a, o, cb) => cb(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "", "") });
  assert.equal(slow.code, "timeout");
  assert.match(slow.error, /5s/);
});

test("agentApiHint offers the restart button only when the bridge can restart", () => {
  const down = { available: false, reason: "unreachable", keySource: "dotenv" };
  assert.equal(agentApiHint(down).action, undefined);
  assert.equal(agentApiHint({ ...down, restartable: true }).action, "restart gateway");
  assert.equal(agentApiHint({ ...down, keySource: "none", reason: "no-key", restartable: true }, { enabled: true }).action, "restart gateway");
  assert.equal(agentApiHint({ available: false, reason: "unauthorized", keySource: "env", restartable: true }).action, "restart gateway");
  // The enable hint keeps its own action.
  assert.equal(agentApiHint({ available: false, reason: "no-key", keySource: "none", restartable: true }).action, "enable agent API");
});

test("waitForAgent polls until available, stops early on a rejected key, else gives up", async () => {
  const sleep = async () => {};
  let n = 0;
  const up = await waitForAgent(async () => (++n < 3 ? { available: false, reason: "unreachable" } : { available: true }), { sleep });
  assert.deepEqual([up.available, n], [true, 3]);
  n = 0;
  const rejected = await waitForAgent(async () => { n++; return { available: false, reason: "unauthorized" }; }, { sleep });
  assert.deepEqual([rejected.reason, n], ["unauthorized", 1]);
  n = 0;
  const never = await waitForAgent(async () => { n++; return { available: false, reason: "unreachable" }; }, { sleep, tries: 4 });
  assert.deepEqual([never.reason, n], ["unreachable", 4]);
});

test("bridge POST /api/agent/restart runs DEVTONIC_HERMES gateway restart (fake CLI)", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-restart-"));
  const fake = path.join(dir, "fake-hermes");
  const log = path.join(dir, "args.txt");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" > "${log}"\necho "restarted ok"\n`, { mode: 0o755 });
  const PORT = 4784, TOKEN = "restarttok";
  const env = { ...process.env, DEVTONIC_PORT: String(PORT), DEVTONIC_TOKEN: TOKEN, HERMES_HOME: dir,
    DEVTONIC_AGENT_URL: "http://127.0.0.1:1", DEVTONIC_AGENT_API: "", DEVTONIC_HERMES: fake };
  const bridge = spawn(process.execPath, ["server/index.mjs"], { env });
  try {
    await new Promise((res, rej) => { bridge.stdout.on("data", d => String(d).includes("running") && res()); bridge.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
    const base = `http://127.0.0.1:${PORT}`;
    const h = { "x-devtonic-token": TOKEN, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/agent/restart`, { method: "POST" })).status, 401);
    const st = await (await fetch(`${base}/api/agent/status`, { headers: h })).json();
    assert.equal(st.restartable, true);
    const r = await fetch(`${base}/api/agent/restart`, { method: "POST", headers: h, body: "{}" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, output: "restarted ok" });
    assert.equal(fs.readFileSync(log, "utf8").trim(), "gateway restart");
  } finally { bridge.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("bridge reports restartable=false and 409 when the CLI is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devtonic-restart-missing-"));
  const PORT = 4785, TOKEN = "restarttok2";
  const env = { ...process.env, DEVTONIC_PORT: String(PORT), DEVTONIC_TOKEN: TOKEN, HERMES_HOME: dir,
    DEVTONIC_AGENT_URL: "http://127.0.0.1:1", DEVTONIC_AGENT_API: "", DEVTONIC_HERMES: path.join(dir, "nope") };
  const bridge = spawn(process.execPath, ["server/index.mjs"], { env });
  try {
    await new Promise((res, rej) => { bridge.stdout.on("data", d => String(d).includes("running") && res()); bridge.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
    const base = `http://127.0.0.1:${PORT}`;
    const h = { "x-devtonic-token": TOKEN, "content-type": "application/json" };
    assert.equal((await (await fetch(`${base}/api/agent/status`, { headers: h })).json()).restartable, false);
    const r = await fetch(`${base}/api/agent/restart`, { method: "POST", headers: h, body: "{}" });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, "no-hermes");
  } finally { bridge.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
