import { test } from "node:test";
import assert from "node:assert/strict";
import { createSSEParser, initialTurn, reduceTurn, turnReply, transportLabel } from "../src/platform/agent-stream.js";

const frames = evs => evs.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

test("SSE parser: frames split at arbitrary points, comments, CRLF", () => {
  const text = ": keepalive\n\n" + frames([["run.started", { run_id: "run_1" }], ["assistant.delta", { delta: "hé\nllo" }]])
    .replace(/\n/g, "\r\n") + "event: done\ndata: {}\n\n";
  for (const size of [1, 3, 7, text.length]) {
    const got = [];
    const p = createSSEParser(e => got.push(e));
    for (let i = 0; i < text.length; i += size) p.feed(text.slice(i, i + size));
    p.end();
    assert.deepEqual(got.map(e => e.event), ["run.started", "assistant.delta", "done"], `chunk size ${size}`);
    assert.equal(got[1].data.delta, "hé\nllo");
  }
});

test("SSE parser: multi-line data and non-JSON payloads", () => {
  const got = [];
  const p = createSSEParser(e => got.push(e));
  p.feed("data: a\ndata: b\n\nevent: x\ndata: {bad\n");
  p.end();
  assert.deepEqual(got, [{ event: "message", data: "a\nb" }, { event: "x", data: "{bad" }]);
});

test("turn reducer: a full successful run with tools and reasoning", () => {
  const evs = [
    ["run.started", { run_id: "run_1", user_message: { content: "hi" } }],
    ["message.started", { message: { id: "m" } }],
    ["tool.progress", { tool_name: "_thinking", delta: "let me " }],
    ["tool.progress", { tool_name: "_thinking", delta: "look" }],
    ["tool.started", { tool_name: "terminal", preview: "ls -la" }],
    ["tool.completed", { tool_name: "terminal", preview: "ls -la" }],
    ["tool.started", { tool_name: "read_file", preview: "a.txt" }],
    ["tool.failed", { tool_name: "read_file", preview: "a.txt" }],
    ["assistant.commentary", { text: "checking files" }],
    ["assistant.delta", { delta: "Hel" }],
    ["assistant.delta", { delta: "lo" }],
    ["assistant.completed", { content: "Hello!" }],
    ["run.completed", { run_id: "run_1" }],
    ["done", {}],
  ];
  let s = initialTurn(0);
  for (const [event, data] of evs) s = reduceTurn(s, { event, data });
  assert.equal(s.runId, "run_1");
  assert.equal(s.text, "Hello");
  assert.equal(s.final, "Hello!");
  assert.equal(s.status, "completed");
  assert.equal(s.live, false);
  assert.deepEqual(s.transcript, ["💭 let me look", "checking files"]);
  // Started tool entries are replaced in place by their outcome.
  const tools = s.entries.filter(e => e.text.startsWith("terminal") || e.text.startsWith("read_file"));
  assert.deepEqual(tools.map(e => e.icon), ["✓", "✕"]);
  assert.ok(!s.entries.some(e => e.live));
  assert.equal(turnReply(s), "Hello!");
});

test("turn reducer: approval request and response", () => {
  let s = reduceTurn(initialTurn(0), { event: "run.started", data: { run_id: "run_9" } });
  s = reduceTurn(s, { event: "approval.request", data: { run_id: "run_9", command: "rm -rf build", description: "delete", choices: ["once", "session", "deny"], request_id: "rq1" } });
  assert.equal(s.status, "waiting_for_approval");
  assert.deepEqual(s.approval, { command: "rm -rf build", description: "delete", choices: ["once", "session", "deny"], requestId: "rq1", runId: "run_9" });
  s = reduceTurn(s, { event: "approval.responded", data: {} });
  assert.equal(s.approval, null);
  assert.equal(s.status, "running");
  // Missing choices fall back to the minimal safe set.
  const t = reduceTurn(initialTurn(0), { event: "approval.request", data: { run_id: "r" } });
  assert.deepEqual(t.approval.choices, ["once", "deny"]);
});

test("turn reducer: errors, cancellation and unknown events", () => {
  let s = reduceTurn(initialTurn(0), { event: "assistant.delta", data: { delta: "partial" } });
  s = reduceTurn(s, { event: "some.future.event", data: { x: 1 } });
  assert.equal(s.text, "partial");
  const failed = reduceTurn(s, { event: "error", data: { message: "provider down" } });
  assert.equal(failed.status, "failed");
  assert.equal(turnReply(failed), "partial\n\n⚠️ provider down");
  const cancelled = reduceTurn(s, { event: "run.cancelled", data: {} });
  assert.equal(turnReply(cancelled), "partial\n\n_(stopped)_");
  assert.equal(turnReply(initialTurn(0)), "(no output)");
});

test("transport label explains why the CLI is used", () => {
  assert.equal(transportLabel({ available: true, url: "http://127.0.0.1:8642" }).mode, "api");
  const off = transportLabel({ available: false, reason: "no-key", url: "u" });
  assert.equal(off.mode, "cli");
  assert.match(off.title, /API_SERVER_KEY/);
  assert.equal(transportLabel(null).mode, "cli");
});
