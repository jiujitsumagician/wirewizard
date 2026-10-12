// Tiny static server shared by the Electron shell and the browser test harness.
// Serving over loopback HTTP (instead of file://) gives the renderer normal web
// semantics — ES modules, workers (pdf.js), fetch — identically in both.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, relative, isAbsolute } from "node:path";

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

// Only what the app (and the packaged exe) actually load. Everything else:
// .git, .env, package.json, main.js, other node_modules, is a 404.
const ALLOWED_PREFIXES = ["/app/", "/node_modules/pdfjs-dist/build/", "/node_modules/jspdf/dist/"];

/** Start serving `root` on 127.0.0.1. Resolves with the chosen port. */
export function startStaticServer(root, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        // DNS-rebinding guard: only answer requests addressed to the loopback origin.
        const { port: boundPort } = server.address();
        if (req.headers.host !== `127.0.0.1:${boundPort}` && req.headers.host !== `localhost:${boundPort}`) {
          throw new Error("bad host");
        }
        let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (path === "/") path = "/app/index.html";
        if (path.includes(String.fromCharCode(0)) || path.split(/[\\/]/).some((seg) => seg.startsWith("."))) throw new Error("hidden");
        if (!ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))) throw new Error("not served");
        const file = normalize(join(root, path));
        const rel = relative(root, file);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("traversal");
        const data = await readFile(file);
        res.writeHead(200, {
          "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        });
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
