const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  ping: () => ipcRenderer.invoke("ping"),
  windowMinimize: () => ipcRenderer.send("window-minimize"),
  windowMaximize: () => ipcRenderer.send("window-maximize"),
  windowClose: () => ipcRenderer.send("window-close"),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (data) => ipcRenderer.invoke("save-settings", data),
  pingServer: (opts) => ipcRenderer.invoke("ping-server", opts),
  testConnection: (opts) => ipcRenderer.invoke("test-connection", opts),
  checkOidcAvailable: (opts) =>
    ipcRenderer.invoke("check-oidc-available", opts),
  checkCalibre: () => ipcRenderer.invoke("check-calibre"),
  onCalibreStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("calibre-status", handler);
    return () => ipcRenderer.removeListener("calibre-status", handler);
  },

  // OIDC auth — opens a modal browser window with the ABS OIDC flow
  startOidcLogin: (opts) => ipcRenderer.invoke("start-oidc-login", opts),

  // Libraries
  getLibraries: () => ipcRenderer.invoke("get-libraries"),
  getBooks: (opts) => ipcRenderer.invoke("get-books", opts),
  getPersonalized: (opts) => ipcRenderer.invoke("get-personalized", opts),

  // Kindle
  detectKindles: () => ipcRenderer.invoke("detect-kindles"),
  sendToKindle: (opts) => ipcRenderer.invoke("send-to-kindle", opts),
  listKindleBooks: (opts) => ipcRenderer.invoke("list-kindle-books", opts),
  deleteKindleBook: (opts) => ipcRenderer.invoke("delete-kindle-book", opts),
  onTransferProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("transfer-progress", handler);
    return () => ipcRenderer.removeListener("transfer-progress", handler);
  },
  onKindleAsinResolved: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("kindle-asin-resolved", handler);
    return () => ipcRenderer.removeListener("kindle-asin-resolved", handler);
  },
});
