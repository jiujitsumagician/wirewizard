// Synthetic demo floorplan — powers the "Try the demo plan" button and the
// automated self-test. Drawn to look like a scanned architectural sheet, with
// a scale note the AI can find. Returns {canvas, walls} — the wall list lets
// the self-test exercise the heatmap without a live API call.

export function makeDemoFloorplan(W = 1600, H = 1100) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#f7f5f0";
  ctx.fillRect(0, 0, W, H);

  // faint grid, like graph vellum
  ctx.strokeStyle = "rgba(120,140,170,0.12)";
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const walls = [];
  const wall = (x1, y1, x2, y2) => {
    walls.push({ x1, y1, x2, y2 });
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };

  ctx.strokeStyle = "#2a2f38";
  ctx.lineWidth = 7;
  // exterior shell (60ft x 38ft house → 1400px wide → ~0.0429 ft/px)
  wall(100, 120, 1500, 120);
  wall(1500, 120, 1500, 980);
  wall(1500, 980, 100, 980);
  wall(100, 980, 100, 120);

  ctx.lineWidth = 4;
  // interior partitions (leave door gaps)
  wall(560, 120, 560, 480);   wall(560, 560, 560, 980);
  wall(100, 560, 300, 560);   wall(380, 560, 560, 560);
  wall(560, 640, 900, 640);   wall(980, 640, 1120, 640);
  wall(1120, 120, 1120, 400); wall(1120, 480, 1120, 640);
  wall(1120, 640, 1120, 800); wall(1120, 880, 1120, 980);

  // room labels + a dimension string + scale note
  ctx.fillStyle = "#3a4150";
  ctx.font = "26px Georgia";
  ctx.fillText("GREAT ROOM", 720, 380);
  ctx.fillText("OFFICE", 250, 340);
  ctx.fillText("BEDROOM 1", 220, 760);
  ctx.fillText("KITCHEN", 760, 820);
  ctx.fillText("GARAGE", 1240, 560);
  ctx.font = "20px Georgia";
  ctx.fillText("22'-0\"", 780, 150);
  ctx.font = "22px Georgia";
  ctx.fillText("SCALE: 1\" = 10'-0\"    (plan width 60 ft)", 100, 1060);

  // door arcs for realism
  ctx.strokeStyle = "#5a6272";
  ctx.lineWidth = 2;
  for (const [x, y] of [[560, 520], [340, 560], [940, 640], [1120, 440]]) {
    ctx.beginPath(); ctx.arc(x, y, 42, 0, Math.PI / 2); ctx.stroke();
  }

  return { canvas: c, walls, ftPerPx: 60 / 1400 };
}
