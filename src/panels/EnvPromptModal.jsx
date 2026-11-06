import React, { useState, useEffect, useRef } from "react";
import { saveEnvVars, hintFor, detectEnvTargets } from "../env-prompt.js";
import { projectRoot } from "../store.js";

/**
 * Modal that prompts the user for missing env variables detected during a
 * Hermes turn. Values are written straight to a .env file (project by default,
 * or the global Hermes env if explicitly chosen) — they NEVER enter chat
 * messages, get logged, or get passed as arguments to the LLM.
 *
 * Props:
 *   names    string[]    var names to prompt for (already deduped/filtered)
 *   onClose  ()          user closed without saving all
 *   onSaved  ({ names, retry, file, scope })  user saved values — receives
 *              the list of NAMES only (no values), plus which file+scope
 *              they went to and whether the user asked to retry.
 */
export default function EnvPromptModal({ names, onClose, onSaved }) {
  // Allow adding ad-hoc keys the auto-detector didn't catch.
  const [dynNames, setDynNames] = useState(names);
  const [values, setValues] = useState(() =>
    Object.fromEntries(names.map(n => [n, ""])));
  const [reveal, setReveal] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [newKey, setNewKey] = useState("");
  const firstRef = useRef(null);

  // Where to save. Default = first project target (existing project .env,
  // else <root>/.env-to-create). User can flip to any detected file including
  // global ~/.hermes/.env from the dropdown.
  const [targets] = useState(() => detectEnvTargets(projectRoot));
  const [targetIdx, setTargetIdx] = useState(0);
  const target = targets[targetIdx];

  useEffect(() => { firstRef.current?.focus(); }, []);

  // Support pasting a whole KEY=VALUE block into the first field — auto-splits
  // into the matching inputs. Common paste-from-secrets-manager flow.
  function onPaste(e, key) {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/\n|=/.test(text) || text.split(/\r?\n/).filter(Boolean).length < 2) return;
    e.preventDefault();
    const next = { ...values };
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const k = m[1].toUpperCase();
      const v = m[2].replace(/^["']|["']$/g, "");
      if (k in next) next[k] = v;
    }
    if (Object.values(next).every(v => !v)) next[key] = text.trim();
    setValues(next);
  }

  function toggleReveal(k) {
    setReveal(r => {
      const n = new Set(r);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  }

  function save(retry) {
    const filled = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v && v.trim()));
    if (!Object.keys(filled).length) {
      setError("Enter at least one value, or Cancel.");
      return;
    }
    if (!target) { setError("No target env file selected."); return; }
    setSaving(true);
    setError("");
    try {
      const { written, path: file } = saveEnvVars(filled, target.file);
      // NOTE: we deliberately pass names only — never the values.
      onSaved?.({ names: written, retry: !!retry, file, scope: target.scope });
    } catch (e) {
      setError(`Couldn't write ${target.file}: ${e.message}`);
      setSaving(false);
    }
  }

  const filledCount = Object.values(values).filter(v => v && v.trim()).length;

  return (
    <div className="modal-back" onClick={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal env-modal" role="dialog" aria-label="Missing environment variables">
        <div className="modal-title">
          {dynNames.length === 0
            ? "Add environment variables"
            : `Missing environment ${dynNames.length === 1 ? "variable" : "variables"}`}
        </div>
        <div className="env-modal-sub">
          {dynNames.length === 0
            ? <>Add any keys your project needs. </>
            : <>Hermes needs the following. </>}
          Values are written to disk and <b>never sent to the LLM</b> or included in chat messages.
        </div>

        <div className="env-modal-target">
          <label className="env-modal-target-label">Save to</label>
          <select
            className="session-select"
            value={targetIdx}
            onChange={e => setTargetIdx(+e.target.value)}
          >
            {targets.map((t, i) => (
              <option key={t.file} value={i}>
                {t.label}{t.exists ? "" : " · will create"}
              </option>
            ))}
          </select>
          <span className={`env-modal-scope ${target?.scope}`}>
            {target?.scope === "global" ? "global" : "project"}
          </span>
        </div>
        <div className="env-modal-target-path">{target?.file}</div>
        {target?.scope === "global" && (
          <div className="env-modal-warn">
            ⚠ Global scope — these values will be visible to every Hermes turn on this machine,
            not just this project. Prefer a project .env for app-specific keys.
          </div>
        )}

        <div className="env-modal-rows">
          {dynNames.map((k, i) => {
            const shown = reveal.has(k);
            const hint = hintFor(k);
            return (
              <div key={k} className="env-modal-row">
                <label className="env-modal-key">
                  {k}
                  {hint && <span className="env-modal-hint">{hint}</span>}
                </label>
                <div className="env-modal-input-wrap">
                  <input
                    ref={i === 0 ? firstRef : null}
                    type={shown ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={values[k] ?? ""}
                    onChange={e => setValues(v => ({ ...v, [k]: e.target.value }))}
                    onPaste={e => onPaste(e, k)}
                    placeholder="paste value…"
                  />
                  <button
                    type="button"
                    className="tb-btn env-eye"
                    onClick={() => toggleReveal(k)}
                    title={shown ? "hide" : "reveal"}
                  >{shown ? "hide" : "show"}</button>
                </div>
              </div>
            );
          })}
          <div className="env-modal-add">
            <input
              value={newKey}
              placeholder="add another KEY…"
              onChange={e => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
              onKeyDown={e => {
                if (e.key === "Enter" && newKey.trim()) {
                  const k = newKey.trim();
                  if (!dynNames.includes(k)) {
                    setDynNames([...dynNames, k]);
                    setValues(v => ({ ...v, [k]: "" }));
                  }
                  setNewKey("");
                }
              }}
            />
            <button
              type="button"
              className="tb-btn"
              disabled={!newKey.trim() || dynNames.includes(newKey.trim())}
              onClick={() => {
                const k = newKey.trim();
                setDynNames([...dynNames, k]);
                setValues(v => ({ ...v, [k]: "" }));
                setNewKey("");
              }}
            >+ add</button>
          </div>
        </div>

        {error && <div className="env-modal-error">{error}</div>}

        <div className="env-modal-actions">
          <button className="tb-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button
            className="tb-btn"
            onClick={() => save(false)}
            disabled={saving || !filledCount}
          >Save</button>
          <button
            className="send-btn"
            onClick={() => save(true)}
            disabled={saving || !filledCount}
            title="Save these values and re-send your last message"
          >{saving ? "saving…" : "Save & retry"}</button>
        </div>

        <div className="modal-hint">
          Tip: paste a multi-line <code>KEY=VALUE</code> block into any field to auto-fill matching keys.
        </div>
      </div>
    </div>
  );
}
