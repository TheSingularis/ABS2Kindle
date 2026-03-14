const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");

const { settingsStore, loadSettings, saveSettings } = require("./lib/settings");
const { absRequest, downloadFile } = require("./lib/abs-client");
const { findKindleMounts, findKmtpdDevices, findJmtpfsDevices } = require("./lib/kindle-detect");
const {
  DOLPHIN_BLOCKING_ERROR,
  convertEpubToAzw3,
  injectAsinIntoAzw3,
  copyToKindle,
} = require("./lib/kindle-transfer");

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

// ── IPC: Settings ─────────────────────────────────────────────
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

// ── IPC: Library ─────────────────────────────────────────────

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

// ── IPC: Kindle detection ─────────────────────────────────────
ipcMain.handle('detect-kindles', () => {
  // 1. GVFS / USB mass storage (GNOME and non-KDE)
  const found = findKindleMounts();
  if (found.length > 0) return found;

  // 2. KDE kmtpd D-Bus (no udev rule required)
  const kmtpd = findKmtpdDevices();
  if (kmtpd.length > 0) return kmtpd;

  // 3. jmtpfs FUSE (non-KDE fallback)
  const { execSync } = require('child_process');
  try {
    execSync('which jmtpfs', { stdio: 'ignore' });
    return findJmtpfsDevices();
  } catch {
    return [];
  }
});

// ── IPC: Transfer ─────────────────────────────────────────────
ipcMain.handle(
  "send-to-kindle",
  async (event, { itemIds, kindleDocumentsPath, device }) => {
    const { serverUrl, apiKey } = settingsStore;
    const results = [];

    for (let i = 0; i < itemIds.length; i++) {
      const itemId = itemIds[i];
      const tmpDir = require("os").tmpdir();
      let epubPath = null;
      let azw3Path = null;

      const progress = (status, extra = {}) =>
        event.sender.send("transfer-progress", {
          current: i + 1,
          total: itemIds.length,
          itemId,
          status,
          ...extra,
        });

      try {
        // ── Step 1: fetch metadata ────────────────────────────
        progress("downloading");
        const item = await absRequest(serverUrl, apiKey, `items/${itemId}`);
        const meta = item?.media?.metadata ?? {};
        const title = meta.title ?? itemId;
        const asin = meta.asin ?? null;
        const safeTitle = title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 80);

        // ── Step 2: download EPUB to tmp ──────────────────────
        epubPath = path.join(tmpDir, `abs2kindle_${safeTitle}.epub`);
        await downloadFile(
          `${serverUrl}/api/items/${itemId}/ebook`,
          apiKey,
          epubPath,
        );

        // ── Step 3: convert EPUB → AZW3 ──────────────────────
        progress("converting", { title });
        azw3Path = path.join(tmpDir, `abs2kindle_${safeTitle}.azw3`);
        convertEpubToAzw3(epubPath, azw3Path);
        fs.unlinkSync(epubPath);
        epubPath = null;

        // ── Step 4: inject real ASIN into AZW3 ───────────────
        if (asin) {
          injectAsinIntoAzw3(azw3Path, asin);
        } else {
          console.warn(`send-to-kindle: no ASIN for "${title}" — skipping injection`);
        }

        // ── Step 5: copy AZW3 to Kindle ───────────────────────
        progress("copying", { title });
        const destPath = path.join(kindleDocumentsPath, `${safeTitle}.azw3`);
        await copyToKindle(azw3Path, destPath, device);
        fs.unlinkSync(azw3Path);
        azw3Path = null;

        progress("done", { title });
        results.push({ itemId, title, ok: true });
      } catch (e) {
        // Best-effort cleanup of any leftover tmp files
        try { if (epubPath && fs.existsSync(epubPath)) fs.unlinkSync(epubPath); } catch (_) {}
        try { if (azw3Path && fs.existsSync(azw3Path)) fs.unlinkSync(azw3Path); } catch (_) {}

        const isDolphinBlocking = e.message === DOLPHIN_BLOCKING_ERROR;
        progress(isDolphinBlocking ? "dolphin-blocking" : "error", {
          error: isDolphinBlocking
            ? "Dolphin may be holding the device. Close any Dolphin windows showing your Kindle and try again."
            : e.message,
        });

        results.push({
          itemId,
          ok: false,
          error: isDolphinBlocking ? "dolphin-blocking" : e.message,
        });

        if (isDolphinBlocking) break;
      }
    }

    return { results };
  },
);

// ──── Kindle Book Management ──────────────────────────────────

ipcMain.handle("list-kindle-books", async (_, { device }) => {
  const { execSync } = require("child_process");
  const BOOK_EXTS = [".epub", ".mobi", ".azw3", ".azw", ".pdf"];

  try {
    if (device.via === "kmtpd") {
      // Use kioclient5 to list the documents folder
      const lsOut = execSync(
        `kioclient5 --noninteractive ls "${device.kioDocumentsUri}"`,
        { encoding: "utf8", timeout: 8000 },
      );
      const files = lsOut
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => BOOK_EXTS.some((ext) => l.toLowerCase().endsWith(ext)));
      return { ok: true, files };
    } else {
      // Direct filesystem access (GVFS / USB)
      const files = fs
        .readdirSync(device.documentsPath)
        .filter((f) => BOOK_EXTS.some((ext) => f.toLowerCase().endsWith(ext)));
      return { ok: true, files };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("delete-kindle-book", async (_, { device, filename }) => {
  const { execSync } = require("child_process");

  // Reject path traversal attempts
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return { ok: false, error: "Invalid filename" };
  }

  try {
    if (device.via === "kmtpd") {
      const kioUri = `${device.kioDocumentsUri}/${filename}`;
      execSync(`kioclient5 --noninteractive del "${kioUri}"`, {
        encoding: "utf8",
        timeout: 10000,
      });
    } else {
      const filePath = path.join(device.documentsPath, filename);
      fs.unlinkSync(filePath);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Window controls ───────────────────────────────────────────
ipcMain.on("window-minimize", () => BrowserWindow.getFocusedWindow()?.minimize());
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
