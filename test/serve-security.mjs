// Static server hardening test (no browser, no dependencies):
//   node test/serve-security.mjs
// Verifies containment, the path allow-list, hidden-file refusal and the
// loopback Host check. Legitimate app assets must still be served.
import { request } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStaticServer } from "../serve-lib.mjs";

const base = await mkdtemp(join(tmpdir(), "ww-serve-"));
const root = join(base, "site");
const sibling = join(base, "site-secret"); // shares the root name as a prefix
await mkdir(join(root, "app"), { recursive: true });
await mkdir(join(root, ".git"), { recursive: true });
await mkdir(join(root, "node_modules", "pdfjs-dist", "build"), { recursive: true });
await mkdir(join(root, "node_modules", "other"), { recursive: true });
await mkdir(sibling, { recursive: true });
await writeFile(join(root, "app", "index.html"), "<!doctype html>ok");
await writeFile(join(root, ".git", "config"), "secret");
await writeFile(join(root, ".env"), "secret");
await writeFile(join(root, "package.json"), "{}");
await writeFile(join(root, "node_modules", "pdfjs-dist", "build", "pdf.mjs"), "export {}");
await writeFile(join(root, "node_modules", "other", "x.js"), "secret");
await writeFile(join(sibling, "secret.txt"), "secret");

const { server, port } = await startStaticServer(root);

function get(path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end();
  });
}

const cases = [
  ["serves / (index)", async () => (await get("/")).statusCode === 200],
  ["serves /app/index.html with nosniff", async () => {
    const r = await get("/app/index.html");
    return r.statusCode === 200 && r.headers["x-content-type-options"] === "nosniff";
  }],
  ["serves pdf.js build", async () => (await get("/node_modules/pdfjs-dist/build/pdf.mjs")).statusCode === 200],
  ["localhost Host accepted", async () => (await get("/app/index.html", `localhost:${port}`)).statusCode === 200],
  ["foreign Host rejected", async () => (await get("/app/index.html", "evil.example")).statusCode === 404],
  ["foreign Host with port rejected", async () => (await get("/app/index.html", `evil.example:${port}`)).statusCode === 404],
  ["/.git/config 404", async () => (await get("/.git/config")).statusCode === 404],
  ["/app/../.env 404", async () => (await get("/app/%2e%2e/.env")).statusCode === 404],
  ["/package.json 404", async () => (await get("/package.json")).statusCode === 404],
  ["other node_modules 404", async () => (await get("/node_modules/other/x.js")).statusCode === 404],
  ["encoded traversal to sibling-prefix dir 404", async () => (await get("/app/%2e%2e%2f%2e%2e%2fsite-secret/secret.txt")).statusCode === 404],
  ["raw traversal to sibling-prefix dir 404", async () => (await get("/app/../../site-secret/secret.txt")).statusCode === 404],
  ["backslash traversal 404", async () => (await get("/app/..%5C..%5Csite-secret%5Csecret.txt")).statusCode === 404],
];

let failed = 0;
for (const [name, fn] of cases) {
  let ok = false;
  try { ok = await fn(); } catch (e) { console.error(e); }
  console.log(ok ? "PASS " : "FAIL ", name);
  if (!ok) failed++;
}

server.close();
await rm(base, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
