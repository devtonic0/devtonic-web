// Cross-platform process/port listing for panels (Linux + macOS).
// Runs `ps` / `ss` / `lsof` through the bridge's child_process shim and parses
// the output with the pure helpers in procs-model.js.
import { psArgs, parsePs, sortProcs, portTools, portToolArgs, parsePorts } from "./procs-model.js";

const cp = () => window.require("child_process");
const platform = () => window.require("os").platform();
const currentUser = () => window.process?.env?.USER || window.process?.env?.LOGNAME || "";

// listProcesses({fields, sort, allUsers}, cb) → cb(rows)
// fields: subset of pid, cpu, mem, time, cmd. sort: "-cpu" | "start" | undefined.
export function listProcesses({ fields = ["pid", "cmd"], sort, allUsers = false } = {}, cb) {
  const args = psArgs({ fields, user: allUsers ? "" : currentUser() });
  cp().execFile("ps", args, { maxBuffer: 8e6 }, (_e, out) => {
    cb(sortProcs(parsePs(out, fields), sort));
  });
}

// processStat(pid, cb) → cb({cpu, mem, time} | null)
export function processStat(pid, cb) {
  cp().execFile("ps", ["-o", "pcpu=,pmem=,etime=", "-p", String(pid)], (_e, out) => {
    const [row] = parsePs(out, ["cpu", "mem", "time"]);
    cb(row || null);
  });
}

// listeningPorts(pid, cb) → cb(number[]). Tries ss then lsof on Linux, lsof on macOS.
export function listeningPorts(pid, cb) {
  const tools = portTools(platform());
  const next = i => {
    if (i >= tools.length) return cb([]);
    const tool = tools[i];
    cp().execFile(tool, portToolArgs(tool, pid), { maxBuffer: 4e6 }, (err, out) => {
      // lsof exits 1 when nothing matches; that is a valid empty answer.
      // A missing ss (minimal containers) or ss failing outright falls through to lsof.
      const missing = err && (err.code === "ENOENT" || /ENOENT|not found/i.test(err.message || ""));
      if (missing || (err && !out && tool === "ss")) return next(i + 1);
      cb(parsePorts(tool, out, pid));
    });
  };
  next(0);
}
