import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 4799, TOKEN = "testtoken";
const base = `http://127.0.0.1:${PORT}`;

async function boot() {
  const p = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DEVTONIC_PORT: PORT, DEVTONIC_TOKEN: TOKEN } });
  await new Promise((res, rej) => { p.stdout.on("data", d => String(d).includes("running") && res()); p.on("error", rej); setTimeout(() => rej(new Error("boot timeout")), 5000); });
  return p;
}

test("bridge: auth, fs, exec, ws spawn", async () => {
  const srv = await boot();
  try {
    assert.equal((await fetch(`${base}/api/env`)).status, 401);
    const h = { "x-devtonic-token": TOKEN, "content-type": "application/json" };
    const env = await (await fetch(`${base}/api/env`, { headers: h })).json();
    assert.ok(env.homedir);
    const ex = await (await fetch(`${base}/api/fs`, { method: "POST", headers: h, body: JSON.stringify({ fn: "existsSync", args: ["package.json"] }) })).json();
    assert.deepEqual(ex, { ok: true, value: true });
    const bad = await (await fetch(`${base}/api/fs`, { method: "POST", headers: h, body: JSON.stringify({ fn: "rmSync", args: ["/"] }) })).json();
    assert.equal(bad.ok, false);
    const r = await (await fetch(`${base}/api/exec`, { method: "POST", headers: h, body: JSON.stringify({ file: "node", args: ["-e", "console.log(42)"] }) })).json();
    assert.equal(r.stdout.trim(), "42");
    const out = await new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/proc?token=${TOKEN}`);
      let buf = "";
      ws.on("open", () => ws.send(JSON.stringify({ t: "spawn", id: 1, file: "cat", args: [] })) || ws.send(JSON.stringify({ t: "stdin", id: 1, data: "hi" })) || ws.send(JSON.stringify({ t: "end", id: 1 })));
      ws.on("message", m => { m = JSON.parse(m); if (m.t === "out") buf += m.data; if (m.t === "close") { ws.close(); res(buf); } });
      ws.on("error", rej);
    });
    assert.equal(out, "hi");
  } finally { srv.kill(); }
});
