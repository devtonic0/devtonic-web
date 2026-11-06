import React, { useRef, useState } from "react";

export default function Browser() {
  const viewRef = useRef(null);
  const [url, setUrl] = useState("http://localhost:3000");
  const [bar, setBar] = useState("http://localhost:3000");

  function go(u) {
    let target = u.trim();
    if (!/^https?:\/\//.test(target)) target = target.includes("localhost") || /^[\d.]+:/.test(target) ? `http://${target}` : `https://${target}`;
    setUrl(target);
    setBar(target);
  }

  return (
    <div className="panel-body">
      <div className="browser-bar">
        <button onClick={() => history.back()} title="Back">‹</button>
        <button onClick={() => history.forward()} title="Forward">›</button>
        <button onClick={() => viewRef.current && (viewRef.current.src = viewRef.current.src)} title="Reload">⟳</button>
        <input
          className="url-input"
          value={bar}
          onChange={e => setBar(e.target.value)}
          onKeyDown={e => e.key === "Enter" && go(bar)}
          spellCheck={false}
        />
      </div>
      <iframe
        ref={viewRef}
        src={url}
        style={{ flex: 1, border: 0, background: "white" }}
        title="preview"
      />
    </div>
  );
}
