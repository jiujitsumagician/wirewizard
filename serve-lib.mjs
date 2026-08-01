// Tiny static server shared by the Electron shell and the browser test harness.
// Serving over loopback HTTP (instead of file://) gives the renderer normal web
// semantics — ES modules, workers (pdf.js), fetch — identically in both.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/** Start serving `root` on 127.0.0.1. Resolves with the chosen port. */
export function startStaticServer(root, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (path === "/") path = "/app/index.html";
        const file = normalize(join(root, path));
        if (!file.startsWith(normalize(root))) throw new Error("traversal");
        const data = await readFile(file);
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
