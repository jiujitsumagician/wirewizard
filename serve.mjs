// Dev/test entry: serve the repo root so /app and /node_modules resolve.
// `npm run serve` → http://127.0.0.1:8151
import { startStaticServer } from "./serve-lib.mjs";
const { port } = await startStaticServer(process.cwd(), process.env.PORT ? Number(process.env.PORT) : 8151);
console.log(`Wire Wizard (browser mode) → http://127.0.0.1:${port}`);
