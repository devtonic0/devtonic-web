import React, { useCallback, useEffect, useState } from "react";
import { projectRoot, bus } from "../store.js";

// Git panel: status, branches, sync, commit, PR create/draft(AI)/merge.
// Plumbing via git + gh CLIs; AI drafting via `hermes --cli`.
const { execFile, spawn } = window.require("child_process");
const os = window.require("os");
const path = window.require("path");
const fs = window.require("fs");

const HERMES = path.join(os.homedir(), ".local", "bin", "hermes");
// Detect gh binary — packaged Electron loses PATH mods from ~/.bashrc, so check
// well-known locations before falling back to plain "gh".
const GH = [
  path.join(os.homedir(), ".local", "bin", "gh"),
  "/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh",
].find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || "gh";

// Augmented PATH for every spawn/execFile in this panel (Electron strips ~/.bashrc PATH).
const EXEC_ENV = {
  ...process.env,
  PATH: [
    path.join(os.homedir(), ".local", "bin"),
    "/usr/local/bin", "/usr/bin", "/bin",
    process.env.PATH || "",
  ].filter(Boolean).join(":"),
};

const run = (cmd, args, opts = {}) =>
  new Promise(resolve => {
    execFile(cmd, args, {
      cwd: projectRoot, maxBuffer: 8e6,
      env: EXEC_ENV,
      ...opts,
    }, (err, out, errOut) =>
      resolve({ ok: !err, out: (out || "").trim(), err: (errOut || err?.message || "").trim() })
    );
  });

const git = (...args) => run("git", args);
const gh = (...args) => run(GH, args);

export default function Git() {
  const [state, setState] = useState({ branch: "", ahead: 0, behind: 0, files: [], log: [], remote: "" });
  const [prs, setPrs] = useState([]);
  const [busyMsg, setBusyMsg] = useState("");
  const [output, setOutput] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [showPrForm, setShowPrForm] = useState(false);
  const [auth, setAuth] = useState({ checked: false, ok: false, user: "", accounts: [], msg: "" });
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);

  // Probe gh auth: parse `gh auth status` for ALL accounts (active + inactive).
  // gh 2.40+ lists each account in a subsection. We identify the active one by
  // "Active account: true" plus the user name from "Logged in to github.com …".
  const checkAuth = useCallback(async () => {
    const [tokR, statR] = await Promise.all([
      gh("auth", "token"),
      gh("auth", "status"),
    ]);
    const combined = `${statR.out}\n${statR.err}`;
    const hasToken = tokR.ok && tokR.out.trim().length > 20;
    // Parse all "Logged in to github.com … as/account NAME" lines; the active
    // one is followed within ~5 lines by "Active account: true".
    const accounts = [];
    const rx = /Logged in to github\.com (?:as|account) ([^\s(]+)([\s\S]*?)(?=Logged in to github\.com|\Z)/g;
    let m;
    while ((m = rx.exec(combined)) !== null) {
      accounts.push({
        name: m[1],
        active: /Active account: true/i.test(m[2]),
      });
    }
    const active = accounts.find(a => a.active) ?? accounts[0];
    setAuth({
      checked: true,
      ok: hasToken,
      user: active?.name || (hasToken ? "github user" : ""),
      accounts,
      msg: combined.trim() || tokR.err || `gh returned exit ${tokR.ok ? 0 : "≠0"}`,
    });
  }, []);
  useEffect(() => { checkAuth(); }, [checkAuth]);

  // Paste a personal-access token and hand it to `gh auth login --with-token`.
  async function saveToken() {
    const tok = tokenInput.trim();
    if (!tok) return;
    setBusyMsg("saving token…");
    const p = spawn(GH, ["auth", "login", "--with-token"], { env: EXEC_ENV });
    p.stdin.write(tok + "\n"); p.stdin.end();
    let err = "";
    p.stderr.on("data", d => (err += d.toString()));
    p.on("close", code => {
      setBusyMsg("");
      setTokenInput("");
      setShowTokenInput(false);
      setOutput(code === 0 ? "✓ token saved — gh auth complete" : `⚠️ ${err || "gh rejected token"}`);
      checkAuth();
      refresh();
    });
  }

  // Web sign-in — `gh auth login --web` normally needs a TTY for the interactive
  // prompt, but if we run it non-interactive it prints "First copy your one-time
  // code: XXXX-XXXX\nPress Enter to open browser: " then hangs. We capture that
  // output, extract the code, show it + the URL in the UI, and let the user
  // open the URL in their default browser via xdg-open.
  function browserLogin() {
    setBusyMsg("starting browser sign-in…");
    setOutput("");
    const p = spawn(GH, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], {
      env: EXEC_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let opened = false;
    const onData = d => {
      buf += d.toString();
      // Look for the device code + verification URL in gh's output.
      const codeMatch = buf.match(/one-time code:\s*([A-Z0-9-]+)/i);
      const urlMatch = buf.match(/(https:\/\/github\.com\/login\/device[^\s]*)/i);
      const genericUrlMatch = buf.match(/https:\/\/github\.com\/login\/device/);
      const url = urlMatch?.[1] || (genericUrlMatch ? "https://github.com/login/device" : null);
      if (codeMatch && url && !opened) {
        opened = true;
        const code = codeMatch[1];
        setOutput(
          `📋 One-time code: ${code}\n\n` +
          `Opening your default browser to: ${url}\n` +
          `Paste the code above into GitHub's device-login page, then come back.`
        );
        // Copy code to clipboard for convenience.
        try { navigator.clipboard?.writeText(code).catch(() => {}); } catch {}
        // Open URL in system default browser via xdg-open (not Electron shell).
        openBrowserSystemDefault(url);
        // Send Enter so gh proceeds to poll for the token exchange.
        try { p.stdin.write("\n"); p.stdin.end(); } catch {}
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", code => {
      setBusyMsg("");
      if (code === 0) {
        setOutput(o => o + "\n\n✓ signed in — refreshing account…");
        setTimeout(() => { checkAuth(); refresh(); }, 500);
      } else {
        setOutput(o => o + `\n\n⚠️ gh exited with code ${code}. Try pasting a token instead.`);
      }
    });
    p.on("error", e => {
      setBusyMsg("");
      setOutput(`⚠️ Couldn't launch gh: ${e.message}`);
    });
  }

  // Open URL via xdg-open / open / start — bypasses Electron's shell which
  // sometimes hangs on Linux.
  function openBrowserSystemDefault(url) {
    const cmd = process.platform === "darwin" ? "open"
             : process.platform === "win32" ? "start" : "xdg-open";
    try {
      const args = process.platform === "win32" ? ["", url] : [url];
      spawn(cmd, args, { detached: true, stdio: "ignore", shell: process.platform === "win32", env: EXEC_ENV }).unref();
    } catch {
      // Last-ditch fallback: Electron shell.
      try { window.require("electron").shell.openExternal(url); } catch {}
    }
  }

  // Switch active gh account (only relevant when the user has 2+ signed in).
  async function switchAccount(name) {
    setBusyMsg(`switching to ${name}…`);
    const r = await gh("auth", "switch", "--user", name);
    setOutput(r.ok ? `✓ active account: ${name}` : `⚠️ ${r.err || r.out}`);
    setBusyMsg("");
    setShowAccounts(false);
    checkAuth();
    refresh();
  }

  // Log out of a specific account (or the current active one).
  async function logoutAccount(name) {
    if (!window.confirm(`Log out ${name}?`)) return;
    setBusyMsg(`logging out ${name}…`);
    const args = ["auth", "logout", "--hostname", "github.com"];
    if (name) args.push("--user", name);
    const r = await gh(...args);
    setOutput(r.ok ? `✓ logged out ${name || "current account"}` : `⚠️ ${r.err || r.out}`);
    // gh writes state to ~/.config/gh/hosts.yml; give the FS a tick to settle,
    // then optimistically clear our own state so the UI updates immediately.
    setAuth(a => ({
      ...a,
      accounts: a.accounts.filter(x => x.name !== name),
      user: a.user === name ? "" : a.user,
      ok: a.accounts.filter(x => x.name !== name).length > 0 && a.ok,
    }));
    setShowAccounts(false);
    setBusyMsg("");
    // Then re-probe gh for the authoritative state.
    setTimeout(() => { checkAuth(); refresh(); }, 300);
  }

  const refresh = useCallback(async () => {
    const [branch, statusR, logR, remoteR, abR] = await Promise.all([
      git("rev-parse", "--abbrev-ref", "HEAD"),
      git("status", "--porcelain"),
      git("log", "--oneline", "-8"),
      git("remote", "get-url", "origin"),
      git("rev-list", "--left-right", "--count", "@{upstream}...HEAD"),
    ]);
    const [behind, ahead] = abR.ok ? abR.out.split(/\s+/).map(Number) : [0, 0];
    setState({
      branch: branch.out,
      ahead, behind,
      files: statusR.out ? statusR.out.split("\n") : [],
      log: logR.out ? logR.out.split("\n") : [],
      remote: remoteR.out,
    });
    const prR = await gh("pr", "list", "--json", "number,title,headRefName,isDraft,mergeable", "--limit", "10");
    setPrs(prR.ok ? JSON.parse(prR.out || "[]") : []);
  }, []);

  useEffect(() => { refresh(); return bus.on("project", refresh); }, [refresh]);

  async function act(label, fn) {
    setBusyMsg(label);
    setOutput("");
    const r = await fn();
    setOutput(r.ok ? (r.out || "✓ done") : `⚠️ ${r.err || r.out}`);
    setBusyMsg("");
    refresh();
  }

  const sync = () => act("syncing…", async () => {
    const pull = await git("pull", "--rebase");
    if (!pull.ok) return pull;
    const push = await git("push");
    return { ok: push.ok, out: `pull: ${pull.out}\npush: ${push.ok ? push.out || "✓" : push.err}`, err: push.err };
  });

  const commit = () => act("committing…", async () => {
    if (!commitMsg.trim()) return { ok: false, err: "enter a commit message" };
    await git("add", "-A");
    return git("commit", "-m", commitMsg.trim());
  });

  // AI-draft the PR title+body from the branch diff via Hermes.
  const draftWithAI = () => act("Hermes drafting PR…", () =>
    new Promise(resolve => {
      const prompt = `In the git repo at ${projectRoot} (current branch), run: git log main..HEAD --oneline and git diff main...HEAD --stat to see what this branch changes. Then reply with ONLY a PR title on the first line, then a blank line, then a markdown PR body (summary bullets, verification notes, any pending setup items). No other commentary.`;
      let out = "";
      const p = spawn(HERMES, ["--cli", "-z", prompt], { env: { ...process.env } });
      p.stdout.on("data", d => (out += d.toString()));
      p.on("close", () => {
        const text = out.trim();
        if (!text) return resolve({ ok: false, err: "no draft returned" });
        const [title, ...rest] = text.split("\n");
        setPrTitle(title.replace(/^#+\s*/, "").trim());
        setPrBody(rest.join("\n").trim());
        setShowPrForm(true);
        resolve({ ok: true, out: "draft ready — review below, then Create PR" });
      });
      p.on("error", e => resolve({ ok: false, err: e.message }));
    })
  );

  const createPr = (draft) => act(draft ? "creating draft PR…" : "creating PR…", async () => {
    if (!prTitle.trim()) return { ok: false, err: "PR needs a title (write one or Draft with AI)" };
    const args = ["pr", "create", "--title", prTitle.trim(), "--body", prBody || "—", "--base", "main"];
    if (draft) args.push("--draft");
    const r = await gh(...args);
    if (r.ok) setShowPrForm(false);
    return r;
  });

  const mergePr = (num) => act(`merging #${num}…`, () => gh("pr", "merge", String(num), "--squash", "--delete-branch"));

  return (
    <div className="panel-body">
      <div className="git-head">
        <span className="git-branch">⎇ {state.branch || "?"}</span>
        {state.ahead > 0 && <span className="git-badge ahead">↑{state.ahead}</span>}
        {state.behind > 0 && <span className="git-badge behind">↓{state.behind}</span>}
        <div style={{ flex: 1 }} />
        <button className="tb-btn" onClick={refresh}>refresh</button>
        <button className="tb-btn" onClick={sync} disabled={!!busyMsg}>⇅ sync</button>
      </div>

      <div className="git-scroll">
        {/* auth banner: only shown if gh isn't authenticated */}
        {auth.checked && !auth.ok && (
          <div className="git-auth-banner">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ color: "var(--warn)" }}>⚠</span>
              <b>Not signed into GitHub</b>
              <span className="cfg-hint" style={{ marginLeft: "auto" }}>{GH}</span>
            </div>
            <div className="cfg-hint" style={{ marginBottom: 8 }}>
              Paste a <a href="https://github.com/settings/tokens" onClick={e => {
                e.preventDefault();
                openBrowserSystemDefault("https://github.com/settings/tokens/new?scopes=repo,workflow,gist,read:org&description=Devtonic");
              }}>personal access token</a> (needs <code>repo</code>, <code>workflow</code>), or open the browser flow.
            </div>
            <details style={{ marginBottom: 8 }}>
              <summary className="cfg-hint" style={{ cursor: "pointer" }}>why? (gh output)</summary>
              <pre className="git-output" style={{ maxHeight: 120, overflow: "auto", marginTop: 4 }}>{auth.msg || "(no output)"}</pre>
            </details>
            {!showTokenInput ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="send-btn" onClick={() => setShowTokenInput(true)}>🔑 paste token</button>
                <button className="tb-btn" onClick={browserLogin} disabled={!!busyMsg}>🌐 sign in with browser</button>
                <button className="tb-btn" onClick={checkAuth}>↻ recheck</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <input type="password" value={tokenInput} placeholder="ghp_… or github_pat_…"
                  onChange={e => setTokenInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveToken()}
                  style={{ flex: 1 }} />
                <button className="send-btn" disabled={!tokenInput.trim() || !!busyMsg} onClick={saveToken}>save</button>
                <button className="tb-btn" onClick={() => { setShowTokenInput(false); setTokenInput(""); }}>cancel</button>
              </div>
            )}
          </div>
        )}
        {auth.checked && auth.ok && (
          <div className="git-auth-signed">
            <span className="git-auth-badge" title="active GitHub account">
              <span className="git-auth-avatar">✓</span>
              <b>{auth.user}</b>
            </span>
            <div style={{ flex: 1 }} />
            {auth.accounts.length > 1 && (
              <button className="tb-btn" onClick={() => setShowAccounts(s => !s)}>
                switch ({auth.accounts.length}) ▾
              </button>
            )}
            <button className="tb-btn" onClick={browserLogin} disabled={!!busyMsg}>➕ add account</button>
            <button className="tb-btn" style={{ color: "var(--red)" }}
                    onClick={() => logoutAccount(auth.user)} disabled={!!busyMsg}>
              sign out
            </button>
          </div>
        )}
        {showAccounts && auth.accounts.length > 1 && (
          <div className="git-account-list">
            {auth.accounts.map(a => (
              <div key={a.name} className={`git-account-row ${a.active ? "active" : ""}`}>
                <span className="git-auth-avatar">{a.active ? "✓" : "○"}</span>
                <span className="git-account-name">{a.name}</span>
                {a.active
                  ? <span className="cfg-hint">active</span>
                  : <button className="tb-btn" onClick={() => switchAccount(a.name)}>switch</button>}
                <button className="tb-btn" style={{ color: "var(--red)" }}
                        onClick={() => logoutAccount(a.name)}>sign out</button>
              </div>
            ))}
          </div>
        )}

        {/* working tree */}
        <div className="git-section">changes · {state.files.length}</div>
        {state.files.length === 0 && <div className="git-empty">working tree clean</div>}
        {state.files.map(f => (
          <div key={f} className="git-file">
            <span className={`git-x ${f[0] === "?" ? "unt" : "mod"}`}>{f.slice(0, 2).trim() || "•"}</span>
            {f.slice(3)}
          </div>
        ))}
        {state.files.length > 0 && (
          <div className="git-commit-row">
            <input
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              placeholder="commit message…"
              onKeyDown={e => e.key === "Enter" && commit()}
            />
            <button className="send-btn" onClick={commit} disabled={!!busyMsg}>commit</button>
          </div>
        )}

        {/* PRs */}
        <div className="git-section">
          pull requests · {prs.length}
          <div style={{ flex: 1 }} />
          <button className="tb-btn" onClick={draftWithAI} disabled={!!busyMsg}>✨ draft with AI</button>
          <button className="tb-btn" onClick={() => setShowPrForm(s => !s)}>+ new PR</button>
        </div>
        {showPrForm && (
          <div className="git-pr-form">
            <input value={prTitle} onChange={e => setPrTitle(e.target.value)} placeholder="PR title" />
            <textarea value={prBody} onChange={e => setPrBody(e.target.value)} placeholder="PR body (markdown)" rows={7} />
            <div style={{ display: "flex", gap: 6 }}>
              <button className="send-btn" onClick={() => createPr(false)} disabled={!!busyMsg}>Create PR</button>
              <button className="tb-btn" onClick={() => createPr(true)} disabled={!!busyMsg}>Create draft</button>
            </div>
          </div>
        )}
        {prs.map(pr => (
          <div key={pr.number} className="git-pr">
            <span className="git-pr-num">#{pr.number}</span>
            <span className="git-pr-title">{pr.isDraft ? "📝 " : ""}{pr.title}</span>
            <span className="git-pr-branch">{pr.headRefName}</span>
            <button className="tb-btn" onClick={() => mergePr(pr.number)} disabled={!!busyMsg || pr.isDraft}>
              merge
            </button>
          </div>
        ))}

        {/* recent commits */}
        <div className="git-section">recent commits</div>
        {state.log.map(l => <div key={l} className="git-log">{l}</div>)}

        {(busyMsg || output) && (
          <>
            <div className="git-section">{busyMsg || "output"}</div>
            <pre className="git-output">{output || "…"}</pre>
          </>
        )}
      </div>
    </div>
  );
}
