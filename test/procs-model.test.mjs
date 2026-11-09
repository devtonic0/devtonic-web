import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import {
  psArgs, parsePs, sortProcs, etimeToSeconds,
  portTools, portToolArgs, parseSsPorts, parseLsofPorts,
} from "../src/platform/procs-model.js";

test("psArgs uses only portable flags and puts args last", () => {
  const a = psArgs({ fields: ["cmd", "pid", "cpu"], user: "alice" });
  assert.deepEqual(a, ["-U", "alice", "-o", "pid=,pcpu=,args="]);
  assert.ok(!a.some(x => x.startsWith("--")), "no GNU long options");
  assert.deepEqual(psArgs({ fields: ["pid"] }), ["-A", "-o", "pid="]);
  assert.throws(() => psArgs({ fields: ["nope"] }), /unknown ps field/);
});

test("parsePs handles procps and BSD spacing and keeps command spaces", () => {
  const out = [
    "  406   0.0  0.1 06-23:37:23 /usr/sbin/distnoted agent",
    "12345  97.5  2.0    01:02 node  server.js --port 3000",
    "",
    "garbage line",
  ].join("\n");
  const rows = parsePs(out, ["pid", "cpu", "mem", "time", "cmd"]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pid: 406, cpu: 0, mem: 0.1, time: "06-23:37:23", cmd: "/usr/sbin/distnoted agent" });
  assert.equal(rows[1].cmd, "node  server.js --port 3000");
});

test("etimeToSeconds parses all ps elapsed formats", () => {
  assert.equal(etimeToSeconds("00:05"), 5);
  assert.equal(etimeToSeconds("01:02:03"), 3723);
  assert.equal(etimeToSeconds("2-00:00:01"), 172801);
  assert.equal(etimeToSeconds("bogus"), 0);
});

test("sortProcs replaces --sort=-pcpu and --sort=start_time", () => {
  const rows = [
    { pid: 1, cpu: 1, time: "00:10" },
    { pid: 2, cpu: 50, time: "1-00:00:00" },
    { pid: 3, cpu: 5, time: "05:00" },
  ];
  assert.deepEqual(sortProcs(rows, "-cpu").map(r => r.pid), [2, 3, 1]);
  assert.deepEqual(sortProcs(rows, "start").map(r => r.pid), [2, 3, 1]);
  assert.deepEqual(sortProcs(rows).map(r => r.pid), [1, 2, 3]);
});

test("port tool selection per platform", () => {
  assert.deepEqual(portTools("linux"), ["ss", "lsof"]);
  assert.deepEqual(portTools("darwin"), ["lsof"]);
  assert.deepEqual(portToolArgs("lsof", 42).slice(-3), ["-p", "42", "-Fpn"]);
});

test("parseSsPorts filters by pid", () => {
  const out = [
    'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=111,fd=20))',
    'LISTEN 0 511 [::1]:3000 [::]:* users:(("node",pid=111,fd=21))',
    'LISTEN 0 511 *:8080 *:* users:(("python",pid=222,fd=3))',
  ].join("\n");
  assert.deepEqual(parseSsPorts(out, 111), [3000, 5173]);
  assert.deepEqual(parseSsPorts(out, 222), [8080]);
  assert.deepEqual(parseSsPorts(out, 9), []);
});

test("parseLsofPorts reads -Fpn records", () => {
  const out = "p111\nf8\nn127.0.0.1:5173\nf9\nn[::1]:5173\nf10\nn*:24678\np222\nf3\nn*:8080\n";
  assert.deepEqual(parseLsofPorts(out, 111), [5173, 24678]);
  assert.deepEqual(parseLsofPorts(out, 222), [8080]);
  assert.deepEqual(parseLsofPorts("", 1), []);
});

test("psArgs output runs on this host's real ps", { skip: process.platform === "win32" }, () => {
  const fields = ["pid", "cpu", "mem", "time", "cmd"];
  const out = execFileSync("ps", psArgs({ fields, user: os.userInfo().username }), { encoding: "utf8", maxBuffer: 8e6 });
  const rows = parsePs(out, fields);
  assert.ok(rows.length > 0);
  assert.ok(rows.some(r => r.pid === process.pid), "finds the test process itself");
});
