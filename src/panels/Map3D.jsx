import React, { useEffect, useRef, useState } from "react";
import ForceGraph2D from "force-graph";
import { forceCollide, forceX, forceY } from "d3-force";
import { projectRoot, bus, scanTree, loadMission } from "../store.js";

// Bubble map (bubblemaps-style): 2D draggable bubbles, one color per
// top-level folder cluster, per-cluster gravity wells so clusters ball up
// and can be dragged apart to isolate. Import edges colored by source cluster.
const fs = window.require("fs");
const path = window.require("path");

const hsl = (h, s, l, a = 1) => `hsla(${Math.round(h)},${s}%,${l}%,${a})`;

// Impulse-based cluster interaction — nudges nodes toward or away from a
// target with distance-scaled strength and NEVER pins them (so d3-force's
// collision keeps bubbles apart). Reheats the sim so the effect settles nicely.
function magnetize(g, target, mode, strength) {
  const nodes = g.graphData().nodes;
  const filter =
    mode === "cluster" ? m => m.cluster === target.cluster :
    mode === "subKey"  ? m => m.subKey === target.subKey  :
    mode === "repel"   ? m => true                        :
    mode === "single"  ? m => false                       :
    () => false;
  for (const m of nodes) {
    if (m === target || !filter(m)) continue;
    // Unpin — pinned nodes ignore forces so magnetize would look dead on them.
    m.fx = null; m.fy = null;
    const dx = target.x - (m.x ?? 0);
    const dy = target.y - (m.y ?? 0);
    const dist = Math.hypot(dx, dy) || 1;
    // Impulse: fraction of the offset toward (positive) or away (negative) target.
    // Distance-scaled falloff so far bubbles move less than close ones (for pull),
    // and close bubbles move MORE than far ones (for repel).
    const s = strength * (mode === "repel" ? Math.max(0.15, 80 / dist) : Math.min(1, 90 / dist));
    m.x = (m.x ?? 0) + dx * s;
    m.y = (m.y ?? 0) + dy * s;
  }
  // Reheat the sim so d3-force resolves collisions/wells.
  g.d3ReheatSimulation?.();
}

// Primary clusters by file TYPE (not folder) — files in same folder but
// different types end up on opposite sides of the map. Sub-cluster (folder)
// keeps files from the same folder tightly packed inside their type's blob.
const TYPE_HUE = {
  pages: 355, components: 45, functions: 200, styles: 320, tests: 12,
  config: 55, api: 130, data: 260, assets: 90, docs: 90, other: 220,
};
const TYPE_DESC = {
  pages: "Route/page components — top-level screens the user visits.",
  components: "Reusable UI components — buttons, cards, widgets composed into pages.",
  functions: "Utilities, hooks, and pure logic modules (lib/, utils/, hooks/).",
  styles: "Stylesheets — CSS/SCSS/Tailwind used across the app.",
  tests: "Test suites — unit, integration, and e2e tests.",
  config: "Build/tooling config — package.json, vite, tailwind, docker, etc.",
  api: "Server endpoints, route handlers, and backend integrations.",
  data: "Static data, schemas, migrations, JSON/YAML manifests.",
  assets: "Images, fonts, icons, and other bundled media.",
  docs: "Markdown documentation and READMEs.",
  other: "Files that don't fit a specific category.",
};
const TYPE_SHORT = {
  pages: "routes/pages", components: "reusable UI", functions: "utils & hooks",
  styles: "CSS/SCSS", tests: "tests", config: "build tooling", api: "server",
  data: "data/schema", assets: "media", docs: "docs", other: "other",
};

function classify(id, rel) {
  const p = rel.replace(/\\/g, "/").toLowerCase();
  const base = p.split("/").pop() || "";
  // config first — package.json, vite.config.ts, etc.
  if (/(?:^|\/)(package\.json|package-lock|yarn\.lock|pnpm-lock|tsconfig|jsconfig|vite\.config|next\.config|nuxt\.config|astro\.config|tailwind\.config|postcss\.config|babel\.config|webpack\.config|rollup\.config|electron-builder|\.eslintrc|\.prettierrc|\.editorconfig|dockerfile|docker-compose|makefile|\.env|\.gitignore)/i.test(base)) return "config";
  if (/\.(css|scss|sass|less|styl|postcss)$/i.test(p)) return "styles";
  if (/(?:^|\/)(?:__tests__|tests?|e2e|cypress|playwright)\//i.test(p) || /\.(test|spec)\.[jt]sx?$/i.test(p)) return "tests";
  if (/(?:^|\/)(?:public|static|assets|images?|fonts?|icons?)\//i.test(p) || /\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|mp3|mp4|wav)$/i.test(p)) return "assets";
  if (/\.(md|mdx|rst|txt)$/i.test(p) && !/(?:changelog|license)/i.test(base)) return "docs";
  if (/\.(json|ya?ml|toml|xml|csv|tsv|sql)$/i.test(p)) return "data";
  if (/(?:^|\/)(?:api|routes?|server|handlers?|controllers?|endpoints?|edge)\//i.test(p) ||
      /(?:^|\/)app\/.*\/route\.[jt]sx?$/i.test(p) ||
      /(?:^|\/)pages\/api\//i.test(p)) return "api";
  if (/(?:^|\/)pages\//i.test(p) ||
      /(?:^|\/)app\/.*\/(?:page|layout|loading|error|not-found|template)\.[jt]sx?$/i.test(p) ||
      /(?:^|\/)(?:routes?|views?|screens?)\//i.test(p)) return "pages";
  // components: PascalCase file OR in components/, plus JSX/TSX
  if (/\.(jsx|tsx)$/i.test(p)) {
    if (/(?:^|\/)(?:components?|panels?|widgets?|features?|ui|shared)\//i.test(p)) return "components";
    if (/^[A-Z]/.test(base.replace(/\.(jsx|tsx)$/i, ""))) return "components";
    return "components";
  }
  // functions / utils / hooks / lib
  if (/(?:^|\/)(?:lib|libs|utils?|helpers?|hooks?|services?|store|state|context)\//i.test(p) ||
      /\.(mjs|cjs|js|ts)$/i.test(p)) return "functions";
  return "other";
}

function buildGraph(root) {
  const { nodes: raw } = scanTree(root);
  const nodes = raw.filter(n => !n.dir);
  // Sub-cluster = immediate parent folder relative to root. Assigns per node.
  const clusters = new Map(); // primary type → hue
  const subclusters = new Map(); // "type/subdir" → { type, sub, hueShift }
  for (const n of nodes) {
    const rel = path.relative(root, n.id).replace(/\\/g, "/");
    const type = classify(n.id, rel);
    const sub = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "·root";
    n.cluster = type;
    n.sub = sub;
    n.subKey = `${type}/${sub}`;
    if (!clusters.has(type)) clusters.set(type, TYPE_HUE[type] ?? 220);
    if (!subclusters.has(n.subKey)) {
      // Deterministic hue shift per sub within a type so subfolders look distinct
      const h = (Array.from(sub).reduce((a, c) => a + c.charCodeAt(0), 0) * 31) % 36 - 18;
      subclusters.set(n.subKey, { type, sub, hueShift: h });
    }
    n.hue = clusters.get(type) + subclusters.get(n.subKey).hueShift;
    n.r = Math.max(4, Math.min(20, Math.sqrt(n.size) * 2.0));
  }
  const importLinks = scanImports(nodes, root);
  const hueOf = new Map(nodes.map(n => [n.id, n.hue]));
  for (const l of importLinks) l.hue = hueOf.get(l.target) ?? 220;
  return { nodes, links: importLinks, clusters, subclusters };
}

// Two-tier gravity: primary type wells sit on outer ring; each sub-cluster
// gets a smaller satellite offset around its type's well.
function wells(clusters, subclusters, spread) {
  const names = [...clusters.keys()];
  const typeWells = new Map();
  names.forEach((name, i) => {
    const a = (i / names.length) * Math.PI * 2;
    typeWells.set(name, { x: Math.cos(a) * spread, y: Math.sin(a) * spread });
  });
  const subWells = new Map();
  const byType = new Map();
  for (const [key, { type }] of subclusters) {
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(key);
  }
  const subRadius = spread * 0.28;
  for (const [type, keys] of byType) {
    const parent = typeWells.get(type) || { x: 0, y: 0 };
    keys.forEach((key, i) => {
      const a = (i / Math.max(1, keys.length)) * Math.PI * 2;
      subWells.set(key, { x: parent.x + Math.cos(a) * subRadius, y: parent.y + Math.sin(a) * subRadius });
    });
  }
  return { typeWells, subWells };
}

const clusterDesc = (n, m) => m?.clusterInfo?.[n] ?? TYPE_DESC[n] ?? `The ${n} category.`;
const clusterShort = (n, m) => m?.clusterShort?.[n] ?? TYPE_SHORT[n] ?? "files";

function scanImports(nodes, root) {
  const byPath = new Map(nodes.map(n => [n.id, n]));
  const links = [];
  const srcFiles = nodes.filter(n => !n.dir && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(n.name));
  const resolve = (spec, fromDir) => {
    let base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : path.resolve(fromDir, spec);
    for (const cand of [base, base + ".ts", base + ".tsx", base + ".js", base + ".jsx", path.join(base, "index.ts"), path.join(base, "index.js")]) {
      if (byPath.has(cand)) return cand;
    }
    return null;
  };
  for (const f of srcFiles) {
    let text;
    try {
      if (fs.statSync(f.id).size > 150_000) continue;
      text = fs.readFileSync(f.id, "utf8");
    } catch { continue; }
    for (const m of text.matchAll(/(?:import[\s\S]*?from\s+|require\()["']((?:\.|@\/)[^"']+)["']/g)) {
      const target = resolve(m[1], path.dirname(f.id));
      if (target && target !== f.id) links.push({ source: f.id, target, kind: "import" });
    }
  }
  return links;
}

export default function Map3D() {
  const mountRef = useRef(null);
  const stateRef = useRef({ hidden: new Set() });
  const [stats, setStats] = useState({ nodes: 0, imports: 0, root: projectRoot });
  const [legend, setLegend] = useState([]);
  const [showKey, setShowKey] = useState(true);
  const [showHud, setShowHud] = useState(true);
  const [hidden, setHidden] = useState(new Set());
  const [mission, setMission] = useState(loadMission);

  useEffect(() => {
    const el = mountRef.current;
    const st = stateRef.current;
    const g = new ForceGraph2D(el)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .nodeVal(n => n.r * n.r * 0.28)
      .nodeLabel(n => {
        const rel = path.relative(projectRoot, n.id);
        return `<div style="font:11px monospace;background:#131826;border:1px solid #2b3450;border-radius:8px;padding:6px 10px;color:#d7dce8;max-width:340px">
          <b style="color:${hsl(n.hue, 75, 62)}">${n.cluster}</b> · <span style="color:#9aa5c0">${n.sub === "·root" ? "root" : n.sub}</span><br/>${rel}
          <div style="color:#7c86a2;margin-top:3px;white-space:normal">${clusterDesc(n.cluster, loadMission())}</div></div>`;
      })
      // Interaction modes (bubblemap-style):
      //   click       → magnetize the whole PRIMARY cluster toward this node
      //   ctrl+click  → magnetize the SUB-cluster (type + folder) toward this node
      //   alt+click   → gently repel neighbors away (adds breathing room)
      //   shift+click → nothing (used with drag)
      //   drag        → move whole primary cluster rigidly
      //   ctrl+drag   → move whole SUB-cluster rigidly
      //   shift+drag  → single node only
      // A larger collision radius keeps bubbles from ever touching.
      .onNodeClick((n, evt) => {
        // Fire the file-open on plain click; hold a modifier to layout instead.
        if (!evt?.ctrlKey && !evt?.metaKey && !evt?.altKey && !evt?.shiftKey) {
          // Magnetize the primary cluster toward this node with a soft impulse.
          magnetize(st.g, n, "cluster", 0.35);
          bus.emit("open-file", n.id);
          return;
        }
        if (evt.altKey)                   magnetize(st.g, n, "repel",     -0.20);
        else if (evt.ctrlKey || evt.metaKey) magnetize(st.g, n, "subKey",   0.45);
        else if (evt.shiftKey)            magnetize(st.g, n, "single",    0);
      })
      .onNodeDrag((n, delta) => {
        if (!delta) return;
        if (st.shiftDrag) return;                          // single-node drag
        const nodes = st.g.graphData().nodes;
        const key = st.ctrlDrag ? "subKey" : "cluster";
        // Move the whole cluster with the drag AND pin each peer to its new
        // position so d3-force can't pull them back once the drag ends.
        for (const m of nodes) {
          if (m === n || m[key] !== n[key]) continue;
          const nx = (m.x ?? 0) + delta.x;
          const ny = (m.y ?? 0) + delta.y;
          m.x = nx; m.y = ny;
          m.fx = nx; m.fy = ny;                           // pin
        }
      })
      .nodeCanvasObject((n, ctx, scale) => {
        if (st.hidden.has(n.cluster)) return;
        // Force sim may not have positioned yet on first paint — skip until finite.
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
        const r = Number.isFinite(n.r) ? n.r : 4;
        // pop-in animation: grow radius over first ~500ms
        const born = n.__born ?? (n.__born = performance.now());
        const t = Math.min(1, (performance.now() - born) / 500);
        const rr = r * (0.2 + 0.8 * (1 - Math.pow(1 - t, 3)));
        // soft bubble: radial gradient, brighter core
        const grad = ctx.createRadialGradient(n.x - rr * 0.3, n.y - rr * 0.3, rr * 0.1, n.x, n.y, rr);
        grad.addColorStop(0, hsl(n.hue, 60, 74));
        grad.addColorStop(1, hsl(n.hue, 55, 52));
        ctx.beginPath();
        ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.globalAlpha = 0.95;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = Math.max(0.4, 1 / scale);
        ctx.strokeStyle = hsl(n.hue, 80, 62, 0.9);
        ctx.stroke();
      })
      .nodePointerAreaPaint((n, color, ctx) => {
        if (st.hidden.has(n.cluster)) return;
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
        ctx.beginPath();
        ctx.arc(n.x, n.y, (Number.isFinite(n.r) ? n.r : 4) + 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      })
      .linkVisibility(l => {
        const s = typeof l.source === "object" ? l.source.cluster : null;
        const t = typeof l.target === "object" ? l.target.cluster : null;
        return !st.hidden.has(s) && !st.hidden.has(t);
      })
      .linkColor(l => (l.kind === "import" ? hsl(l.hue, 80, 60, 0.5) : "rgba(124,134,162,.14)"))
      .linkWidth(l => (l.kind === "import" ? 1.3 : 0.5))
      .linkDirectionalParticles(l => (l.kind === "import" ? 1 : 0))
      .linkDirectionalParticleSpeed(0.004)
      .linkDirectionalParticleWidth(1.6)
      .onNodeDragEnd(n => {
        // Pin the dragged node (and any cluster peers already pinned during drag)
        // in place — they stay where dropped, no springing back.
        n.fx = n.x; n.fy = n.y;
      })
      .onBackgroundClick(() => {})
      .cooldownTicks(200)
      .d3AlphaDecay(0.015)
      .d3VelocityDecay(0.25);

    st.g = g;

    const load = (root) => {
      const data = buildGraph(root);
      const { subWells } = wells(data.clusters, data.subclusters, Math.min(el.clientWidth, el.clientHeight) * 0.36 || 280);
      // Files pull toward their type+folder sub-well. Once a node is dragged
      // its fx/fy pin overrides the well, so it stays where dropped.
      g.d3Force("x", forceX(n => subWells.get(n.subKey)?.x ?? 0).strength(0.09));
      g.d3Force("y", forceY(n => subWells.get(n.subKey)?.y ?? 0).strength(0.09));
      // Cushion: radius + 6px pad so bubbles never touch, strength 1 = hard boundary.
      g.d3Force("collide", forceCollide(n => n.r + 6).strength(1).iterations(2));
      g.d3Force("charge").strength(-14);  // slight extra repulsion — keeps things separated
      g.d3Force("link").distance(l => (l.kind === "import" ? 80 : 16)).strength(l => (l.kind === "import" ? 0.02 : 0.4));
      for (const n of data.nodes) delete n.__born;
      g.graphData({ nodes: data.nodes, links: data.links });
      setTimeout(() => g.zoomToFit(600, 60), 700);
      setStats({ nodes: data.nodes.length, imports: data.links.filter(l => l.kind === "import").length, root });
      setLegend([...data.clusters.entries()].sort((a, b) => a[0].localeCompare(b[0])));
      setMission(loadMission(root));
      st.hidden = new Set();
      setHidden(new Set());
    };
    load(projectRoot);
    const off = bus.on("project", load);
    // Manual refresh — the map is a snapshot; when child repos/files are added
    // after load (common in a parent-of-repos), nothing re-scans automatically.
    // The ⟳ button in the HUD emits this to force a fresh scan of the same root.
    const offRefresh = bus.on("map-refresh", () => load(projectRoot));

    const ro = new ResizeObserver(() => { g.width(el.clientWidth); g.height(el.clientHeight); });
    ro.observe(el);
    const onKey = e => { st.shiftDrag = e.shiftKey; st.ctrlDrag = e.ctrlKey || e.metaKey; };
    // Also track modifiers via mouse events — keyup can miss ctrl release during
    // a drag, and mousedown doesn't fire our keydown listener.
    const onMouse = e => { st.shiftDrag = e.shiftKey; st.ctrlDrag = e.ctrlKey || e.metaKey; };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    el.addEventListener("mousedown", onMouse, true);
    el.addEventListener("mousemove", onMouse, true);
    return () => { off(); offRefresh(); ro.disconnect(); g._destructor?.();
      window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKey);
      el.removeEventListener("mousedown", onMouse, true);
      el.removeEventListener("mousemove", onMouse, true);
    };
  }, []);

  function toggleCluster(name) {
    setHidden(h => {
      const n = new Set(h);
      n.has(name) ? n.delete(name) : n.add(name);
      const st = stateRef.current;
      st.hidden = n;
      // re-evaluate BOTH node canvas + link visibility
      st.g.linkVisibility(st.g.linkVisibility());
      return n;
    });
  }
  function showAll() {
    const st = stateRef.current;
    st.hidden = new Set();
    st.g.linkVisibility(st.g.linkVisibility());
    setHidden(new Set());
  }

  return (
    <div className="panel-body">
      <div className="map-wrap">
        <div ref={mountRef} className="map-canvas" />
        {showHud ? (
          <div className="map-hud">
            <button className="hud-close" title="hide" onClick={() => setShowHud(false)}>✕</button>
            <b>{stats.root.split("/").pop()}</b> · {stats.nodes} nodes · {stats.imports} imports
            <button className="tb-btn" style={{ marginLeft: 8, padding: "1px 7px" }}
                    title="Re-scan the project (picks up newly added files / child repos)"
                    onClick={() => bus.emit("map-refresh")}>⟳ rescan</button>
            <div style={{ marginTop: 2 }}>drag bubbles to isolate clusters · flowing dots = imports · click file → code</div>
          </div>
        ) : (
          <button className="key-toggle" style={{ left: 10, right: "auto" }} onClick={() => setShowHud(true)}>ⓘ</button>
        )}
        {!showKey && <button className="key-toggle" onClick={() => setShowKey(true)}>⟩ key</button>}
        {showKey && (
          <div className="map-key">
            <button className="hud-close" title="hide key" onClick={() => setShowKey(false)}>✕</button>
            <div className="map-key-title">KEY — click to filter · click node = magnetize cluster · ctrl = sub-cluster · alt = repel · shift = single · drag to move</div>
            {legend.map(([name, hue]) => (
              <div
                key={name}
                className={`key-row ${hidden.has(name) ? "off" : ""}`}
                title={clusterDesc(name, mission)}
                onClick={() => toggleCluster(name)}
              >
                <i style={{ background: hsl(hue, 78, 58) }} />
                <span className="key-name">{name}</span>
                <span className="key-desc">{clusterShort(name, mission)}</span>
              </div>
            ))}
            {hidden.size > 0 && <button className="tb-btn" style={{ marginTop: 6 }} onClick={showAll}>show all</button>}
          </div>
        )}
      </div>
    </div>
  );
}
