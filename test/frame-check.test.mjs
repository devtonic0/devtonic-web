import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

const PORT = 4798, TOKEN = "fctoken";
const base = `http://127.0.0.1:${PORT}`;

function target(headers) {
  return new Promise(res => {
    const s = http.createServer((req, r) => { r.writeHead(200, { "content-type": "text/html", ...headers }); r.end("<p>hi</p>"); });
    s.listen(0, "127.0.0.1", () => res(s));
  });
}

test("bridge /api/frame-check", async () => {
  const srv = spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, DEVTONIC_PORT: PORT, DEVTONIC_TOKEN: TOKEN } });
  await new Promise((res, rej) => { srv.stdout.on("data", d => String(d).includes("running") && res()); setTimeout(() => rej(new Error("boot timeout")), 5000).unref(); });
  const open = await target({});
  const deny = await target({ "x-frame-options": "DENY" });
  const csp = await target({ "content-security-policy": "frame-ancestors 'self'" });
  const check = async (u, h = { "x-devtonic-token": TOKEN }) =>
    fetch(`${base}/api/frame-check?url=${encodeURIComponent(u)}`, { headers: h });
  try {
    assert.equal((await check("http://127.0.0.1/", {})).status, 401);
    const a = await (await check(`http://127.0.0.1:${open.address().port}/`)).json();
    assert.equal(a.ok, true); assert.equal(a.blocked, false); assert.equal(a.status, 200);
    const b = await (await check(`http://127.0.0.1:${deny.address().port}/`)).json();
    assert.equal(b.blocked, true); assert.equal(b.reason, "X-Frame-Options: DENY");
    const c = await (await check(`http://127.0.0.1:${csp.address().port}/`)).json();
    assert.equal(c.blocked, true); assert.match(c.reason, /frame-ancestors/);
    const d = await (await check("file:///etc/passwd")).json();
    assert.equal(d.ok, false);
    const e = await (await check("http://127.0.0.1:1/")).json();
    assert.equal(e.ok, false); assert.ok(e.error);
  } finally {
    srv.kill();
    for (const s of [open, deny, csp]) { s.closeAllConnections(); s.close(); }
  }
});
