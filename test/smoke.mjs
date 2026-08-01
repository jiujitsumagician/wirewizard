// Browser-mode smoke test: boots the app in Chromium, runs the built-in
// self-test (demo plan + icons + cables + heatmap + legend + PDF export
// pipeline), captures screenshots, and fails on any console error.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { startStaticServer } from "../serve-lib.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { server, port } = await startStaticServer(root);
await mkdir(join(root, "test", "shots"), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1560, height: 980 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

await page.goto(`http://127.0.0.1:${port}/app/index.html`, { waitUntil: "load" });
await page.waitForFunction(() => typeof window.__ww_selftest === "function", null, { timeout: 20000 });

// empty state
await page.screenshot({ path: "test/shots/smoke-empty.png" });

// full pipeline
const result = await page.evaluate(() => window.__ww_selftest());
console.log("selftest:", JSON.stringify(result));
await page.waitForTimeout(300);
await page.screenshot({ path: "test/shots/smoke-markup.png" });

// UI interactions: tool switching, settings modal, cable add, page fit
await page.click('[data-tool="line"]');
await page.click("#btn-settings");
await page.fill("#set-wallloss", "5");
await page.click("#btn-settings-save");
await page.click("#btn-add-cable");
await page.click("#btn-legend"); // remove legend
await page.click("#btn-legend"); // re-place legend
await page.waitForTimeout(200);
await page.screenshot({ path: "test/shots/smoke-ui.png" });

// PDF round-trip: exported PDF re-ingested through pdf.js
const rt = await page.evaluate(() => window.__ww_pdf_roundtrip());
console.log("pdf roundtrip:", JSON.stringify(rt));
await page.waitForTimeout(200);
await page.screenshot({ path: "test/shots/smoke-pdf-roundtrip.png" });

const checks = [
  ["pdf ingestion works", rt?.pages === 1 && rt?.w > 400],
  ["selftest ok", result?.ok === true],
  ["export non-trivial", result?.exportBytes > 20000],
  ["walls present", result?.walls >= 10],
  ["items placed", result?.items >= 12],
  ["zero console errors", errors.length === 0],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(ok ? "PASS " : "FAIL ", name);
  if (!ok) failed++;
}
if (errors.length) {
  console.error("ERRORS:");
  for (const e of [...new Set(errors)].slice(0, 12)) console.error(" -", e);
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
