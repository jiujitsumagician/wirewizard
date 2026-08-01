// Bridge between the sandboxed renderer and main. The renderer feature-detects
// window.wireWizard — absent (plain browser) it falls back to <input type=file>,
// blob downloads, localStorage settings, and direct-fetch AI.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wireWizard", {
  openFloorplan: () => ipcRenderer.invoke("ww:open-floorplan"),
  saveFile: (opts) => ipcRenderer.invoke("ww:save-file", opts),
  getSettings: () => ipcRenderer.invoke("ww:get-settings"),
  setSettings: (patch) => ipcRenderer.invoke("ww:set-settings", patch),
  aiAnalyze: (payload) => ipcRenderer.invoke("ww:ai-analyze", payload),
  openExternal: (url) => ipcRenderer.invoke("ww:open-external", url),
});
