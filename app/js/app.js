// Wire Wizard — application core.
// One canvas, one state object, immediate-mode redraws. Runs identically in
// the Electron shell (window.wireWizard bridge) and a plain browser (test
// harness / demo), feature-detecting the bridge for file dialogs, settings,
// and AI calls.

import { ICON_TYPES, iconById, drawIcon, DEFAULT_CABLE_TYPES } from "./icons.js";
import { computeHeatmap, HEATMAP_LEGEND } from "./heatmap.js";
import { analyzeFloorplan } from "./ai.js";
import { loadFloorplan, exportPdf, bytesToBase64, base64ToBytes } from "./fileio.js";
import { makeDemoFloorplan } from "./demo.js";

/* ────────────────────────── state ────────────────────────── */

const state = {
  pages: [],            // [{canvas, label, ftPerPx, walls:[], aiWalls:[], items:[], legendPos}]
  pageIndex: 0,
  cableTypes: structuredClone(DEFAULT_CABLE_TYPES),
  activeCableId: DEFAULT_CABLE_TYPES[0].id,
  tool: "select",
  activeIconType: null,
  selection: null,      // {item} reference into current page items
  view: { x: 0, y: 0, zoom: 1 },
  showHeatmap: false,
  showWalls: true,
  heatmapCache: null,   // {canvas, key}
  settings: {
    anthropicApiKey: "",
    wallLossDb: 4.5,
    pathLossExp: 2.2,
    txAt1m: -40,
    iconScale: 1.4,
  },
  drawing: null,        // in-progress line/wall/scale gesture
  undoStack: [],
  redoStack: [],
  dirty: true,
  sourceName: "floorplan",
};

const page = () => state.pages[state.pageIndex] ?? null;

function newPage(canvas, label) {
  return {
    canvas, label,
    ftPerPx: null, scaleSource: null,
    walls: [], aiWalls: [],
    items: [],            // lines / icons / notes
    legendPos: null,      // {x,y} in image coords or null
  };
}

/* ────────────────────── persistence bridge ─────────────────── */

const bridge = window.wireWizard ?? null;

async function loadSettings() {
  if (bridge) Object.assign(state.settings, await bridge.getSettings());
  else {
    try { Object.assign(state.settings, JSON.parse(localStorage.getItem("ww-settings") || "{}")); }
    catch {}
  }
}
async function persistSettings() {
  if (bridge) await bridge.setSettings(state.settings);
  else localStorage.setItem("ww-settings", JSON.stringify(state.settings));
}

/* ────────────────────────── undo ───────────────────────────── */

function snapshot() {
  // Everything except the page bitmaps (immutable per load, huge).
  return JSON.stringify({
    pageIndex: state.pageIndex,
    cableTypes: state.cableTypes,
    pages: state.pages.map((p) => ({
      ftPerPx: p.ftPerPx, scaleSource: p.scaleSource,
      walls: p.walls, aiWalls: p.aiWalls, items: p.items, legendPos: p.legendPos,
    })),
  });
}
function pushUndo() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > 60) state.undoStack.shift();
  state.redoStack.length = 0;
}
function applySnapshot(snap) {
  const data = JSON.parse(snap);
  state.pageIndex = Math.min(data.pageIndex, state.pages.length - 1);
  state.cableTypes = data.cableTypes;
  data.pages.forEach((pd, i) => {
    const p = state.pages[i];
    if (!p) return;
    Object.assign(p, pd);
  });
  state.selection = null;
  invalidateHeatmap();
  refreshCablePanel();
  refreshProps();
  markDirty();
}
function undo() {
  if (!state.undoStack.length) return;
  state.redoStack.push(snapshot());
  applySnapshot(state.undoStack.pop());
}
function redo() {
  if (!state.redoStack.length) return;
  state.undoStack.push(snapshot());
  applySnapshot(state.redoStack.pop());
}

/* ────────────────────────── canvas ─────────────────────────── */

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
let dpr = window.devicePixelRatio || 1;

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  markDirty();
}
window.addEventListener("resize", resizeCanvas);

const toImg = (sx, sy) => ({
  x: (sx - state.view.x) / state.view.zoom,
  y: (sy - state.view.y) / state.view.zoom,
});
const toScreen = (ix, iy) => ({
  x: ix * state.view.zoom + state.view.x,
  y: iy * state.view.zoom + state.view.y,
});

function fitView() {
  const p = page();
  if (!p) return;
  const r = canvas.getBoundingClientRect();
  const z = Math.min(r.width / p.canvas.width, r.height / p.canvas.height) * 0.94;
  state.view.zoom = z;
  state.view.x = (r.width - p.canvas.width * z) / 2;
  state.view.y = (r.height - p.canvas.height * z) / 2;
  markDirty();
}

function markDirty() { state.dirty = true; }

function invalidateHeatmap() { state.heatmapCache = null; markDirty(); }

function allWalls(p) { return [...p.aiWalls, ...p.walls]; }

function heatmapCanvas(p) {
  const waps = p.items.filter((i) => i.kind === "icon" && i.type === "wap");
  const key = JSON.stringify([
    waps.map((w) => [w.x | 0, w.y | 0]),
    allWalls(p).length, p.ftPerPx,
    state.settings.wallLossDb, state.settings.pathLossExp, state.settings.txAt1m,
  ]);
  if (state.heatmapCache?.key === key) return state.heatmapCache.canvas;
  const ftPerPx = p.ftPerPx ?? 50 / p.canvas.width; // assume ~50ft wide if uncalibrated
  const hm = computeHeatmap(waps, allWalls(p), p.canvas.width, p.canvas.height, ftPerPx, state.settings);
  state.heatmapCache = { key, canvas: hm };
  return hm;
}

/* ─────────────── drawing annotations (shared w/ export) ─────────────── */

function cableById(id) {
  return state.cableTypes.find((c) => c.id === id) ?? state.cableTypes[0];
}

// Draw every annotation of page `p` onto `g` in IMAGE coordinates.
// `opts.zoom` only affects screen-constant sizing (selection handles).
function drawAnnotations(g, p, opts = {}) {
  const forExport = !!opts.forExport;

  // walls
  if (state.showWalls || forExport === false) {
    if (state.showWalls) {
      g.save();
      g.strokeStyle = "rgba(31,111,224,0.55)";
      g.lineWidth = 3;
      g.setLineDash([9, 6]);
      for (const w of allWalls(p)) {
        g.beginPath(); g.moveTo(w.x1, w.y1); g.lineTo(w.x2, w.y2); g.stroke();
      }
      g.restore();
    }
  }

  // cable lines
  for (const it of p.items) {
    if (it.kind !== "line") continue;
    const cable = cableById(it.cableTypeId);
    g.save();
    g.strokeStyle = cable.color;
    g.lineWidth = it.width ?? 4;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.beginPath();
    it.points.forEach((pt, i) => (i ? g.lineTo(pt.x, pt.y) : g.moveTo(pt.x, pt.y)));
    g.stroke();
    g.restore();
  }

  // icons
  for (const it of p.items) {
    if (it.kind !== "icon") continue;
    g.save();
    g.translate(it.x, it.y);
    g.rotate((it.rot ?? 0) * Math.PI / 180);
    g.scale(it.scale ?? 1, it.scale ?? 1);
    drawIcon(g, it.type);
    g.restore();
    if (it.label) {
      g.save();
      g.font = `600 ${13 * (it.scale ?? 1)}px Segoe UI, Arial`;
      g.textAlign = "center";
      g.fillStyle = "#141822";
      g.strokeStyle = "rgba(255,255,255,0.85)";
      g.lineWidth = 3;
      const ly = it.y + 30 * (it.scale ?? 1);
      g.strokeText(it.label, it.x, ly);
      g.fillText(it.label, it.x, ly);
      g.restore();
    }
  }

  // notes
  for (const it of p.items) {
    if (it.kind !== "note") continue;
    drawNote(g, it);
  }

  // legend
  if (p.legendPos) drawLegend(g, p, p.legendPos.x, p.legendPos.y);
}

function drawNote(g, it) {
  g.save();
  g.font = "14px Segoe UI, Arial";
  const lines = String(it.text || "…").split("\n");
  const w = Math.max(70, ...lines.map((l) => g.measureText(l).width)) + 18;
  const h = lines.length * 18 + 14;
  g.translate(it.x, it.y);
  g.fillStyle = "#fff9c9";
  g.strokeStyle = "#b8a83a";
  g.lineWidth = 1.5;
  g.beginPath();
  g.roundRect(0, 0, w, h, 4);
  g.fill();
  g.stroke();
  // folded corner
  g.beginPath();
  g.moveTo(w - 12, 0); g.lineTo(w, 12); g.lineTo(w - 12, 12); g.closePath();
  g.fillStyle = "#e8dc86";
  g.fill();
  g.fillStyle = "#3a4150";
  lines.forEach((l, i) => g.fillText(l, 9, 18 + i * 18));
  it._w = w; it._h = h; // cache for hit testing
  g.restore();
}

/* ───────────────────────── legend ─────────────────────────── */

function legendEntries(p) {
  const usedCables = new Map();
  const usedIcons = new Map();
  for (const it of p.items) {
    if (it.kind === "line") {
      const c = cableById(it.cableTypeId);
      usedCables.set(c.id, { ...c, count: (usedCables.get(c.id)?.count ?? 0) + 1 });
    } else if (it.kind === "icon") {
      const t = iconById(it.type);
      usedIcons.set(t.id, { ...t, count: (usedIcons.get(t.id)?.count ?? 0) + 1 });
    }
  }
  return { cables: [...usedCables.values()], icons: [...usedIcons.values()] };
}

function drawLegend(g, p, x, y) {
  const { cables, icons } = legendEntries(p);
  const rows = [];
  for (const c of cables) rows.push({ type: "cable", ...c });
  for (const ic of icons) rows.push({ type: "icon", ...ic });
  const showHm = state.showHeatmap && p.items.some((i) => i.kind === "icon" && i.type === "wap");
  const hmRows = showHm ? HEATMAP_LEGEND : [];

  const W = 250;
  const headH = 30;
  const rowH = 26;
  const hmH = hmRows.length ? hmRows.length * 20 + 12 : 0;
  const scaleH = 22;
  const H = headH + Math.max(1, rows.length) * rowH + hmH + scaleH + 14;

  g.save();
  g.translate(x, y);
  g.fillStyle = "rgba(255,255,255,0.96)";
  g.strokeStyle = "#2a2f38";
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(0, 0, W, H, 6);
  g.fill();
  g.stroke();

  g.fillStyle = "#141822";
  g.font = "700 15px Segoe UI, Arial";
  g.fillText("LEGEND", 12, 20);
  g.font = "12px Segoe UI, Arial";
  g.textAlign = "right";
  g.fillText("Wire Wizard", W - 10, 20);
  g.textAlign = "left";
  g.beginPath();
  g.moveTo(0, headH - 4); g.lineTo(W, headH - 4);
  g.lineWidth = 1;
  g.stroke();

  let yy = headH + 8;
  if (!rows.length) {
    g.fillStyle = "#6a7180";
    g.fillText("(no markup yet)", 12, yy + 10);
    yy += rowH;
  }
  for (const r of rows) {
    if (r.type === "cable") {
      g.strokeStyle = r.color;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(12, yy + 8); g.lineTo(52, yy + 8);
      g.stroke();
    } else {
      g.save();
      g.translate(32, yy + 8);
      g.scale(0.55, 0.55);
      drawIcon(g, r.id, { noHalo: true });
      g.restore();
    }
    g.fillStyle = "#141822";
    g.font = "13px Segoe UI, Arial";
    g.fillText(`${r.name}${r.count > 1 ? `  ×${r.count}` : ""}`, 62, yy + 12);
    yy += rowH;
  }
  if (hmRows.length) {
    yy += 4;
    for (const b of hmRows) {
      g.fillStyle = b.color;
      g.fillRect(12, yy, 22, 12);
      g.strokeStyle = "#2a2f38";
      g.lineWidth = 0.8;
      g.strokeRect(12, yy, 22, 12);
      g.fillStyle = "#141822";
      g.font = "11.5px Segoe UI, Arial";
      g.fillText(b.label, 42, yy + 10);
      yy += 20;
    }
    yy += 8;
  }
  g.font = "11.5px Segoe UI, Arial";
  g.fillStyle = "#3a4150";
  g.fillText(
    p.ftPerPx
      ? `Scale: 1 px = ${(p.ftPerPx * 12).toFixed(2)} in (${p.scaleSource ?? "manual"})`
      : "Scale: not calibrated",
    12, yy + 8
  );
  g.restore();
  p._legendSize = { w: W, h: H };
}

/* ───────────────────────── render loop ─────────────────────── */

function render() {
  requestAnimationFrame(render);
  if (!state.dirty) return;
  state.dirty = false;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0d0f13";
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  const p = page();
  document.getElementById("drop-hint").style.display = p ? "none" : "flex";
  if (!p) return;

  ctx.save();
  ctx.translate(state.view.x, state.view.y);
  ctx.scale(state.view.zoom, state.view.zoom);
  ctx.imageSmoothingEnabled = state.view.zoom < 1.6;

  // page shadow + base
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 26 / state.view.zoom;
  ctx.drawImage(p.canvas, 0, 0);
  ctx.restore();

  // heatmap under annotations, over the base
  if (state.showHeatmap) {
    const hm = heatmapCanvas(p);
    if (hm) {
      ctx.globalAlpha = 0.6;
      ctx.drawImage(hm, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  drawAnnotations(ctx, p);

  // in-progress gesture
  if (state.drawing) drawGesture(ctx, state.drawing);

  // selection highlight
  if (state.selection) drawSelection(ctx, state.selection);

  ctx.restore();
}

function drawGesture(g, d) {
  g.save();
  if (d.type === "line") {
    const cable = cableById(state.activeCableId);
    g.strokeStyle = cable.color;
    g.lineWidth = 4;
    g.lineCap = "round";
    g.setLineDash([2, 6]);
    g.beginPath();
    d.points.forEach((pt, i) => (i ? g.lineTo(pt.x, pt.y) : g.moveTo(pt.x, pt.y)));
    if (d.cursor) g.lineTo(d.cursor.x, d.cursor.y);
    g.stroke();
  } else if (d.type === "wall" || d.type === "scale") {
    g.strokeStyle = d.type === "wall" ? "#1f6fe0" : "#f2a900";
    g.lineWidth = d.type === "wall" ? 3.5 : 3;
    g.setLineDash([8, 5]);
    g.beginPath();
    g.moveTo(d.x1, d.y1);
    g.lineTo(d.cursor?.x ?? d.x1, d.cursor?.y ?? d.y1);
    g.stroke();
  }
  g.restore();
}

function drawSelection(g, sel) {
  const it = sel.item;
  g.save();
  g.strokeStyle = "#39c0ff";
  g.lineWidth = 2 / state.view.zoom;
  g.setLineDash([6 / state.view.zoom, 4 / state.view.zoom]);
  const b = itemBounds(it);
  if (b) g.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
  g.restore();
}

function itemBounds(it) {
  if (it.kind === "icon") {
    const r = 26 * (it.scale ?? 1);
    return { x: it.x - r, y: it.y - r, w: r * 2, h: r * 2 };
  }
  if (it.kind === "note") {
    return { x: it.x, y: it.y, w: it._w ?? 120, h: it._h ?? 40 };
  }
  if (it.kind === "line") {
    const xs = it.points.map((p) => p.x), ys = it.points.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
  }
  if (it.kind === "legend") {
    const p = page();
    const s = p._legendSize ?? { w: 250, h: 120 };
    return { x: it.x, y: it.y, w: s.w, h: s.h };
  }
  return null;
}

/* ───────────────────────── hit testing ─────────────────────── */

function hitTest(ix, iy) {
  const p = page();
  if (!p) return null;
  const tol = 8 / state.view.zoom;

  // legend box (topmost)
  if (p.legendPos) {
    const s = p._legendSize ?? { w: 250, h: 120 };
    if (ix >= p.legendPos.x && ix <= p.legendPos.x + s.w && iy >= p.legendPos.y && iy <= p.legendPos.y + s.h) {
      return { item: { kind: "legend", get x() { return p.legendPos.x; }, get y() { return p.legendPos.y; } }, legend: true };
    }
  }
  // notes then icons then lines (front-to-back feel)
  for (let i = p.items.length - 1; i >= 0; i--) {
    const it = p.items[i];
    if (it.kind === "note") {
      const b = itemBounds(it);
      if (ix >= b.x && ix <= b.x + b.w && iy >= b.y && iy <= b.y + b.h) return { item: it };
    }
  }
  for (let i = p.items.length - 1; i >= 0; i--) {
    const it = p.items[i];
    if (it.kind === "icon") {
      const r = 24 * (it.scale ?? 1) + tol;
      if (Math.hypot(ix - it.x, iy - it.y) <= r) return { item: it };
    }
  }
  for (let i = p.items.length - 1; i >= 0; i--) {
    const it = p.items[i];
    if (it.kind === "line") {
      for (let s = 0; s < it.points.length - 1; s++) {
        if (distToSeg(ix, iy, it.points[s], it.points[s + 1]) <= tol + (it.width ?? 4) / 2) {
          return { item: it };
        }
      }
    }
  }
  return null;
}

function distToSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/* ───────────────────────── interactions ────────────────────── */

let spaceHeld = false;
let mouse = { down: false, sx: 0, sy: 0, mode: null, moved: false };

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const factor = Math.exp(-e.deltaY * 0.0012);
  const z = Math.min(12, Math.max(0.05, state.view.zoom * factor));
  const img = toImg(sx, sy);
  state.view.zoom = z;
  state.view.x = sx - img.x * z;
  state.view.y = sy - img.y * z;
  markDirty();
}, { passive: false });

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const img = toImg(sx, sy);
  mouse = { down: true, sx, sy, mode: null, moved: false, startImg: img };
  const p = page();
  if (!p) return;

  const panning = state.tool === "pan" || spaceHeld || e.button === 1;
  if (panning) { mouse.mode = "pan"; return; }
  if (e.button === 2) return;

  if (state.tool === "select") {
    const hit = hitTest(img.x, img.y);
    if (hit?.legend) {
      mouse.mode = "drag-legend";
      mouse.grab = { dx: img.x - p.legendPos.x, dy: img.y - p.legendPos.y };
      state.selection = null;
    } else if (hit) {
      state.selection = hit;
      const it = hit.item;
      mouse.mode = "drag-item";
      if (it.kind === "line") {
        mouse.grab = { points: it.points.map((pt) => ({ ...pt })), ix: img.x, iy: img.y };
      } else {
        mouse.grab = { dx: img.x - it.x, dy: img.y - it.y };
      }
      pushUndo();
      refreshProps();
    } else {
      state.selection = null;
      mouse.mode = "pan"; // empty-space drag pans — feels right
      refreshProps();
    }
    markDirty();
  } else if (state.tool === "line") {
    if (!state.drawing) {
      state.drawing = { type: "line", points: [img], cursor: img };
    } else {
      state.drawing.points.push(img);
    }
    markDirty();
  } else if (state.tool === "wall" || state.tool === "scale") {
    state.drawing = { type: state.tool, x1: img.x, y1: img.y, cursor: img };
    mouse.mode = "drag-new-seg";
    markDirty();
  } else if (state.tool === "note") {
    pushUndo();
    const text = prompt("Note text:", "");
    if (text) {
      p.items.push({ kind: "note", x: img.x, y: img.y, text });
      setStatus("Note added");
    }
    markDirty();
  } else if (state.tool === "icon" && state.activeIconType) {
    pushUndo();
    const it = {
      kind: "icon", type: state.activeIconType,
      x: img.x, y: img.y, rot: 0, scale: state.settings.iconScale ?? 1.4, label: "",
    };
    p.items.push(it);
    state.selection = { item: it };
    if (it.type === "wap") invalidateHeatmap();
    refreshProps();
    markDirty();
  }
});

canvas.addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const img = toImg(sx, sy);
  setStatus(null, fmtCoord(img));

  if (state.drawing) {
    state.drawing.cursor = img;
    markDirty();
  }
  if (!mouse.down) return;
  const dx = sx - mouse.sx, dy = sy - mouse.sy;
  if (Math.abs(dx) + Math.abs(dy) > 2) mouse.moved = true;

  if (mouse.mode === "pan") {
    state.view.x += dx; state.view.y += dy;
    mouse.sx = sx; mouse.sy = sy;
    markDirty();
  } else if (mouse.mode === "drag-item" && state.selection) {
    const it = state.selection.item;
    if (it.kind === "line") {
      const ddx = img.x - mouse.grab.ix, ddy = img.y - mouse.grab.iy;
      it.points = mouse.grab.points.map((pt) => ({ x: pt.x + ddx, y: pt.y + ddy }));
    } else {
      it.x = img.x - mouse.grab.dx;
      it.y = img.y - mouse.grab.dy;
      if (it.kind === "icon" && it.type === "wap") invalidateHeatmap();
    }
    markDirty();
  } else if (mouse.mode === "drag-legend") {
    page().legendPos = { x: img.x - mouse.grab.dx, y: img.y - mouse.grab.dy };
    markDirty();
  }
});

canvas.addEventListener("pointerup", (e) => {
  const r = canvas.getBoundingClientRect();
  const img = toImg(e.clientX - r.left, e.clientY - r.top);
  const p = page();

  if (mouse.mode === "drag-new-seg" && state.drawing && p) {
    const d = state.drawing;
    const len = Math.hypot(img.x - d.x1, img.y - d.y1);
    if (len > 4) {
      if (d.type === "wall") {
        pushUndo();
        p.walls.push({ x1: d.x1, y1: d.y1, x2: img.x, y2: img.y });
        invalidateHeatmap();
        setStatus("Wall added");
      } else if (d.type === "scale") {
        finishScaleCalibration(d.x1, d.y1, img.x, img.y, len);
      }
    }
    state.drawing = null;
    markDirty();
  }
  mouse.down = false;
  mouse.mode = null;
});

canvas.addEventListener("dblclick", (e) => {
  const r = canvas.getBoundingClientRect();
  const img = toImg(e.clientX - r.left, e.clientY - r.top);
  const p = page();
  if (!p) return;

  // finish an in-progress cable run
  if (state.drawing?.type === "line") { finishLine(); return; }

  const hit = hitTest(img.x, img.y);
  if (hit?.item.kind === "note") {
    const t = prompt("Edit note:", hit.item.text);
    if (t !== null) { pushUndo(); hit.item.text = t; markDirty(); }
  } else if (hit?.item.kind === "icon") {
    const t = prompt("Icon label:", hit.item.label ?? "");
    if (t !== null) { pushUndo(); hit.item.label = t; markDirty(); }
  }
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  // right-click finishes a cable run too
  if (state.drawing?.type === "line") finishLine();
  else if (state.drawing) { state.drawing = null; markDirty(); }
});

function finishLine() {
  const d = state.drawing;
  const p = page();
  state.drawing = null;
  if (!d || !p || d.points.length < 2) { markDirty(); return; }
  pushUndo();
  p.items.push({
    kind: "line",
    cableTypeId: state.activeCableId,
    points: d.points,
    width: 4,
  });
  setStatus(`${cableById(state.activeCableId).name} run added`);
  markDirty();
}

function finishScaleCalibration(x1, y1, x2, y2, lenPx) {
  const p = page();
  const input = prompt("Real-world length of the line you just drew (feet):", "10");
  const feet = parseFloat(input);
  if (!isFinite(feet) || feet <= 0) { setStatus("Scale calibration cancelled"); return; }
  pushUndo();
  p.ftPerPx = feet / lenPx;
  p.scaleSource = "calibrated";
  invalidateHeatmap();
  refreshScaleBadge();
  setStatus(`Scale set: ${feet} ft over ${Math.round(lenPx)} px`);
}

/* keyboard */
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space") { spaceHeld = true; return; }
  const it = state.selection?.item;
  const p = page();

  if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === "o") { e.preventDefault(); openFloorplanDialog(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); saveProject(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === "e") { e.preventDefault(); doExport(); return; }

  switch (e.key) {
    case "v": case "V": setTool("select"); break;
    case "h": case "H": setTool("pan"); break;
    case "l": case "L": setTool("line"); break;
    case "w": case "W": setTool("wall"); break;
    case "n": case "N": setTool("note"); break;
    case "s": case "S": setTool("scale"); break;
    case "Enter":
      if (state.drawing?.type === "line") finishLine();
      break;
    case "Escape":
      state.drawing = null; state.selection = null; refreshProps(); markDirty();
      break;
    case "Delete": case "Backspace":
      deleteSelection();
      break;
    case "r": case "R":
      if (it?.kind === "icon") { pushUndo(); it.rot = ((it.rot ?? 0) + (e.shiftKey ? -15 : 15)) % 360; markDirty(); refreshProps(); }
      break;
    case "[":
      if (it?.kind === "icon") { pushUndo(); it.rot = ((it.rot ?? 0) - 15) % 360; markDirty(); refreshProps(); }
      break;
    case "]":
      if (it?.kind === "icon") { pushUndo(); it.rot = ((it.rot ?? 0) + 15) % 360; markDirty(); refreshProps(); }
      break;
    case "+": case "=":
      if (it?.kind === "icon") { pushUndo(); it.scale = Math.min(4, (it.scale ?? 1) * 1.15); markDirty(); }
      break;
    case "-": case "_":
      if (it?.kind === "icon") { pushUndo(); it.scale = Math.max(0.4, (it.scale ?? 1) / 1.15); markDirty(); }
      break;
  }
  void p;
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") spaceHeld = false; });

function deleteSelection() {
  const p = page();
  const it = state.selection?.item;
  if (!p || !it) return;
  pushUndo();
  if (it.kind === "legend" || state.selection.legend) {
    p.legendPos = null;
  } else {
    p.items = p.items.filter((x) => x !== it);
    if (it.kind === "icon" && it.type === "wap") invalidateHeatmap();
  }
  state.selection = null;
  refreshProps();
  markDirty();
}

/* drag & drop files */
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  await openFloorplanBytes(f.name, bytes);
});

/* ────────────────────────── toolbar/UI ─────────────────────── */

function setTool(tool, iconType = null) {
  state.tool = tool;
  state.activeIconType = iconType;
  state.drawing = null;
  document.querySelectorAll(".tool, .icon-tool").forEach((b) => b.classList.remove("active"));
  if (tool === "icon") {
    document.querySelector(`.icon-tool[data-icon="${iconType}"]`)?.classList.add("active");
  } else {
    document.querySelector(`.tool[data-tool="${tool}"]`)?.classList.add("active");
  }
  canvas.style.cursor = tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair";
  markDirty();
}

document.querySelectorAll(".tool").forEach((b) =>
  b.addEventListener("click", () => setTool(b.dataset.tool))
);

// icon palette
const paletteEl = document.getElementById("icon-palette");
for (const t of ICON_TYPES) {
  const btn = document.createElement("button");
  btn.className = "icon-tool";
  btn.dataset.icon = t.id;
  btn.title = `${t.name} — ${t.hint}`;
  const cv = document.createElement("canvas");
  cv.width = 60; cv.height = 60;
  const g = cv.getContext("2d");
  g.translate(30, 30);
  g.scale(1.15, 1.15);
  // draw on dark UI: use light ink, no halo
  drawIcon(g, t.id, { ink: "#dde4ee", noHalo: true });
  // repaint white fills as transparent-ish: simpler — just draw again with light ink only
  btn.appendChild(cv);
  const label = document.createElement("span");
  label.textContent = t.name;
  btn.appendChild(label);
  btn.addEventListener("click", () => setTool("icon", t.id));
  paletteEl.appendChild(btn);
}

/* cable panel */
function refreshCablePanel() {
  const list = document.getElementById("cable-list");
  list.innerHTML = "";
  for (const c of state.cableTypes) {
    const row = document.createElement("div");
    row.className = "cable-row" + (c.id === state.activeCableId ? " active" : "");
    const color = document.createElement("input");
    color.type = "color";
    color.value = c.color;
    color.addEventListener("input", () => { c.color = color.value; invalidateHeatmap(); markDirty(); });
    const name = document.createElement("input");
    name.type = "text";
    name.value = c.name;
    name.addEventListener("change", () => { c.name = name.value; markDirty(); });
    name.addEventListener("focus", () => selectCable(c.id));
    row.appendChild(color);
    row.appendChild(name);
    row.addEventListener("click", () => selectCable(c.id));
    list.appendChild(row);
  }
}
function selectCable(id) {
  state.activeCableId = id;
  refreshCablePanel();
  if (state.tool !== "line") setTool("line");
}
document.getElementById("btn-add-cable").addEventListener("click", () => {
  const id = "c" + Math.random().toString(36).slice(2, 8);
  state.cableTypes.push({ id, name: "New cable", color: "#00b3b3" });
  state.activeCableId = id;
  refreshCablePanel();
});

/* properties panel */
function refreshProps() {
  const empty = document.getElementById("props-empty");
  const props = document.getElementById("props");
  const body = document.getElementById("props-body");
  const it = state.selection?.item;
  if (!it || state.selection.legend) {
    empty.hidden = false; props.hidden = true; return;
  }
  empty.hidden = true; props.hidden = false;
  body.innerHTML = "";
  if (it.kind === "icon") {
    const t = iconById(it.type);
    body.insertAdjacentHTML("beforeend", `<label>Type<br><b style="color:var(--text)">${t.name}</b></label>`);
    addField(body, "Label", it.label ?? "", (v) => { it.label = v; markDirty(); });
    addField(body, "Rotation (°)", String(Math.round(it.rot ?? 0)), (v) => {
      it.rot = parseFloat(v) || 0; markDirty();
    }, "number");
  } else if (it.kind === "line") {
    const sel = document.createElement("select");
    for (const c of state.cableTypes) {
      const o = document.createElement("option");
      o.value = c.id; o.textContent = c.name;
      if (c.id === it.cableTypeId) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => { it.cableTypeId = sel.value; markDirty(); });
    const lab = document.createElement("label");
    lab.textContent = "Cable type";
    lab.appendChild(sel);
    body.appendChild(lab);
    addField(body, "Line width", String(it.width ?? 4), (v) => {
      it.width = Math.max(1, parseFloat(v) || 4); markDirty();
    }, "number");
    const p = page();
    if (p?.ftPerPx) {
      let len = 0;
      for (let i = 0; i < it.points.length - 1; i++) {
        len += Math.hypot(it.points[i + 1].x - it.points[i].x, it.points[i + 1].y - it.points[i].y);
      }
      body.insertAdjacentHTML("beforeend",
        `<label>Run length<br><b style="color:var(--text)">≈ ${(len * p.ftPerPx).toFixed(1)} ft</b></label>`);
    }
  } else if (it.kind === "note") {
    const ta = document.createElement("textarea");
    ta.value = it.text;
    ta.addEventListener("input", () => { it.text = ta.value; markDirty(); });
    const lab = document.createElement("label");
    lab.textContent = "Note";
    lab.appendChild(ta);
    body.appendChild(lab);
  }
}
function addField(parent, label, value, onChange, type = "text") {
  const lab = document.createElement("label");
  lab.textContent = label;
  const inp = document.createElement("input");
  inp.type = type;
  inp.value = value;
  inp.addEventListener("input", () => onChange(inp.value));
  lab.appendChild(inp);
  parent.appendChild(lab);
}
document.getElementById("btn-rot-l").addEventListener("click", () => {
  const it = state.selection?.item;
  if (it?.kind === "icon") { pushUndo(); it.rot = (it.rot ?? 0) - 15; markDirty(); refreshProps(); }
});
document.getElementById("btn-rot-r").addEventListener("click", () => {
  const it = state.selection?.item;
  if (it?.kind === "icon") { pushUndo(); it.rot = (it.rot ?? 0) + 15; markDirty(); refreshProps(); }
});
document.getElementById("btn-del").addEventListener("click", deleteSelection);

/* status + badges */
function setStatus(left, right) {
  if (left !== null && left !== undefined) document.getElementById("status-left").textContent = left;
  if (right !== undefined) document.getElementById("status-right").textContent = right ?? "";
}
function fmtCoord(img) {
  const p = page();
  if (!p) return "";
  if (p.ftPerPx) return `${(img.x * p.ftPerPx).toFixed(1)} ft, ${(img.y * p.ftPerPx).toFixed(1)} ft`;
  return `${Math.round(img.x)}, ${Math.round(img.y)} px`;
}
function refreshScaleBadge() {
  const b = document.getElementById("scale-badge");
  const p = page();
  if (p?.ftPerPx) {
    b.textContent = `scale: 1px = ${(p.ftPerPx * 12).toFixed(2)}" (${p.scaleSource})`;
    b.classList.remove("warn");
  } else {
    b.textContent = "scale: not set";
    b.classList.add("warn");
  }
}

function toast(msg, ms = 4200) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), ms);
}

/* ─────────────────────── open/save/export ──────────────────── */

async function openFloorplanBytes(name, bytes) {
  if (/\.wirewiz$/i.test(name)) {
    try { await openProjectBytes(bytes); }
    catch (err) { console.error(err); toast(`Could not open ${name}: ${err?.message ?? "invalid project file"}`); }
    return;
  }
  setStatus("Loading floorplan…");
  try {
    const pages = await loadFloorplan(name, bytes);
    state.pages = pages.map((pg) => newPage(pg.canvas, pg.label));
    state.pageIndex = 0;
    state.sourceName = name.replace(/\.[^.]+$/, "");
    state.undoStack.length = 0;
    state.redoStack.length = 0;
    state.selection = null;
    invalidateHeatmap();
    fitView();
    refreshPageNav();
    refreshScaleBadge();
    setStatus(`Loaded ${name} (${pages.length} page${pages.length > 1 ? "s" : ""})`);
  } catch (err) {
    console.error(err);
    toast(`Could not open ${name}: ${err.message}`);
    setStatus("Ready");
  }
}

async function openFloorplanDialog() {
  if (bridge) {
    const r = await bridge.openFloorplan();
    if (r) await openFloorplanBytes(r.name, base64ToBytes(r.data));
  } else {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".pdf,.png,.jpg,.jpeg,.webp,.bmp,.wirewiz";
    inp.addEventListener("change", async () => {
      const f = inp.files?.[0];
      if (f) await openFloorplanBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    });
    inp.click();
  }
}

function serializeProject() {
  return JSON.stringify({
    app: "wirewizard", version: 1,
    sourceName: state.sourceName,
    cableTypes: state.cableTypes,
    pageIndex: state.pageIndex,
    pages: state.pages.map((p) => ({
      label: p.label,
      png: p.canvas.toDataURL("image/png"),
      ftPerPx: p.ftPerPx, scaleSource: p.scaleSource,
      walls: p.walls, aiWalls: p.aiWalls, items: p.items, legendPos: p.legendPos,
    })),
  });
}

async function openProjectBytes(bytes) {
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (data?.app !== "wirewizard") throw new Error("Not a Wire Wizard project");
  // Validate before use: a project file is untrusted input.
  if (!Array.isArray(data.pages) || data.pages.length === 0) throw new Error("Invalid project");
  const asArray = (x) => (Array.isArray(x) ? x : []);
  const pages = [];
  for (const pd of data.pages) {
    // serializeProject always writes canvas.toDataURL("image/png"); refuse any other URL.
    if (!pd || typeof pd.png !== "string" || !pd.png.startsWith("data:image/png;base64,")) {
      throw new Error("Invalid project");
    }
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = pd.png; });
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").drawImage(img, 0, 0);
    const p = newPage(cv, pd.label);
    Object.assign(p, {
      ftPerPx: Number.isFinite(pd.ftPerPx) && pd.ftPerPx > 0 ? pd.ftPerPx : null,
      scaleSource: pd.scaleSource,
      walls: asArray(pd.walls), aiWalls: asArray(pd.aiWalls),
      items: asArray(pd.items), legendPos: pd.legendPos ?? null,
    });
    pages.push(p);
  }
  state.pages = pages;
  const cableTypes = asArray(data.cableTypes).filter((c) =>
    c && typeof c.id === "string" && typeof c.name === "string" &&
    typeof c.color === "string" && /^#[0-9a-fA-F]{6}$/.test(c.color));
  if (cableTypes.length) state.cableTypes = cableTypes;
  state.pageIndex = Math.min(Number.isInteger(data.pageIndex) && data.pageIndex > 0 ? data.pageIndex : 0, pages.length - 1);
  state.sourceName = data.sourceName ?? "project";
  state.selection = null;
  invalidateHeatmap();
  refreshCablePanel();
  fitView();
  refreshPageNav();
  refreshScaleBadge();
  setStatus("Project loaded");
}

async function saveProject() {
  if (!state.pages.length) { toast("Nothing to save yet — open a floorplan first."); return; }
  const json = serializeProject();
  const b64 = bytesToBase64(new TextEncoder().encode(json));
  const name = `${state.sourceName}.wirewiz`;
  if (bridge) {
    const path = await bridge.saveFile({ defaultName: name, base64: b64, filterName: "Wire Wizard project", ext: "wirewiz" });
    if (path) setStatus(`Saved ${path}`);
  } else {
    downloadBlob(new Blob([json], { type: "application/json" }), name);
    setStatus("Project downloaded");
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Composite one page at export scale: base + heatmap + annotations + legend. */
function renderPageForExport(i) {
  const p = state.pages[i];
  const c = document.createElement("canvas");
  c.width = p.canvas.width;
  c.height = p.canvas.height;
  const g = c.getContext("2d");
  g.drawImage(p.canvas, 0, 0);
  if (state.showHeatmap) {
    const savedIdx = state.pageIndex;
    state.pageIndex = i;                 // heatmapCanvas reads current page's items
    const hm = heatmapCanvas(p);
    state.pageIndex = savedIdx;
    if (hm) { g.globalAlpha = 0.6; g.drawImage(hm, 0, 0); g.globalAlpha = 1; }
  }
  // ensure a legend lands on the export even if not placed: bottom-right
  const hadLegend = !!p.legendPos;
  if (!hadLegend) {
    p.legendPos = { x: p.canvas.width - 280, y: p.canvas.height - 340 };
  }
  drawAnnotations(g, p, { forExport: true });
  if (!hadLegend) p.legendPos = null;
  return c;
}

async function doExport() {
  if (!state.pages.length) { toast("Open a floorplan first."); return; }
  setStatus("Exporting PDF…");
  try {
    const { jsPDF } = window.jspdf;
    const buf = await exportPdf(state.pages.length, (i) => renderPageForExport(i), jsPDF);
    const name = `${state.sourceName}-markup.pdf`;
    if (bridge) {
      const path = await bridge.saveFile({
        defaultName: name, base64: bytesToBase64(buf), filterName: "PDF", ext: "pdf",
      });
      setStatus(path ? `Exported ${path}` : "Export cancelled");
    } else {
      downloadBlob(new Blob([buf], { type: "application/pdf" }), name);
      setStatus("PDF downloaded");
    }
  } catch (err) {
    console.error(err);
    toast("Export failed: " + err.message);
    setStatus("Ready");
  }
}

/* page nav */
function refreshPageNav() {
  const nav = document.getElementById("page-nav");
  nav.hidden = state.pages.length < 2;
  document.getElementById("page-label").textContent = `Page ${state.pageIndex + 1}/${state.pages.length}`;
}
document.getElementById("btn-prev-page").addEventListener("click", () => switchPage(-1));
document.getElementById("btn-next-page").addEventListener("click", () => switchPage(1));
function switchPage(delta) {
  const n = state.pages.length;
  if (!n) return;
  state.pageIndex = (state.pageIndex + delta + n) % n;
  state.selection = null;
  invalidateHeatmap();
  fitView();
  refreshPageNav();
  refreshScaleBadge();
  refreshProps();
}

/* top bar wiring */
document.getElementById("btn-open").addEventListener("click", openFloorplanDialog);
document.getElementById("btn-save").addEventListener("click", saveProject);
document.getElementById("btn-export").addEventListener("click", doExport);
document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-redo").addEventListener("click", redo);

document.getElementById("btn-demo").addEventListener("click", () => loadDemo());

function loadDemo() {
  const demo = makeDemoFloorplan();
  state.pages = [newPage(demo.canvas, "Demo")];
  state.pageIndex = 0;
  state.sourceName = "demo-plan";
  const p = page();
  p.aiWalls = demo.walls;
  p.ftPerPx = demo.ftPerPx;
  p.scaleSource = "demo";
  state.undoStack.length = 0;
  state.redoStack.length = 0;
  invalidateHeatmap();
  fitView();
  refreshPageNav();
  refreshScaleBadge();
  setStatus("Demo plan loaded — try dropping a WAP and toggling the heatmap");
}

document.getElementById("btn-heatmap").addEventListener("click", (e) => {
  state.showHeatmap = !state.showHeatmap;
  e.currentTarget.classList.toggle("on", state.showHeatmap);
  const p = page();
  if (state.showHeatmap && p && !p.items.some((i) => i.kind === "icon" && i.type === "wap")) {
    toast("Heatmap is on — drop one or more WAP icons to see coverage.");
  }
  if (state.showHeatmap && p && !p.ftPerPx) {
    toast("No scale set — heatmap assumes a ~50 ft wide plan. Run ✨ AI Analyze or use the 📏 Scale tool.");
  }
  markDirty();
});

document.getElementById("btn-walls").addEventListener("click", (e) => {
  state.showWalls = !state.showWalls;
  e.currentTarget.classList.toggle("on", state.showWalls);
  markDirty();
});

document.getElementById("btn-legend").addEventListener("click", () => {
  const p = page();
  if (!p) return;
  pushUndo();
  if (p.legendPos) {
    p.legendPos = null;
    setStatus("Legend removed");
  } else {
    // place at the visible top-left quarter
    const r = canvas.getBoundingClientRect();
    const img = toImg(r.width * 0.05, r.height * 0.08);
    p.legendPos = { x: img.x, y: img.y };
    setStatus("Legend placed — drag it where you want it");
  }
  markDirty();
});

/* AI analyze */
document.getElementById("btn-ai").addEventListener("click", () => runAI());
async function runAI() {
  const p = page();
  if (!p) { toast("Open a floorplan first."); return; }
  const btn = document.getElementById("btn-ai");
  btn.disabled = true;
  btn.textContent = "✨ Analyzing…";
  setStatus("Claude is reading the floorplan…");
  try {
    const res = await analyzeFloorplan(p.canvas, { apiKey: state.settings.anthropicApiKey });
    pushUndo();
    p.aiWalls = res.walls;
    if (res.ftPerPx && (res.scaleConfidence !== "none" || !p.ftPerPx)) {
      p.ftPerPx = res.ftPerPx;
      p.scaleSource = `AI (${res.scaleConfidence})`;
    }
    invalidateHeatmap();
    refreshScaleBadge();
    document.getElementById("ai-notes").innerHTML =
      `<b>${res.walls.length}</b> wall segments traced.<br>` +
      `Scale: <b>${res.ftPerPx ? (res.ftPerPx * 12).toFixed(2) + '"/px' : "unknown"}</b> ` +
      `(${escapeHtml(res.scaleConfidence)} — ${escapeHtml(res.scaleBasis)})<br>` +
      `<span class="dim">${escapeHtml(res.notes)}</span>`;
    setStatus(`AI: ${res.walls.length} walls, scale ${res.scaleConfidence}`);
    markDirty();
  } catch (err) {
    console.error(err);
    toast("AI analysis failed: " + err.message, 6000);
    setStatus("Ready");
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ AI Analyze";
  }
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* settings modal */
const backdrop = document.getElementById("modal-backdrop");
document.getElementById("btn-settings").addEventListener("click", () => {
  document.getElementById("set-apikey").value = state.settings.anthropicApiKey ?? "";
  document.getElementById("set-wallloss").value = state.settings.wallLossDb;
  document.getElementById("set-ple").value = state.settings.pathLossExp;
  document.getElementById("set-tx").value = state.settings.txAt1m;
  document.getElementById("set-iconscale").value = state.settings.iconScale;
  backdrop.hidden = false;
});
document.getElementById("btn-settings-cancel").addEventListener("click", () => (backdrop.hidden = true));
document.getElementById("btn-settings-save").addEventListener("click", async () => {
  state.settings.anthropicApiKey = document.getElementById("set-apikey").value.trim();
  state.settings.wallLossDb = parseFloat(document.getElementById("set-wallloss").value) || 4.5;
  state.settings.pathLossExp = parseFloat(document.getElementById("set-ple").value) || 2.2;
  state.settings.txAt1m = parseFloat(document.getElementById("set-tx").value) || -40;
  state.settings.iconScale = parseFloat(document.getElementById("set-iconscale").value) || 1.4;
  await persistSettings();
  invalidateHeatmap();
  backdrop.hidden = true;
  setStatus("Settings saved");
});
document.getElementById("link-console").addEventListener("click", (e) => {
  e.preventDefault();
  const url = "https://platform.claude.com/";
  if (bridge) bridge.openExternal(url);
  else window.open(url, "_blank");
});

/* ───────────────────────── self-test ───────────────────────── */
// Drives the full pipeline without a human or an API key. Used by the
// Playwright smoke test and `electron . --selftest`.
window.__ww_selftest = async function () {
  loadDemo();
  const p = page();
  // place devices
  p.items.push(
    { kind: "icon", type: "wap", x: 800, y: 380, rot: 0, scale: 1.5, label: "WAP-1" },
    { kind: "icon", type: "wap", x: 330, y: 780, rot: 0, scale: 1.5, label: "WAP-2" },
    { kind: "icon", type: "drop", x: 250, y: 300, rot: 0, scale: 1.5, label: "D1" },
    { kind: "icon", type: "tv", x: 1300, y: 250, rot: 0, scale: 1.5, label: "TV-1" },
    { kind: "icon", type: "camera", x: 140, y: 160, rot: 35, scale: 1.5, label: "" },
    { kind: "icon", type: "speaker", x: 700, y: 200, rot: 0, scale: 1.3, label: "" },
    { kind: "icon", type: "rack", x: 1400, y: 900, rot: 0, scale: 1.6, label: "HE" },
    { kind: "icon", type: "switch", x: 1300, y: 900, rot: 0, scale: 1.3, label: "" },
    { kind: "icon", type: "router", x: 1210, y: 900, rot: 0, scale: 1.3, label: "" },
    { kind: "line", cableTypeId: "cat6", width: 4, points: [{ x: 1400, y: 880 }, { x: 1150, y: 700 }, { x: 830, y: 420 }, { x: 800, y: 385 }] },
    { kind: "line", cableTypeId: "coax", width: 4, points: [{ x: 1400, y: 880 }, { x: 1350, y: 400 }, { x: 1302, y: 262 }] },
    { kind: "line", cableTypeId: "spk", width: 4, points: [{ x: 1400, y: 880 }, { x: 900, y: 860 }, { x: 705, y: 215 }] },
    { kind: "note", x: 1150, y: 120, text: "Head end in garage.\nHome-run all drops." },
  );
  p.legendPos = { x: 120, y: 140 };
  state.showHeatmap = true;
  document.getElementById("btn-heatmap").classList.add("on");
  invalidateHeatmap();
  markDirty();
  // force a couple frames so render() commits
  await new Promise((r) => setTimeout(r, 120));
  const hm = heatmapCanvas(p);
  if (!hm) throw new Error("heatmap failed");
  // exercise export pipeline (returns bytes; discard in Electron, download suppressed)
  const { jsPDF } = window.jspdf;
  const buf = await exportPdf(state.pages.length, (i) => renderPageForExport(i), jsPDF);
  if (!buf || buf.byteLength < 20000) throw new Error("export too small: " + buf?.byteLength);
  window.__ww_export_bytes = buf.byteLength;
  window.__ww_export_buf = buf;
  await new Promise((r) => setTimeout(r, 60));
  return { ok: true, exportBytes: buf.byteLength, walls: allWalls(p).length, items: p.items.length };
};

// PDF ingestion round-trip: feed the just-exported PDF back through the
// loader, proving the pdf.js path (worker + render) works end to end.
window.__ww_pdf_roundtrip = async function () {
  if (!window.__ww_export_buf) throw new Error("run __ww_selftest first");
  await openFloorplanBytes("roundtrip.pdf", new Uint8Array(window.__ww_export_buf));
  const p = page();
  return { pages: state.pages.length, w: p.canvas.width, h: p.canvas.height };
};

/* ───────────────────────── boot ────────────────────────────── */

(async function boot() {
  await loadSettings();
  refreshCablePanel();
  refreshProps();
  resizeCanvas();
  render();
  setStatus("Ready — open a floorplan or hit Demo");
})();
