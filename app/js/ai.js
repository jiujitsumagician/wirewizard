// Claude floorplan analysis: determine drawing scale and wall segments.
// In Electron the call runs in the main process (IPC → @anthropic-ai/sdk);
// in browser mode it falls back to a direct fetch with the
// anthropic-dangerous-direct-browser-access header. Both paths use strict
// JSON-schema output, so the reply parses without cleanup.

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scale", "walls", "notes"],
  properties: {
    scale: {
      type: "object",
      additionalProperties: false,
      required: ["feet_per_unit", "confidence", "basis"],
      properties: {
        // feet per 1/1000 of the image WIDTH (normalized so downscaling
        // doesn't matter). null-able via confidence: "none".
        feet_per_unit: { type: "number" },
        confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
        basis: { type: "string" },
      },
    },
    walls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["x1", "y1", "x2", "y2"],
        properties: {
          x1: { type: "number" }, y1: { type: "number" },
          x2: { type: "number" }, y2: { type: "number" },
        },
      },
    },
    notes: { type: "string" },
  },
};

const PROMPT = `You are analyzing a building floorplan image for a low-voltage cabling contractor.

Coordinates: use a normalized system where x runs 0-1000 across the image WIDTH and y runs 0-1000 down the image HEIGHT (y in width-units too — i.e., divide pixel coords by imageWidth and multiply by 1000, for BOTH axes, so distances are isotropic).

Tasks:
1. SCALE — determine the real-world scale. Look for: a printed scale bar, a scale note ("1/4in = 1ft", "1:100"), dimension strings on the drawing (e.g. a room labeled 12'-6" wide), or door openings (standard interior door ≈ 3 ft). Report feet_per_unit = how many FEET one normalized unit (1/1000 of image width) represents. Set confidence accordingly; "none" if you truly cannot estimate (still put your best guess number, e.g. from assuming a typical residence is 40-80 ft wide).
2. WALLS — trace the significant walls (exterior and interior partitions) as straight segments in the same normalized coordinates. Aim for the main architecture: 20-120 segments. Follow the actual drawn walls; merge collinear runs; skip furniture, fixtures, dimension lines, and text.
3. NOTES — one or two sentences on what you found (scale basis, anything ambiguous).

Be precise with wall endpoints — these segments will be used to attenuate a WiFi propagation model.`;

/** Downscale the page bitmap for upload. Returns {pngBase64, scaleFactor}. */
function downscaleForUpload(sourceCanvas, maxDim = 1400) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const f = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * f));
  c.height = Math.max(1, Math.round(h * f));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(sourceCanvas, 0, 0, c.width, c.height);
  const pngBase64 = c.toDataURL("image/png").split(",")[1];
  return { pngBase64 };
}

async function callDirect(pngBase64, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 16000,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { msg = (await res.json())?.error?.message ?? msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("The model declined this request.");
  return data.content.find((b) => b.type === "text")?.text ?? "";
}

/**
 * Analyze the current page. Returns
 * { ftPerPx, scaleConfidence, scaleBasis, walls:[{x1,y1,x2,y2}] px, notes }.
 */
export async function analyzeFloorplan(pageCanvas, { apiKey } = {}) {
  const { pngBase64 } = downscaleForUpload(pageCanvas);
  let text;
  if (window.wireWizard) {
    const r = await window.wireWizard.aiAnalyze({ pngBase64, prompt: PROMPT, schema: SCHEMA });
    if (r.error) throw new Error(r.error);
    text = r.json;
  } else {
    if (!apiKey) throw new Error("No Claude API key set. Open Settings and add one.");
    text = await callDirect(pngBase64, apiKey);
  }
  const parsed = JSON.parse(text);

  // normalized (0-1000 of width) → image pixels
  const unit = pageCanvas.width / 1000;
  const walls = (parsed.walls || []).map((w) => ({
    x1: w.x1 * unit, y1: w.y1 * unit, x2: w.x2 * unit, y2: w.y2 * unit,
  })).filter((w) => Math.hypot(w.x2 - w.x1, w.y2 - w.y1) > unit * 5);

  // feet_per_unit is feet per (width/1000) px → ft/px = feet_per_unit / (width/1000)
  const ftPerPx = parsed.scale?.feet_per_unit > 0
    ? parsed.scale.feet_per_unit / (pageCanvas.width / 1000)
    : null;

  return {
    ftPerPx,
    scaleConfidence: parsed.scale?.confidence ?? "none",
    scaleBasis: parsed.scale?.basis ?? "",
    walls,
    notes: parsed.notes ?? "",
  };
}
