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

  // Libraries
    getLibraries: () => ipcRenderer.invoke("get-libraries"),
    getBooks: (opts) => ipcRenderer.invoke("get-books", opts),
});
