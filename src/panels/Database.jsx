import React, { useCallback, useEffect, useState } from "react";
import { projectRoot, bus } from "../store.js";

// Database: auto-connects to Supabase using URL + service key from the
// project's env files. Table browser, row paging, filter, insert, delete.
const fs = window.require("fs");
const path = window.require("path");

function findCreds(root) {
  for (const rel of [".env.local", ".env", "backend/.env", "api/.env"]) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8");
    const url = text.match(/^(?:NEXT_PUBLIC_)?SUPABASE_URL\s*=\s*["']?([^"'\n]+)/m)?.[1];
    const key = text.match(/^SUPABASE_(?:SERVICE_ROLE_KEY|SERVICE_KEY|SECRET(?:_KEY)?)\s*=\s*["']?([^"'\n]+)/m)?.[1]
      ?? text.match(/^(?:NEXT_PUBLIC_)?SUPABASE_ANON_KEY\s*=\s*["']?([^"'\n]+)/m)?.[1];
    if (url && key) return { url: url.trim(), key: key.trim(), source: rel };
  }
  return null;
}

async function rest(creds, pathname, opts = {}) {
  const r = await fetch(`${creds.url}${pathname}`, {
    ...opts,
    headers: {
      apikey: creds.key,
      Authorization: `Bearer ${creds.key}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer ?? "count=exact",
      ...(opts.headers ?? {}),
    },
  });
  const total = r.headers.get("content-range")?.split("/")[1];
  const body = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.message ?? `HTTP ${r.status}`);
  return { body, total: total ? +total : null };
}

const PAGE = 50;

export default function Database() {
  const [creds, setCreds] = useState(() => findCreds(projectRoot));
  const [tables, setTables] = useState([]);
  const [table, setTable] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [insertJson, setInsertJson] = useState("");
  const [showInsert, setShowInsert] = useState(false);

  useEffect(() => bus.on("project", root => {
    setCreds(findCreds(root));
    setTables([]); setTable(null); setRows([]); setError("");
  }), []);

  // discover tables from the OpenAPI root
  useEffect(() => {
    if (!creds) return;
    rest(creds, "/rest/v1/", {}).then(({ body }) => {
      const names = Object.keys(body?.definitions ?? body?.paths ?? {})
        .map(k => k.replace(/^\//, "")).filter(k => k && !k.includes("{"));
      setTables([...new Set(names)].sort());
    }).catch(e => setError(String(e.message)));
  }, [creds]);

  const loadRows = useCallback((t = table, p = page, f = filter) => {
    if (!creds || !t) return;
    const q = f.trim() ? `&${f.trim()}` : "";
    rest(creds, `/rest/v1/${t}?select=*&limit=${PAGE}&offset=${p * PAGE}${q}`)
      .then(({ body, total }) => { setRows(body ?? []); setTotal(total); setError(""); })
      .catch(e => { setError(String(e.message)); setRows([]); });
  }, [creds, table, page, filter]);

  useEffect(() => { loadRows(); }, [table, page]);

  function insertRow() {
    try {
      const data = JSON.parse(insertJson);
      rest(creds, `/rest/v1/${table}`, { method: "POST", body: JSON.stringify(data), prefer: "return=representation" })
        .then(() => { setShowInsert(false); setInsertJson(""); loadRows(); })
        .catch(e => setError(String(e.message)));
    } catch { setError("Invalid JSON"); }
  }

  function deleteRow(row) {
    const pk = row.id !== undefined ? `id=eq.${row.id}` : null;
    if (!pk) { setError("No `id` column — delete via SQL editor in Supabase dashboard."); return; }
    if (!confirm(`Delete row id=${row.id} from ${table}?`)) return;
    rest(creds, `/rest/v1/${table}?${pk}`, { method: "DELETE", prefer: "return=minimal" })
      .then(() => loadRows()).catch(e => setError(String(e.message)));
  }

  if (!creds) {
    return (
      <div className="panel-body">
        <div className="empty-hint" style={{ padding: 24 }}>
          No database credentials found.<br /><br />
          Add <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> (or anon key) — ask Hermes anything that needs the DB and the paste modal will pop up.
        </div>
      </div>
    );
  }

  const cols = rows.length ? Object.keys(rows[0]) : [];

  return (
    <div className="panel-body">
      <div className="db-head">
        <select className="session-select" value={table ?? ""} onChange={e => { setTable(e.target.value); setPage(0); }}>
          <option value="" disabled>select table…</option>
          {tables.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          className="db-filter"
          value={filter}
          placeholder="filter (PostgREST): role=eq.rep&order=created_at.desc"
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => e.key === "Enter" && (setPage(0), loadRows(table, 0, filter))}
        />
        <button className="tb-btn" onClick={() => loadRows()}>refresh</button>
        <button className="tb-btn" onClick={() => setShowInsert(s => !s)} disabled={!table}>+ row</button>
      </div>
      {showInsert && (
        <div className="db-insert">
          <textarea value={insertJson} onChange={e => setInsertJson(e.target.value)} placeholder='{"name": "value", …}' rows={3} />
          <button className="send-btn" onClick={insertRow}>insert</button>
        </div>
      )}
      {error && <div className="db-error">⚠️ {error}</div>}
      <div className="db-scroll">
        {table && rows.length === 0 && !error && <div className="empty-hint">no rows</div>}
        {rows.length > 0 && (
          <table className="db-table">
            <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}<th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map(c => (
                    <td key={c} title={JSON.stringify(r[c])}>
                      {r[c] === null ? <i style={{ opacity: .4 }}>null</i> : typeof r[c] === "object" ? JSON.stringify(r[c]).slice(0, 60) : String(r[c]).slice(0, 80)}
                    </td>
                  ))}
                  <td><button className="db-del" onClick={() => deleteRow(r)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="db-foot">
        <span>{creds.source} · {total ?? "?"} rows</span>
        <div style={{ flex: 1 }} />
        <button className="tb-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← prev</button>
        <span>page {page + 1}</span>
        <button className="tb-btn" disabled={total !== null && (page + 1) * PAGE >= total} onClick={() => setPage(p => p + 1)}>next →</button>
      </div>
    </div>
  );
}
