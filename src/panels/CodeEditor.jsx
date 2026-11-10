import React, { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
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
import { loadLanguage } from "./code-langs.js";

// Base extension bundle shared by every editor instance.
function baseExtensions(langSlot, onChange) {
  return [
    lineNumbers(), highlightSpecialChars(), history(), foldGutter(), drawSelection(),
    lintGutter(), highlightActiveLine(), highlightSelectionMatches(),
    indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    langSlot.of([]),
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
    const langSlot = new Compartment();
    const state = EditorState.create({
      doc: value ?? "",
      extensions: baseExtensions(langSlot, onChange),
    });
    const view = new EditorView({ state, parent: parentRef.current });
    viewRef.current = view;
    lastPathRef.current = path;
    // Language packs are fetched on demand; the editor is usable (plain text)
    // until the pack arrives, then highlighting is swapped in.
    let alive = true;
    loadLanguage(path).then(
      ext => { if (alive && ext.length) view.dispatch({ effects: langSlot.reconfigure(ext) }); },
      err => console.warn("[code] language pack failed to load:", err),
    );
    return () => { alive = false; view.destroy(); };
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
