// Wire Wizard — Electron main process.
// Owns: window lifecycle, native file dialogs, settings persistence, and the
// Claude API call for floorplan analysis (kept in main so the API key never
// rides through renderer fetch and CORS never enters the picture).
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let win = null;
let serverHandle = null;

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  return merged;
}

async function createWindow() {
  const { startStaticServer } = await import(
    // pathToFileURL keeps this working when the app path has spaces
    require("node:url").pathToFileURL(path.join(__dirname, "serve-lib.mjs")).href
  );
  const { server, port } = await startStaticServer(__dirname);
  serverHandle = server;

  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#12151b",
    title: "Wire Wizard",
    icon: path.join(__dirname, "app", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  await win.loadURL(`http://127.0.0.1:${port}/app/index.html`);

  // --selftest: load the demo plan, exercise the pipeline, capture a PNG, exit.
  if (process.argv.includes("--selftest")) {
    try {
      await win.webContents.executeJavaScript("window.__ww_selftest()", true);
      const image = await win.webContents.capturePage();
      const outDir = fs.existsSync(path.join(__dirname, "test"))
        ? path.join(__dirname, "test")
        : require("node:os").tmpdir();
      fs.writeFileSync(path.join(outDir, "selftest-electron.png"), image.toPNG());
      console.log("SELFTEST OK");
      app.exit(0);
    } catch (err) {
      console.error("SELFTEST FAIL", err);
      app.exit(1);
    }
  }
}

// ── IPC: file dialogs ─────────────────────────────────────────
ipcMain.handle("ww:open-floorplan", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Open floorplan",
    filters: [
      { name: "Floorplans", extensions: ["pdf", "png", "jpg", "jpeg", "webp", "bmp", "wirewiz"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), data: fs.readFileSync(p).toString("base64") };
});

ipcMain.handle("ww:save-file", async (_e, { defaultName, base64, filterName, ext }) => {
  const r = await dialog.showSaveDialog(win, {
    title: "Save",
    defaultPath: defaultName,
    filters: [{ name: filterName || "File", extensions: [ext || "*"] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(base64, "base64"));
  return r.filePath;
});

// ── IPC: settings ─────────────────────────────────────────────
ipcMain.handle("ww:get-settings", () => loadSettings());
ipcMain.handle("ww:set-settings", (_e, patch) => saveSettings(patch));
ipcMain.handle("ww:open-external", (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ── IPC: Claude floorplan analysis ────────────────────────────
// The renderer sends a downscaled PNG of the current page; Claude returns the
// drawing scale and wall segments as strict JSON (schema-enforced).
ipcMain.handle("ww:ai-analyze", async (_e, { pngBase64, prompt, schema }) => {
  const key = loadSettings().anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    // Zero-arg constructor also resolves ANTHROPIC_AUTH_TOKEN / `ant auth
    // login` profiles, so "log into your Claude account" via the ant CLI works
    // with no key pasted into settings at all.
    const client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      output_config: { format: { type: "json_schema", schema } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      return { error: "The model declined this request. Try a different image." };
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    return { json: text };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  serverHandle?.close();
  app.quit();
});
