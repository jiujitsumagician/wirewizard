// WiFi coverage heatmap. Free-space path loss + per-wall attenuation, computed
// per grid cell in IMAGE space so it survives zoom/pan, rendered to an
// offscreen canvas that the main draw loop composites at ~40% alpha.
//
// Model (typical 5 GHz consumer AP):
//   RSSI(d)   = txAt1m − 10·n·log10(max(d_m, 0.5))  − walls·wallLoss
//   txAt1m    ≈ −40 dBm, n ≈ 2.2 indoors open air, wallLoss ≈ 4.5 dB/wall
// Wall crossings are counted with segment intersection against detected +
// hand-drawn walls, capped so a stack of parallel lines can't drive the
// number to nonsense.

const BANDS = [
  { min: -55, color: [46, 204, 113] },   // excellent
  { min: -65, color: [163, 214, 78] },   // good
  { min: -72, color: [244, 208, 63] },   // fair — streaming ok
  { min: -80, color: [235, 149, 50] },   // weak
  { min: -999, color: [231, 76, 60] },   // poor / dead
];

function colorFor(rssi) {
  for (const b of BANDS) if (rssi >= b.min) return b.color;
  return BANDS[BANDS.length - 1].color;
}

function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Compute the heatmap for one page.
 * @param waps        [{x, y}] in image px
 * @param walls       [{x1, y1, x2, y2}] in image px
 * @param imgW, imgH  page pixel size
 * @param ftPerPx     drawing scale (feet per image pixel)
 * @param opts        {txAt1m, pathLossExp, wallLossDb}
 * @returns HTMLCanvasElement sized imgW x imgH, or null with no WAPs
 */
export function computeHeatmap(waps, walls, imgW, imgH, ftPerPx, opts = {}) {
  if (!waps.length) return null;
  const txAt1m = opts.txAt1m ?? -40;
  const n = opts.pathLossExp ?? 2.2;
  const wallLoss = opts.wallLossDb ?? 4.5;
  const mPerPx = ftPerPx * 0.3048;

  // Grid resolution: cap total cells so a huge scan stays interactive.
  const target = 160;
  const cell = Math.max(4, Math.ceil(Math.max(imgW, imgH) / target));
  const gw = Math.ceil(imgW / cell);
  const gh = Math.ceil(imgH / cell);

  const canvas = document.createElement("canvas");
  canvas.width = imgW;
  canvas.height = imgH;
  const ctx = canvas.getContext("2d");

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const px = gx * cell + cell / 2;
      const py = gy * cell + cell / 2;
      let best = -999;
      for (const w of waps) {
        const dPx = Math.hypot(px - w.x, py - w.y);
        const dM = Math.max(dPx * mPerPx, 0.5);
        let crossings = 0;
        for (const wall of walls) {
          if (segIntersect(px, py, w.x, w.y, wall.x1, wall.y1, wall.x2, wall.y2)) {
            if (++crossings >= 8) break; // cap: beyond this it's dead anyway
          }
        }
        const rssi = txAt1m - 10 * n * Math.log10(dM) - crossings * wallLoss;
        if (rssi > best) best = rssi;
      }
      const [r, g, b] = colorFor(best);
      // fade alpha out entirely once truly dead, so exterior stays clean
      const alpha = best < -88 ? 0 : best < -80 ? 0.5 : 0.62;
      if (alpha > 0) {
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillRect(gx * cell, gy * cell, cell, cell);
      }
    }
  }
  return canvas;
}

/** Legend entries for the heatmap bands (used in on-plan legend + export). */
export const HEATMAP_LEGEND = [
  { label: "Excellent (≥ -55 dBm)", color: "rgb(46,204,113)" },
  { label: "Good (-55 to -65)", color: "rgb(163,214,78)" },
  { label: "Fair (-65 to -72)", color: "rgb(244,208,63)" },
  { label: "Weak (-72 to -80)", color: "rgb(235,149,50)" },
  { label: "Poor (< -80)", color: "rgb(231,76,60)" },
];
