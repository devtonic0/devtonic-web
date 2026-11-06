import React, { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine,
         drawSelection, highlightSpecialChars } from "@codemirror/view";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap,
         completionKeymap } from "@codemirror/autocomplete";
import { indentOnInput, syntaxHighlighting, defaultHighlightStyle,
         bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintKeymap, lintGutter, setDiagnostics } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { abbreviationTracker } from "@emmetio/codemirror6-plugin";

// Language lookup by file extension. HTML gets emmet abbreviation-tracker so
// typing `d` then Tab expands to `<div></div>`, etc.
function langFor(path) {
  const ext = (path || "").split(".").pop().toLowerCase();
  switch (ext) {
    case "js": case "mjs": case "cjs": return [javascript({ jsx: false })];
    case "jsx": return [javascript({ jsx: true }), abbreviationTracker()];
    case "ts": return [javascript({ typescript: true })];
    case "tsx": return [javascript({ typescript: true, jsx: true }), abbreviationTracker()];
    case "css": case "scss": case "sass": case "less": return [css()];
    case "html": case "htm": case "svelte": case "vue": return [html(), abbreviationTracker()];
    case "json": return [json()];
    case "md": case "mdx": return [markdown()];
    case "py": return [python()];
    case "xml": return [xml()];
    case "sql": return [sql()];
    case "rs": return [rust()];
    case "c": case "cpp": case "cc": case "h": case "hpp": return [cpp()];
    default: return [];
  }
}

// Base extension bundle shared by every editor instance.
function baseExtensions(path, onChange) {
  return [
    lineNumbers(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
    lintGutter(), highlightActiveLine(), highlightSelectionMatches(),
    indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    ...langFor(path),
    keymap.of([
      indentWithTab,
      ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap,
      ...historyKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap,
    ]),
    oneDark,
    EditorView.updateListener.of(u => { if (u.docChanged) onChange(u.state.doc.toString()); }),
    EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "12px" } }),
  ];
}

/**
 * Full CodeMirror 6 editor with syntax highlighting, autocompletion, bracket
 * matching, emmet abbreviations (HTML/JSX/TSX), search, and lint diagnostics.
 * Props:
 *   path         current file path (drives language selection)
 *   value        current source text
 *   onChange     fires with new text on every edit
 *   diagnostics  optional [{from, to, severity, message, actions?}]
 *   scrollLine   line number to scroll into view (1-indexed, 0 = no-op)
 */
export default function CodeEditor({ path, value, onChange, diagnostics, scrollLine }) {
  const parentRef = useRef(null);
  const viewRef = useRef(null);
  const lastPathRef = useRef(path);

  // Create editor once per file change (extensions/languages differ per ext).
  useEffect(() => {
    if (!parentRef.current) return;
    const state = EditorState.create({
      doc: value ?? "",
      extensions: baseExtensions(path, onChange),
    });
    const view = new EditorView({ state, parent: parentRef.current });
    viewRef.current = view;
    lastPathRef.current = path;
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Push external value updates into the doc when NOT authored by the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== (value ?? "")) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value ?? "" } });
    }
  }, [value]);

  // Diagnostics from tsc/eslint/AI — CodeMirror displays them in the gutter
  // and inline with squiggles.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !diagnostics) return;
    view.dispatch(setDiagnostics(view.state, diagnostics));
  }, [diagnostics]);

  // Programmatic scroll (jump to line from Problems panel or search hits).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !scrollLine) return;
    const line = Math.max(1, Math.min(view.state.doc.lines, scrollLine));
    const pos = view.state.doc.line(line).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }, [scrollLine]);

  return <div className="cm-host" ref={parentRef} />;
}
