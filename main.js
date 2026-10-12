// Wire Wizard — Electron main process.
// Owns: window lifecycle, native file dialogs, settings persistence, and the
// Claude API call for floorplan analysis (kept in main so the API key never
// rides through renderer fetch and CORS never enters the picture).
const { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let win = null;
let serverHandle = null;

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettingsFile(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// The API key is encrypted at rest with the OS keystore (DPAPI on Windows) and
// never handed to the renderer. Plaintext is only used when safeStorage is
// unavailable on this machine.
function getApiKey(settings = readSettingsFile()) {
  if (typeof settings.anthropicApiKeyEnc === "string" && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(settings.anthropicApiKeyEnc, "base64"));
    } catch {
      return "";
    }
  }
  return typeof settings.anthropicApiKey === "string" ? settings.anthropicApiKey : "";
}

// Mutates `settings`: removes any stored key, then stores `key` (if non-empty).
function setApiKey(settings, key) {
  delete settings.anthropicApiKey;
  delete settings.anthropicApiKeyEnc;
  if (!key) return;
  if (safeStorage.isEncryptionAvailable()) {
    settings.anthropicApiKeyEnc = safeStorage.encryptString(key).toString("base64");
  } else {
    settings.anthropicApiKey = key;
  }
}

// Loads settings, migrating a legacy plaintext key to encrypted storage.
function loadSettings() {
  const settings = readSettingsFile();
  if (typeof settings.anthropicApiKey === "string" && settings.anthropicApiKey && safeStorage.isEncryptionAvailable()) {
    try {
      setApiKey(settings, settings.anthropicApiKey);
      writeSettingsFile(settings);
    } catch {
      // keep the plaintext key rather than lose it if encryption/writing fails
      return readSettingsFile();
    }
  }
  return settings;
}

// What the renderer is allowed to see: everything except the key itself.
function publicSettings(settings) {
  const { anthropicApiKey: _k, anthropicApiKeyEnc: _e, ...rest } = settings;
  return { ...rest, hasApiKey: Boolean(getApiKey(settings)) };
}

// The renderer only ever sends these keys (state.settings in app.js). Anything
// else, or a value of the wrong type, is ignored rather than written to disk.
function sanitizeSettingsPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return clean;
  // An absent or empty key means "unchanged"; clearing is the explicit flag.
  if (typeof patch.anthropicApiKey === "string" && patch.anthropicApiKey && patch.anthropicApiKey.length <= 512) {
    clean.anthropicApiKey = patch.anthropicApiKey;
  }
  if (patch.clearApiKey === true) clean.clearApiKey = true;
  for (const k of ["wallLossDb", "pathLossExp", "txAt1m", "iconScale"]) {
    if (typeof patch[k] === "number" && Number.isFinite(patch[k])) clean[k] = patch[k];
  }
  return clean;
}

function saveSettings(patch) {
  const clean = sanitizeSettingsPatch(patch);
  const { anthropicApiKey, clearApiKey, ...rest } = clean;
  const merged = { ...loadSettings(), ...rest };
  if (clearApiKey) setApiKey(merged, "");
  else if (anthropicApiKey) setApiKey(merged, anthropicApiKey);
  if (Object.keys(clean).length > 0) writeSettingsFile(merged);
  return publicSettings(merged);
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
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // Lock the window to the loopback origin: no popups, no off-origin
  // navigation, no web permission prompts. The only external link goes
  // through the ww:open-external IPC.
  const origin = `http://127.0.0.1:${port}/`;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin)) e.preventDefault();
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
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
ipcMain.handle("ww:get-settings", () => publicSettings(loadSettings()));
ipcMain.handle("ww:set-settings", (_e, patch) => saveSettings(patch));
ipcMain.handle("ww:open-external", (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ── IPC: Claude floorplan analysis ────────────────────────────
// The renderer sends a downscaled PNG of the current page; Claude returns the
// drawing scale and wall segments as strict JSON (schema-enforced).
ipcMain.handle("ww:ai-analyze", async (_e, { pngBase64, prompt, schema } = {}) => {
  // The renderer downscales to <=1400px PNG (a few MB); cap generously.
  if (typeof pngBase64 !== "string" || pngBase64.length > 64 * 1024 * 1024) {
    return { error: "Invalid image payload." };
  }
  const key = getApiKey(loadSettings()) || process.env.ANTHROPIC_API_KEY || "";
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
