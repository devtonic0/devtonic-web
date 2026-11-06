import React, { useCallback, useEffect, useState } from "react";
import { loadSettings, saveSettings } from "../store.js";

// API Usage: parses agent.log API-call lines (tokens in/out + model) into
// per-day / per-model usage, estimates cost from a price table, and enforces
// user-set warning/limit thresholds (visual banner; limit = red alert).
const fs = window.require("fs");
const path = window.require("path");
const os = window.require("os");
const { spawn } = window.require("child_process");

const HERMES = path.join(os.homedir(), ".local", "bin", "hermes");
const LOG = path.join(os.homedir(), ".hermes", "logs", "agent.log");

// $ per 1M tokens (input, output). Editable in the UI; persisted to settings.
const DEFAULT_PRICES = {
  "claude-fable-5-1": { in: 3, out: 15 },
  "claude-fable-5": { in: 3, out: 15 },
  "claude-opus-5-5": { in: 15, out: 75 },
  "claude-opus-5": { in: 15, out: 75 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-opus-4": { in: 15, out: 75 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  default: { in: 3, out: 15 },
};

// cache hit discount: cached input tokens billed at 10% (Anthropic cache-read)
function parseLog(text) {
  const byDay = new Map(); // day -> { models: Map(model -> {in, out, cachedIn, calls}) }
  const re = /^(\d{4}-\d{2}-\d{2}) [\d:,. ]+INFO .*?conversation_loop: API call #\d+: model=(\S+) provider=\S+ in=(\d+) out=(\d+).*?(?:cache=(\d+)\/(\d+))?/;
  for (const line of text.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    const [, day, model, tin, tout, cached] = m;
    if (!byDay.has(day)) byDay.set(day, new Map());
    const models = byDay.get(day);
    if (!models.has(model)) models.set(model, { in: 0, out: 0, cachedIn: 0, calls: 0 });
    const s = models.get(model);
    s.in += +tin; s.out += +tout; s.cachedIn += +(cached ?? 0); s.calls++;
  }
  return byDay;
}

function cost(stats, prices) {
  const p = prices[stats.model] ?? prices.default;
  const fresh = stats.in - stats.cachedIn;
  return (Math.max(fresh, 0) * p.in + stats.cachedIn * p.in * 0.1 + stats.out * p.out) / 1e6;
}

const fmtT = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(n));
const fmt$ = n => "$" + n.toFixed(n >= 10 ? 0 : 2);

export default function Usage() {
  const s0 = loadSettings();
  const [prices, setPrices] = useState(s0.prices ?? DEFAULT_PRICES);
  const [warnAt, setWarnAt] = useState(s0.usageWarn ?? 10);
  const [limitAt, setLimitAt] = useState(s0.usageLimit ?? 25);
  const [days, setDays] = useState([]);
  const [today, setToday] = useState({ cost: 0, in: 0, out: 0, calls: 0 });
  const [rateBusy, setRateBusy] = useState("");
  const [rateMsg, setRateMsg] = useState("");

  const refresh = useCallback(() => {
    let text = "";
    try { text = fs.readFileSync(LOG, "utf8"); } catch { return; }
    const byDay = parseLog(text);
    const rows = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14).map(([day, models]) => {
      let dayCost = 0, tin = 0, tout = 0, calls = 0;
      const perModel = [...models.entries()].map(([model, st]) => {
        const c = cost({ ...st, model }, prices);
        dayCost += c; tin += st.in; tout += st.out; calls += st.calls;
        return { model, ...st, cost: c };
      }).sort((a, b) => b.cost - a.cost);
      return { day, cost: dayCost, in: tin, out: tout, calls, perModel };
    });
    setDays(rows);
    const todayKey = new Date().toISOString().slice(0, 10);
    const t = rows.find(r => r.day === todayKey);
    setToday(t ?? { cost: 0, in: 0, out: 0, calls: 0 });
  }, [prices]);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30000);
    return () => clearInterval(iv);
  }, [refresh]);

  function saveThresholds(w, l) {
    setWarnAt(w); setLimitAt(l);
    saveSettings({ usageWarn: w, usageLimit: l });
  }
  function setPrice(model, key, val) {
    const next = { ...prices, [model]: { ...(prices[model] ?? prices.default), [key]: +val || 0 } };
    setPrices(next);
    saveSettings({ prices: next });
  }

  function resetRates() {
    setPrices(DEFAULT_PRICES);
    saveSettings({ prices: DEFAULT_PRICES });
    setRateMsg("rates reset to defaults");
  }

  // AI rate lookup: Hermes web-searches current $/1M pricing for a model.
  function aiFindRates(model) {
    if (rateBusy) return;
    setRateBusy(model);
    setRateMsg("");
    const prompt = `Search the web for the current API pricing of the LLM model "${model}" in USD per 1 million tokens (input and output). Reply with ONLY this JSON on one line, nothing else: {"in": <input $/1M>, "out": <output $/1M>, "source": "<url>"}`;
    let out = "";
    const p = spawn(HERMES, ["--cli", "-z", prompt], { env: { ...process.env } });
    p.stdout.on("data", d => (out += d.toString()));
    p.on("close", () => {
      setRateBusy("");
      try {
        const j = JSON.parse(out.trim().match(/\{[^}]*\}/)?.[0] ?? "");
        if (typeof j.in !== "number" || typeof j.out !== "number") throw new Error();
        const next = { ...prices, [model]: { in: j.in, out: j.out } };
        setPrices(next);
        saveSettings({ prices: next });
        setRateMsg(`✓ ${model}: $${j.in}/M in · $${j.out}/M out — ${j.source ?? "web"}`);
      } catch {
        setRateMsg(`⚠️ couldn't parse rates for ${model}: ${out.trim().slice(0, 120)}`);
      }
    });
    p.on("error", e => { setRateBusy(""); setRateMsg(`⚠️ ${e.message}`); });
  }

  const status = today.cost >= limitAt ? "limit" : today.cost >= warnAt ? "warn" : "ok";
  const maxCost = Math.max(...days.map(d => d.cost), 0.01);

  return (
    <div className="panel-body">
      <div className="usage-scroll">
        {status !== "ok" && (
          <div className={`usage-banner ${status}`}>
            {status === "limit"
              ? `⛔ LIMIT REACHED — today ${fmt$(today.cost)} ≥ ${fmt$(limitAt)} limit. Consider pausing or switching to a cheaper model in ⚙ Config.`
              : `⚠️ ${fmt$(today.cost)} today — past your ${fmt$(warnAt)} warning threshold.`}
          </div>
        )}

        <div className="usage-today">
          <div>
            <div className="usage-big" style={{ color: status === "limit" ? "var(--red)" : status === "warn" ? "var(--warn)" : "var(--ok)" }}>
              {fmt$(today.cost)}
            </div>
            <div className="usage-sub">today (est.)</div>
          </div>
          <div className="usage-meters">
            <div className="usage-meter"><span>vs warning {fmt$(warnAt)}</span>
              <div className="meter"><div className="meter-fill warn" style={{ width: Math.min(100, (today.cost / warnAt) * 100) + "%" }} /></div>
            </div>
            <div className="usage-meter"><span>vs limit {fmt$(limitAt)}</span>
              <div className="meter"><div className="meter-fill limit" style={{ width: Math.min(100, (today.cost / limitAt) * 100) + "%" }} /></div>
            </div>
            <div className="usage-sub">{today.calls} calls · {fmtT(today.in)} in / {fmtT(today.out)} out</div>
          </div>
        </div>

        <div className="git-section">thresholds</div>
        <div className="cfg-row">
          <label className="usage-label">warn at $<input type="number" value={warnAt} min={0} onChange={e => saveThresholds(+e.target.value, limitAt)} /></label>
          <label className="usage-label">limit at $<input type="number" value={limitAt} min={0} onChange={e => saveThresholds(warnAt, +e.target.value)} /></label>
          <span className="cfg-hint" style={{ margin: "auto 0" }}>per day, estimated</span>
        </div>

        <div className="git-section">last {days.length} days</div>
        {days.map(d => (
          <div key={d.day} className="usage-day">
            <span className="usage-date">{d.day.slice(5)}</span>
            <div className="usage-bar-wrap">
              <div className="usage-bar" style={{ width: Math.max(2, (d.cost / maxCost) * 100) + "%" }} />
            </div>
            <span className="usage-cost">{fmt$(d.cost)}</span>
            <span className="usage-detail">{d.calls} calls · {fmtT(d.in + d.out)} tok</span>
          </div>
        ))}

        <div className="git-section">by model (today) + rates $/1M</div>
        {(today.perModel ?? []).map(m => (
          <div key={m.model} className="usage-model">
            <span className="usage-model-name">{m.model}</span>
            <span className="usage-detail">{m.calls} calls · {fmtT(m.in)}/{fmtT(m.out)} · cache {m.in ? Math.round((m.cachedIn / m.in) * 100) : 0}%</span>
            <span className="usage-cost">{fmt$(m.cost)}</span>
            <label className="usage-rate">in <input type="number" step="0.05" value={(prices[m.model] ?? prices.default).in} onChange={e => setPrice(m.model, "in", e.target.value)} /></label>
            <label className="usage-rate">out <input type="number" step="0.05" value={(prices[m.model] ?? prices.default).out} onChange={e => setPrice(m.model, "out", e.target.value)} /></label>
            <button
              className="tb-btn"
              title="AI: search the web for this model's current pricing"
              disabled={!!rateBusy}
              onClick={() => aiFindRates(m.model)}
            >{rateBusy === m.model ? "…" : "✨ find"}</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
          <button className="tb-btn" onClick={resetRates}>↺ reset all rates to defaults</button>
          {rateBusy && <span className="cfg-hint">✨ Hermes is searching for {rateBusy} pricing…</span>}
        </div>
        {rateMsg && <div className="cfg-hint" style={{ marginTop: 6 }}>{rateMsg}</div>}
        <div className="cfg-hint" style={{ marginTop: 8 }}>
          Estimates from agent.log token counts; cached input billed at 10%. Edit rates inline, or ✨ find lets Hermes look up current pricing online.
        </div>
      </div>
    </div>
  );
}
