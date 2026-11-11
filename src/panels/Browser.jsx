import React, { useEffect, useRef, useState } from "react";
import { openExternal } from "../platform/web.js";
import { normalizeUrl, emptyNav, navPush, navBack, navForward, navCurrent } from "../platform/frame-model.js";

const HOME = "http://localhost:3000";

// Asks the bridge whether the page's headers forbid framing. Always resolves;
// bridge/network failures come back as { ok: false, error }.
async function frameCheck(url) {
  try {
    const token = localStorage.getItem("devtonic-token") || "";
    const r = await fetch(`/api/frame-check?url=${encodeURIComponent(url)}`, { headers: { "x-devtonic-token": token } });
    if (!r.ok) return { ok: false, error: `bridge returned ${r.status}` };
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

export default function Browser() {
  const viewRef = useRef(null);
  const [nav, setNav] = useState(() => emptyNav(HOME));
  const [bar, setBar] = useState(HOME);
  // status: checking | ok | blocked | unreachable | forced
  const [check, setCheck] = useState({ status: "checking" });
  const [reloadKey, setReloadKey] = useState(0);
  const url = navCurrent(nav);

  useEffect(() => {
    if (!url) return;
    let live = true;
    setBar(url);
    setCheck({ status: "checking" });
    frameCheck(url).then(r => {
      if (!live) return;
      if (!r.ok) setCheck({ status: "unreachable", error: r.error });
      else if (r.blocked) setCheck({ status: "blocked", reason: r.reason });
      else setCheck({ status: "ok" });
    });
    return () => { live = false; };
  }, [url, reloadKey]);

  function go(input) {
    const target = normalizeUrl(input);
    if (!target) return;
    if (target === url) setReloadKey(k => k + 1);
    else setNav(n => navPush(n, target));
  }

  const showFrame = check.status === "ok" || check.status === "forced" || check.status === "unreachable";
  const canBack = nav.idx > 0, canFwd = nav.idx < nav.stack.length - 1;
  let host = "";
  try { host = new URL(url).host; } catch {}

  return (
    <div className="panel-body">
      <div className="browser-bar">
        <button onClick={() => setNav(navBack)} disabled={!canBack} title="Back">‹</button>
        <button onClick={() => setNav(navForward)} disabled={!canFwd} title="Forward">›</button>
        <button onClick={() => setReloadKey(k => k + 1)} title="Reload">⟳</button>
        <input
          className="url-input"
          value={bar}
          onChange={e => setBar(e.target.value)}
          onKeyDown={e => e.key === "Enter" && go(bar)}
          spellCheck={false}
        />
        <button onClick={() => url && openExternal(url)} title="Open in new tab">↗</button>
      </div>
      {check.status === "unreachable" && (
        <div className="browser-note" role="status">
          Couldn't check this page from the bridge ({check.error}). Showing it anyway.
        </div>
      )}
      {check.status === "checking" && <div className="browser-blocked"><span className="browser-dim">loading…</span></div>}
      {check.status === "blocked" && (
        <div className="browser-blocked" role="alert">
          <div className="browser-blocked-card">
            <div className="browser-blocked-title">This site can't be shown in a panel</div>
            <div className="browser-dim">{host} doesn't allow other pages to embed it.</div>
            <code className="browser-blocked-reason">{check.reason}</code>
            <div className="browser-blocked-actions">
              <button className="browser-action primary" onClick={() => openExternal(url)}>Open in new tab</button>
              <button className="browser-action" onClick={() => setCheck({ status: "forced" })}>Try anyway</button>
            </div>
          </div>
        </div>
      )}
      {showFrame && (
        <iframe
          key={`${url}#${reloadKey}`}
          ref={viewRef}
          src={url}
          style={{ flex: 1, border: 0, background: "white" }}
          title="preview"
        />
      )}
    </div>
  );
}
