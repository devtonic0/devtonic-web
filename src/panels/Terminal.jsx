import React, { useEffect, useRef, useState } from "react";
import { projectRoot, bus } from "../store.js";

// Persistent bash session bound to the project root.
const { spawn } = window.require("child_process");

export default function Terminal() {
  const [lines, setLines] = useState([`— bash @ ${projectRoot} —`]);
  const [cmd, setCmd] = useState("");
  const [cwd, setCwd] = useState(projectRoot);
  const shellRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    // No -i (interactive) — that requires a TTY and prints "no job control".
    // We pipe commands into bash's stdin and swallow prompt output via PS1="".
    const sh = spawn("bash", ["--noprofile", "--norc"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PS1: "", PS2: "", TERM: "dumb",
        // Same PATH augmentation as Code.jsx so tools resolve in the packaged app
        PATH: [
          `${process.env.HOME}/.local/bin`,
          "/usr/local/bin", "/usr/bin", "/bin",
          process.env.PATH || "",
        ].filter(Boolean).join(":"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    shellRef.current = sh;
    const push = d => setLines(l => [...l.slice(-2000), ...d.toString().split("\n").filter(Boolean)]);
    sh.stdout.on("data", push);
    sh.stderr.on("data", push);
    sh.on("close", () => setLines(l => [...l, "— shell exited —"]));
    const off = bus.on("project", root => {
      sh.stdin.write(`cd ${JSON.stringify(root)}\n`);
      setCwd(root);
      setLines(l => [...l, `— cd ${root} —`]);
    });
    return () => { off(); sh.kill(); };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  function run() {
    const c = cmd.trim();
    if (!c || !shellRef.current) return;
    setLines(l => [...l, `$ ${c}`]);
    shellRef.current.stdin.write(c + "\n");
    setCmd("");
  }

  return (
    <div className="panel-body">
      <div className="code-path">bash · {cwd}</div>
      <div className="term-scroll" ref={scrollRef}>
        {lines.map((l, i) => (
          <div key={i} className={`term-line ${l.startsWith("$ ") ? "cmd" : ""}`}>{l}</div>
        ))}
      </div>
      <div className="term-input-row">
        <span className="term-prompt">$</span>
        <input
          className="term-input"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={e => e.key === "Enter" && run()}
          placeholder="command…"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
