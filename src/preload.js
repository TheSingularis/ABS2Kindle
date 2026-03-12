const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  ping: () => ipcRenderer.invoke("ping"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),
  windowClose: () => ipcRenderer.send("window-close"),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (data) => ipcRenderer.invoke("save-settings", data),
  testConnection: (opts) => ipcRenderer.invoke("test-connection", opts),

  // Auth
  startOidc: (opts) => ipcRenderer.invoke("start-oidc", opts),
  onOidcSuccess: (cb) => ipcRenderer.on("oidc-success", (_, data) => cb(data)),
  onOidcError: (cb) => ipcRenderer.on("oidc-error", (_, err) => cb(err)),
});
