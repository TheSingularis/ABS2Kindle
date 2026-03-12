const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Single-instance lock ──────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow;

// ── Protocol registration ─────────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("abs2kindle", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("abs2kindle");
}

// ── Settings ──────────────────────────────────────────────────
let settingsStore = {};
const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      settingsStore = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    }
  } catch (e) {
    settingsStore = {};
  }
}

function saveSettings(data) {
  settingsStore = { ...settingsStore, ...data };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settingsStore, null, 2));
}

// ── Auth ──────────────────────────────────────────────────────
function handleAuthCallback(url) {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("token");
    const error = parsed.searchParams.get("error");

    if (error) {
      mainWindow?.webContents.send("oidc-error", error);
      return;
    }

    if (token) {
      mainWindow?.webContents.send("oidc-success", { token });
    }
  } catch (e) {
    mainWindow?.webContents.send("oidc-error", "Invalid callback URL");
  }
}

// ── Window ────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer/index.html"));
  mainWindow = win;
}

// ── IPC handlers ──────────────────────────────────────────────
ipcMain.handle("ping", async () => "pong from main process!");

ipcMain.handle("start-oidc", (_, { serverUrl }) => {
  const callbackUrl = encodeURIComponent("abs2kindle://auth");
  shell.openExternal(`${serverUrl}/auth/openid?redirect=${callbackUrl}`);
  return { ok: true };
});

ipcMain.handle("get-settings", () => settingsStore);

ipcMain.handle("save-settings", (_, data) => {
  saveSettings(data);
  return { ok: true };
});

ipcMain.handle("test-connection", async (_, { serverUrl, apiKey }) => {
  const http = require("http");
  const https = require("https");
  return new Promise((resolve) => {
    try {
      const url = new URL(`${serverUrl}/api/libraries`);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          rejectUnauthorized: false,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              if (json?.libraries)
                resolve({ ok: true, count: json.libraries.length });
              else resolve({ ok: false, error: "Unexpected response" });
            } catch {
              resolve({ ok: false, error: "Could not parse response" });
            }
          });
        },
      );
      req.on("error", (e) => resolve({ ok: false, error: e.message }));
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
});

ipcMain.on("window-minimize", () =>
  BrowserWindow.getFocusedWindow()?.minimize(),
);

ipcMain.on("window-maximize", () => {
  const win = BrowserWindow.getFocusedWindow();
  win?.isMaximized() ? win.unmaximize() : win.maximize();
});

ipcMain.on("window-close", () => BrowserWindow.getFocusedWindow()?.close());

// ── App lifecycle ─────────────────────────────────────────────
app.whenReady().then(() => {
  loadSettings();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", (event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  const url = commandLine.find((arg) => arg.startsWith("abs2kindle://"));
  if (url) handleAuthCallback(url);
});
