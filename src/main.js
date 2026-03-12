const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");

// ── Settings ──────────────────────────────────────────────────
let settingsStore = {};
const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH))
      settingsStore = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    settingsStore = {};
  }
}

function saveSettings(data) {
  settingsStore = { ...settingsStore, ...data };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settingsStore, null, 2));
}

// ── Main Functionality ────────────────────────────────────────

function absRequest(serverUrl, apiKey, endpoint) {
  const http = require("http");
  const https = require("https");

  return new Promise((resolve, reject) => {
    const url = new URL(`${serverUrl}/api/${endpoint}`);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Could not parse response: " + e.message));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── Window ────────────────────────────────────────────────────
let mainWindow;

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

// ── Linux protocol handler (.desktop + socat wrapper) ────────
function registerLinuxProtocol() {
  if (process.platform !== "linux") return;
  const { execSync } = require("child_process");
  const desktopDir = path.join(os.homedir(), ".local", "share", "applications");
  const desktopPath = path.join(desktopDir, "abs2kindle.desktop");
  const wrapperPath = path.join(desktopDir, "abs2kindle-url-handler.sh");

  // Tiny shell script: forwards the URL to the running app via the Unix socket.
  // Uses node (always available in this app's context) to write + close cleanly.
  const wrapperScript =
    [
      "#!/bin/sh",
      `# Forwards abs2kindle:// URLs to the running ABS2Kindle instance via socket`,
      `SOCK="${path.join(os.tmpdir(), "abs2kindle.sock")}"`,
      `URL="$1"`,
      `if command -v socat >/dev/null 2>&1; then`,
      `  printf '%s' "$URL" | socat -t1 - UNIX-CONNECT:"$SOCK"`,
      `elif command -v node >/dev/null 2>&1; then`,
      `  node -e "const n=require('net'),c=n.createConnection('$SOCK',()=>{c.end(process.argv[1])});c.on('error',()=>{})" "$URL"`,
      `else`,
      `  printf '%s' "$URL" | nc -q1 -U "$SOCK" 2>/dev/null || printf '%s' "$URL" | nc -U "$SOCK"`,
      `fi`,
    ].join("\n") + "\n";

  const desktopContents =
    [
      "[Desktop Entry]",
      "Name=ABS2Kindle",
      "Type=Application",
      `Exec=${wrapperPath} %u`,
      "MimeType=x-scheme-handler/abs2kindle;",
      "NoDisplay=true",
    ].join("\n") + "\n";

  try {
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(wrapperPath, wrapperScript);
    fs.chmodSync(wrapperPath, 0o755);
    fs.writeFileSync(desktopPath, desktopContents);
    execSync(
      `xdg-mime default abs2kindle.desktop x-scheme-handler/abs2kindle`,
      { stdio: "ignore" },
    );
    try {
      execSync(`update-desktop-database ${desktopDir}`, { stdio: "ignore" });
    } catch {}
    console.log("Protocol handler registered via wrapper:", wrapperPath);
  } catch (e) {
    console.error("Failed to register protocol handler:", e.message);
  }
}

// ── IPC handlers ──────────────────────────────────────────────
ipcMain.handle("ping", async () => "pong");

ipcMain.handle("get-settings", () => settingsStore);
ipcMain.handle("save-settings", (_, data) => {
  saveSettings(data);
  return { ok: true };
});

ipcMain.handle("test-connection", async (_, { serverUrl, apiKey }) => {
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

ipcMain.handle("get-libraries", async () => {
  const { serverUrl, apiKey } = settingsStore;
  try {
    const result = await absRequest(serverUrl, apiKey, "libraries");
    return result?.libraries ?? [];
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle("get-books", async (_, { libraryId }) => {
  const { serverUrl, apiKey } = settingsStore;
  try {
    let all = [];
    let page = 0;
    const limit = 100;
    while (true) {
      const result = await absRequest(
        serverUrl,
        apiKey,
        `libraries/${libraryId}/items?limit=${limit}&page=${page}`,
      );
      const items =
        result?.results?.results ?? result?.results ?? result?.items ?? [];
      all = all.concat(items);
      if (items.length < limit) break;
      page++;
    }
    return { results: all };
  } catch (e) {
    return { error: e.message };
  }
});

// ── Window controls ─────────────────────────────────────────────

ipcMain.on("window-minimize", () =>
  BrowserWindow.getFocusedWindow()?.minimize(),
);

ipcMain.on("window-maximize", () => {
  const win = BrowserWindow.getFocusedWindow();
  win?.isMaximized() ? win.unmaximize() : win.maximize();
});

ipcMain.on("window-close", () => BrowserWindow.getFocusedWindow()?.close());

// ── App bootstrap ─────────────────────────────────────────────
app.setName("ABS2Kindle");
app.commandLine.appendSwitch("disable-gpu-vsync");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    registerLinuxProtocol();
    loadSettings();
    createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
