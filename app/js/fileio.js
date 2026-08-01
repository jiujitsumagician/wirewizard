// Floorplan input (PDF via pdf.js, raster images via createImageBitmap) and
// marked-up PDF output (jsPDF). Pages are normalized to canvases so the rest
// of the app never cares what the source was.

import * as pdfjsLib from "../../node_modules/pdfjs-dist/build/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("../../node_modules/pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;

const PDF_RENDER_SCALE = 2.2; // ~160dpi on letter-size — crisp without exploding memory

/** Load a floorplan file. Returns [{canvas, label}] — one entry per page. */
export async function loadFloorplan(name, bytes /* Uint8Array */) {
  if (/\.pdf$/i.test(name)) {
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push({ canvas, label: `Page ${i}` });
    }
    return pages;
  }
  // raster image
  const blob = new Blob([bytes]);
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return [{ canvas, label: "Page 1" }];
}

/**
 * Export marked-up pages to a PDF.
 * `renderPage(pageIndex)` must return a canvas with everything composited
 * (base + annotations + heatmap + legend) at export resolution.
 */
export async function exportPdf(pageCount, renderPage, jsPDFCtor) {
  let doc = null;
  for (let i = 0; i < pageCount; i++) {
    const canvas = await renderPage(i);
    const landscape = canvas.width >= canvas.height;
    // page sized to the image aspect at 72dpi-ish units
    const w = landscape ? 842 : 595;
    const h = Math.round(w * (canvas.height / canvas.width));
    if (!doc) {
      doc = new jsPDFCtor({ orientation: landscape ? "l" : "p", unit: "pt", format: [w, h] });
    } else {
      doc.addPage([w, h], landscape ? "l" : "p");
    }
    doc.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, w, h);
  }
  return doc.output("arraybuffer");
}

export function bytesToBase64(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
