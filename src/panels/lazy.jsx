import React, { Suspense } from "react";

// Panels with heavy dependencies (force-graph/d3, CodeMirror) are split into
// their own chunks and fetched the first time the tab renders. lazyPanel()
// wraps React.lazy with a Suspense fallback and an error boundary so a failed
// chunk fetch (e.g. the server was upgraded under an open tab) shows a retry
// prompt instead of blanking the whole dock.

class ChunkBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="panel-loading panel-loading-error">
        <div>Couldn't load the {this.props.label} panel.</div>
        <div className="panel-loading-detail">{String(this.state.error?.message || this.state.error)}</div>
        <button className="tb-btn" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

export function lazyPanel(loader, label) {
  const Lazy = React.lazy(loader);
  function LazyPanel(props) {
    return (
      <ChunkBoundary label={label}>
        <Suspense fallback={<div className="panel-loading">Loading {label}…</div>}>
          <Lazy {...props} />
        </Suspense>
      </ChunkBoundary>
    );
  }
  LazyPanel.displayName = `LazyPanel(${label})`;
  return LazyPanel;
}
