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
// ──── Settings Handlers ───────────────────────────────────────
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

// ──── Library Handlers ───────────────────────────────────────

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

// ──── Kindle Handlers ───────────────────────────────────────────

// Query KDE's kmtpd D-Bus service for connected MTP devices and their storages.
// Returns device objects with a kioDocumentsUri field (mtp:/Name/Storage/documents)
// that kioclient5 can copy to directly — no USB access conflict, no udev rule needed.
function findKmtpdDevices() {
  const { execSync } = require("child_process");
  const found = [];

  // Helper: run a dbus-send call and return stdout, or null on failure
  const dbusGet = (objPath, method, ...args) => {
    try {
      return execSync(
        [
          "dbus-send",
          "--session",
          "--print-reply",
          "--dest=org.kde.kiod6",
          objPath,
          method,
          ...args,
        ].join(" "),
        {
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      return null;
    }
  };

  // List device object paths: /modules/kmtpd/device0, device1, ...
  const devicesOut = dbusGet(
    "/modules/kmtpd",
    "org.kde.kmtp.Daemon.listDevices",
  );
  if (!devicesOut) return found;

  const devicePaths = [...devicesOut.matchAll(/object path "([^"]+)"/g)].map(
    (m) => m[1],
  );

  for (const devPath of devicePaths) {
    // Get device friendlyName
    const devProps = dbusGet(
      devPath,
      "org.freedesktop.DBus.Properties.GetAll",
      'string:"org.kde.kmtp.Device"',
    );
    if (!devProps) continue;
    const nameMatch = devProps.match(/"friendlyName"[\s\S]*?string "([^"]+)"/);
    const deviceName = nameMatch ? nameMatch[1] : "Kindle";

    // List storages for this device
    const storagesOut = dbusGet(devPath, "org.kde.kmtp.Device.listStorages");
    if (!storagesOut) continue;
    const storagePaths = [
      ...storagesOut.matchAll(/object path "([^"]+)"/g),
    ].map((m) => m[1]);

    for (const storagePath of storagePaths) {
      // Get storage description
      const storageProps = dbusGet(
        storagePath,
        "org.freedesktop.DBus.Properties.GetAll",
        'string:"org.kde.kmtp.Storage"',
      );
      if (!storageProps) continue;
      const descMatch = storageProps.match(
        /"description"[\s\S]*?string "([^"]+)"/,
      );
      const storageName = descMatch ? descMatch[1] : "Internal Storage";

      // Verify documents/ folder exists via kioclient5 ls
      const kioBase = `mtp:/${deviceName}/${storageName}`;
      const kioDocumentsUri = `${kioBase}/documents`;
      try {
        execSync(`kioclient5 --noninteractive ls "${kioDocumentsUri}"`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        continue; // no documents folder on this storage
      }

      // Count existing books
      let bookCount = 0;
      try {
        const lsOut = execSync(
          `kioclient5 --noninteractive ls "${kioDocumentsUri}"`,
          { encoding: "utf8", timeout: 5000 },
        );
        bookCount = (lsOut.match(/\.(epub|mobi|azw3|azw)\n/gi) || []).length;
      } catch {}

      found.push({
        name: deviceName,
        storageName,
        // documentsPath is a sentinel so the renderer can display something;
        // actual copies go through kioDocumentsUri via kioclient5
        documentsPath: kioDocumentsUri,
        kioDocumentsUri,
        bookCount,
        via: "kmtpd",
      });
    }
  }

  return found;
}

ipcMain.handle("detect-kindles", () => {
  // 1. Try GVFS / USB mass storage (works on GNOME and non-KDE desktops)
  const found = findKindleMounts();
  if (found.length > 0) return found;

  // 2. Try KDE kmtpd D-Bus (works on KDE without any udev rule)
  const kmtpd = findKmtpdDevices();
  if (kmtpd.length > 0) return kmtpd;

  // 3. Try jmtpfs FUSE mount (works on non-KDE desktops with jmtpfs installed)
  const { execSync } = require("child_process");
  try {
    execSync("which jmtpfs", { stdio: "ignore" });
    return findJmtpfsDevices();
  } catch {
    return [];
  }
});

// jmtpfs: FUSE-based fallback for non-KDE systems.
// On KDE the kmtpd path above is used instead.
function findJmtpfsDevices() {
  const { execSync, spawnSync } = require("child_process");
  const found = [];

  let listOutput = "";
  try {
    const result = spawnSync("jmtpfs", ["-l"], {
      encoding: "utf8",
      timeout: 5000,
    });
    listOutput = result.stdout + result.stderr;
  } catch {
    return found;
  }

  const deviceLines = listOutput
    .split("\n")
    .filter((l) => /^\d+,/.test(l.trim()));
  if (deviceLines.length === 0) return found;

  for (const line of deviceLines) {
    const parts = line.split(",").map((s) => s.trim());
    const [busNum, devNum, , , product, vendor] = parts;
    const displayName =
      [vendor, product].filter(Boolean).join(" ").trim() || "Kindle";

    const mountDir = path.join(
      os.tmpdir(),
      `abs2kindle_mtp_${busNum}_${devNum}`,
    );
    try {
      fs.mkdirSync(mountDir, { recursive: true });
      try {
        execSync(`fusermount -u "${mountDir}"`, { stdio: "ignore" });
      } catch {}

      const mount = spawnSync(
        "jmtpfs",
        [`-device=${busNum},${devNum}`, mountDir],
        {
          encoding: "utf8",
          timeout: 10000,
        },
      );
      if (mount.status !== 0) {
        console.error("jmtpfs mount failed:", mount.stderr);
        continue;
      }

      const scanDirs = (base, depth = 0) => {
        if (depth > 2) return;
        try {
          for (const entry of fs.readdirSync(base)) {
            const full = path.join(base, entry);
            if (entry.toLowerCase() === "documents") {
              found.push(
                buildDeviceEntry(path.dirname(full), displayName, full),
              );
              return;
            }
            try {
              if (fs.statSync(full).isDirectory()) scanDirs(full, depth + 1);
            } catch {}
          }
        } catch {}
      };
      scanDirs(mountDir);
    } catch (e) {
      console.error("jmtpfs setup error:", e.message);
    }
  }

  return found;
}

function findKindleMounts() {
  const platform = process.platform;
  const found = [];

  if (platform === "linux") {
    const uid = process.getuid();

    // Check GVFS mount point (where MTP devices land on Linux)
    const gvfsBase = `/run/user/${uid}/gvfs`;
    try {
      if (fs.existsSync(gvfsBase)) {
        for (const entry of fs.readdirSync(gvfsBase)) {
          // MTP entries look like:
          //   mtp:host=Kindle_Paperwhite  (older GVFS style)
          //   mtp:host=%5BKindle%5D...    (URI-encoded)
          //   mtp:%2FKindle_Paperwhite    (slash-style GVFS)
          if (!entry.startsWith("mtp:")) continue;
          const mountPath = `${gvfsBase}/${entry}`;

          // Decode the raw entry name for display purposes
          let rawName;
          try {
            rawName = decodeURIComponent(
              entry
                .replace(/^mtp:host=/, "") // strip "mtp:host=" prefix
                .replace(/^mtp:%2F/, "") // strip "mtp:%2F" (encoded slash) prefix
                .replace(/^mtp:\//, ""), // strip "mtp:/" prefix
            );
          } catch {
            rawName = entry;
          }

          // Scan storage volumes inside the MTP mount
          // Kindle exposes one called "Internal Storage" or similar
          try {
            for (const storage of fs.readdirSync(mountPath)) {
              const storagePath = `${mountPath}/${storage}`;
              const documentsPath = `${storagePath}/documents`;
              if (fs.existsSync(documentsPath)) {
                found.push(
                  buildDeviceEntry(storagePath, rawName, documentsPath),
                );
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // Also check classic USB mass storage paths as fallback
    // (older Kindles or manually mounted)
    const username = require("os").userInfo().username;
    const fallbackDirs = [
      `/media/${username}`,
      `/run/media/${username}`,
      "/mnt",
    ];
    for (const base of fallbackDirs) {
      try {
        if (!fs.existsSync(base)) continue;
        for (const entry of fs.readdirSync(base)) {
          const fullPath = `${base}/${entry}`;
          const documentsPath = `${fullPath}/documents`;
          if (
            entry.toLowerCase().includes("kindle") &&
            fs.existsSync(documentsPath)
          ) {
            found.push(buildDeviceEntry(fullPath, entry, documentsPath));
          }
        }
      } catch (e) {}
    }
  } else if (platform === "win32") {
    for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
      const drivePath = `${letter}:\\`;
      try {
        const documentsPath = `${drivePath}documents`;
        if (fs.existsSync(drivePath) && fs.existsSync(documentsPath)) {
          found.push(
            buildDeviceEntry(drivePath, `Kindle (${letter}:)`, documentsPath),
          );
        }
      } catch (e) {}
    }
  }

  return found;
}

// ── File copy with fallbacks ──────────────────────────────────
//
// Strategy for Linux:
//
//  1. kioclient5 copy — used when the device was detected via kmtpd (KDE).
//     Speaks KIO natively, works while kmtpd holds the USB interface.
//     src: file:///tmp/... dest: mtp:/DeviceName/StorageName/documents/file.epub
//
//  2. fs.copyFileSync — used for GVFS FUSE mounts and USB mass storage where
//     Node has direct filesystem access.
//
//  3. gio copy — fallback if fs.copyFileSync fails on a GVFS path where the
//     kernel FUSE layer is read-only but the gio daemon can still write.
//
//  4. Sentinel throw ("DOLPHIN_BLOCKING") — both fs and gio failed; tell the
//     user to close Dolphin windows that are browsing the device.

const DOLPHIN_BLOCKING_ERROR = "DOLPHIN_BLOCKING";

async function copyToKindle(srcPath, destPath, device) {
  const { execFile } = require("child_process");

  // ── KDE/kmtpd path: use kioclient5 ──────────────────────────
  if (device && device.via === "kmtpd") {
    const filename = path.basename(srcPath);
    const kioDestUri = `${device.kioDocumentsUri}/${filename}`;
    await new Promise((resolve, reject) => {
      execFile(
        "kioclient5",
        [
          "--noninteractive",
          "--overwrite",
          "copy",
          `file://${srcPath}`,
          kioDestUri,
        ],
        { timeout: 60000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `kioclient5 copy failed: ${(stderr || err.message).trim()}`,
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });
    return;
  }

  // ── Non-Linux: plain copy only ───────────────────────────────
  if (process.platform !== "linux") {
    fs.copyFileSync(srcPath, destPath);
    return;
  }

  // ── Attempt 1: direct fs copy (GVFS FUSE / USB mass storage) ─
  try {
    fs.copyFileSync(srcPath, destPath);
    return;
  } catch (e1) {
    console.warn(
      "copyToKindle: fs.copyFileSync failed, trying gio:",
      e1.message,
    );
  }

  // ── Attempt 2: gio copy ──────────────────────────────────────
  try {
    await new Promise((resolve, reject) => {
      execFile(
        "gio",
        ["copy", srcPath, destPath],
        { timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(
              new Error(`gio copy failed: ${(stderr || err.message).trim()}`),
            );
          } else {
            resolve();
          }
        },
      );
    });
    return;
  } catch (e2) {
    console.warn("copyToKindle: gio copy failed:", e2.message);
  }

  // ── Both methods failed ──────────────────────────────────────
  throw new Error(DOLPHIN_BLOCKING_ERROR);
}

function buildDeviceEntry(mountPath, rawName, documentsPath) {
  // Clean up the display name — rawName is already decoded/stripped of mtp: prefix
  // e.g. "Kindle_Paperwhite" → "Kindle Paperwhite"
  let name = rawName.replace(/_/g, " ").trim();
  if (!name || name.length < 2) name = "Kindle";

  let bookCount = 0;
  try {
    bookCount = fs
      .readdirSync(documentsPath)
      .filter((f) =>
        [".epub", ".mobi", ".azw3", ".azw"].some((ext) => f.endsWith(ext)),
      ).length;
  } catch (e) {}

  return { name, path: mountPath, documentsPath, bookCount };
}

ipcMain.handle(
  "send-to-kindle",
  async (event, { itemIds, kindleDocumentsPath, device }) => {
    const { serverUrl, apiKey } = settingsStore;
    const results = [];

    for (let i = 0; i < itemIds.length; i++) {
      const itemId = itemIds[i];

      event.sender.send("transfer-progress", {
        current: i + 1,
        total: itemIds.length,
        itemId,
        status: "downloading",
      });

      try {
        // Get item details
        const item = await absRequest(
          serverUrl,
          apiKey,
          `/api/items/${itemId}`,
        );
        const title = item?.media?.metadata?.title ?? itemId;
        const safeTitle = title.replace(/[<>:"/\\|?*]/g, "_");

        // Find the epub file in the item's file list
        const files = item?.media?.files ?? [];
        const epubFile = files.find(
          (f) => f.metadata?.ext?.toLowerCase() === ".epub",
        );

        if (!epubFile) {
          throw new Error(`No EPUB found for "${title}"`);
        }

        // Download to a temp file first
        const tmpPath = path.join(
          require("os").tmpdir(),
          `abs2kindle_${safeTitle}.epub`,
        );
        const destPath = path.join(kindleDocumentsPath, `${safeTitle}.epub`);

        await downloadFile(
          `${serverUrl}/api/items/${itemId}/file/${epubFile.ino}`,
          apiKey,
          tmpPath,
        );

        event.sender.send("transfer-progress", {
          current: i + 1,
          total: itemIds.length,
          itemId,
          status: "copying",
          title,
        });

        // Copy from temp to Kindle documents folder.
        // copyToKindle picks the right method based on how the device was detected:
        // kmtpd → kioclient5, GVFS/USB → fs.copyFileSync, fallback → gio copy
        await copyToKindle(tmpPath, destPath, device);
        fs.unlinkSync(tmpPath);

        event.sender.send("transfer-progress", {
          current: i + 1,
          total: itemIds.length,
          itemId,
          status: "done",
          title,
        });

        results.push({ itemId, title, ok: true });
      } catch (e) {
        // Clean up temp file if it exists
        try {
          const safeTitle = itemId.replace(/[<>:"/\\|?*]/g, "_");
          const tmpPath = path.join(
            require("os").tmpdir(),
            `abs2kindle_${safeTitle}.epub`,
          );
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch (_) {}

        const isDolphinBlocking = e.message === DOLPHIN_BLOCKING_ERROR;

        event.sender.send("transfer-progress", {
          current: i + 1,
          total: itemIds.length,
          itemId,
          // Emit a dedicated status so the renderer can show a targeted message
          // without having to parse error strings.
          status: isDolphinBlocking ? "dolphin-blocking" : "error",
          error: isDolphinBlocking
            ? "Dolphin may be holding the device. Close any Dolphin windows showing your Kindle and try again."
            : e.message,
        });

        results.push({
          itemId,
          ok: false,
          error: isDolphinBlocking ? "dolphin-blocking" : e.message,
        });

        // Stop processing further items — Dolphin is holding the whole device,
        // not just this one file. No point attempting the rest.
        if (isDolphinBlocking) break;
      }
    }

    return { results };
  },
);

function downloadFile(url, apiKey, destPath) {
  const http = require("http");
  const https = require("https");

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        rejectUnauthorized: false,
      },
      (res) => {
        // Follow redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          downloadFile(res.headers.location, apiKey, destPath)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Server returned ${res.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(destPath)));
        file.on("error", (e) => {
          fs.unlink(destPath, () => {});
          reject(e);
        });
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.end();
  });
}

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
