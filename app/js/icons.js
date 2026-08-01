// Device icon library. Every icon draws centered on (0,0) inside a nominal
// 40x40 box at scale 1 — the canvas layer handles position/rotation/scale, so
// these stay pure geometry. Same paths render on-plan, in the palette, in the
// legend, and in the PDF export, so the drawing always matches its key.

export const ICON_TYPES = [
  { id: "drop",    name: "Network Drop",  hint: "Data outlet — two-tone triangle" },
  { id: "wap",     name: "WAP",           hint: "Wireless access point (drives heatmap)" },
  { id: "tv",      name: "TV",            hint: "Television / display" },
  { id: "speaker", name: "Speaker",       hint: "Audio speaker" },
  { id: "camera",  name: "Camera",        hint: "Surveillance camera" },
  { id: "rack",    name: "Rack",          hint: "Head-end equipment rack" },
  { id: "switch",  name: "Switch",        hint: "Network switch" },
  { id: "router",  name: "Router",        hint: "Router / gateway" },
];

export function iconById(id) {
  return ICON_TYPES.find((t) => t.id === id) ?? ICON_TYPES[0];
}

/**
 * Draw icon `type` centered at origin. `opts.ink` is the outline color
 * (default near-black, white halo behind it so icons read on busy plans).
 */
export function drawIcon(ctx, type, opts = {}) {
  const ink = opts.ink ?? "#141822";
  const halo = opts.halo ?? "rgba(255,255,255,0.88)";
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // white halo pass makes icons legible over dense linework
  if (!opts.noHalo) {
    ctx.save();
    ctx.strokeStyle = halo;
    ctx.lineWidth = 7;
    tracePath(ctx, type, true);
    ctx.restore();
  }
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 2.4;
  tracePath(ctx, type, false);
  ctx.restore();
}

function tracePath(ctx, type, haloPass) {
  switch (type) {
    case "drop": {
      // Industry-standard data-outlet symbol: equilateral triangle, one half
      // solid, split down the vertical centerline. Point-up.
      const s = 17;
      const h = s * Math.sqrt(3) / 2;
      const top = { x: 0, y: -h * 0.62 };
      const bl = { x: -s / 2, y: h * 0.38 };
      const br = { x: s / 2, y: h * 0.38 };
      const bm = { x: 0, y: h * 0.38 };
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.lineTo(br.x, br.y);
      ctx.closePath();
      if (haloPass) { ctx.stroke(); return; }
      // white left half first (so the fill boundary is crisp), then solid right
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bm.x, bm.y);
      ctx.lineTo(br.x, br.y);
      ctx.closePath();
      ctx.fill();
      // outline + centerline
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.lineTo(br.x, br.y);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bm.x, bm.y);
      ctx.stroke();
      break;
    }
    case "wap": {
      // dot with radiating arcs (AP with coverage), circle enclosure
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      if (haloPass) { ctx.stroke(); return; }
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.restore();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 4, 2.6, 0, Math.PI * 2);
      ctx.fill();
      for (const r of [6.5, 11]) {
        ctx.beginPath();
        ctx.arc(0, 4, r, Math.PI * 1.18, Math.PI * 1.82);
        ctx.stroke();
      }
      break;
    }
    case "tv": {
      ctx.beginPath();
      ctx.rect(-17, -12, 34, 22);
      if (haloPass) { ctx.stroke(); return; }
      ctx.save(); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.restore();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-8, 13); ctx.lineTo(8, 13);
      ctx.stroke();
      ctx.font = "700 11px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("TV", 0, -0.5);
      break;
    }
    case "speaker": {
      // square with cone — standard audio symbol
      ctx.beginPath();
      ctx.rect(-14, -14, 28, 28);
      if (haloPass) { ctx.stroke(); return; }
      ctx.save(); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.restore();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-7, -5); ctx.lineTo(-1, -5); ctx.lineTo(6, -11);
      ctx.lineTo(6, 11); ctx.lineTo(-1, 5); ctx.lineTo(-7, 5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "camera": {
      // CCTV body + lens cone, mount stub — rotation aims the view direction
      ctx.beginPath();
      ctx.roundRect(-16, -8, 22, 15, 3);
      if (haloPass) {
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(6, -6); ctx.lineTo(17, -10); ctx.lineTo(17, 12); ctx.lineTo(6, 8);
        ctx.closePath();
        ctx.stroke();
        return;
      }
      ctx.save(); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.restore();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(6, -6); ctx.lineTo(17, -10); ctx.lineTo(17, 12); ctx.lineTo(6, 8);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(-9, -0.5, 3.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "rack": {
      // tall cabinet with unit slots
      ctx.beginPath();
      ctx.rect(-11, -17, 22, 34);
      if (haloPass) { ctx.stroke(); return; }
      ctx.save(); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.restore();
      ctx.stroke();
      for (let i = 0; i < 4; i++) {
        const y = -12 + i * 8;
        ctx.beginPath();
        ctx.rect(-8, y, 16, 5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(-5.5, y + 2.5, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "switch": {
      // flat box with opposing arrows (frame-forwarding symbol)
      ctx.beginPath();
      ctx.roundRect(-17, -9, 34, 18, 2.5);
      if (haloPass) { ctx.stroke(); return; }
      ctx.save(); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.restore();
      ctx.stroke();
      arrow(ctx, -11, -3.5, 11, -3.5);
      arrow(ctx, 11, 3.5, -11, 3.5);
      break;
    }
    case "router": {
      // circle with crossed arrows (routing symbol)
      ctx.beginPath();
      ctx.arc(0, 0, 15, 0, Math.PI * 2);
      if (haloPass) { ctx.stroke(); return; }
      ctx.save(); ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.restore();
      ctx.stroke();
      arrow(ctx, -9, -4, 9, -4);
      arrow(ctx, 9, 4, -9, 4);
      arrow(ctx, -4, 9, -4, -9);
      arrow(ctx, 4, -9, 4, 9);
      break;
    }
  }
}

function arrow(ctx, x1, y1, x2, y2) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 4.5 * Math.cos(a - 0.45), y2 - 4.5 * Math.sin(a - 0.45));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 4.5 * Math.cos(a + 0.45), y2 - 4.5 * Math.sin(a + 0.45));
  ctx.stroke();
}

/** Default cable-type palette. Users can rename/recolor/add in the side panel. */
export const DEFAULT_CABLE_TYPES = [
  { id: "cat6",    name: "Cat6",           color: "#1f6fe0" },
  { id: "cat6a",   name: "Cat6A",          color: "#7b3fd4" },
  { id: "fiber",   name: "Fiber",          color: "#f2a900" },
  { id: "coax",    name: "Coax RG6",       color: "#111111" },
  { id: "spk",     name: "Speaker 16/2",   color: "#1d9e4f" },
  { id: "sec",     name: "Security 18/2",  color: "#d43f3f" },
  { id: "ctl",     name: "Control 22/4",   color: "#8a5a2b" },
];
