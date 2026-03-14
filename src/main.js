const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const { settingsStore, loadSettings, saveSettings } = require("./lib/settings");
const { absRequest, downloadFile } = require("./lib/abs-client");
const {
  findKindleMounts,
  findKmtpdDevices,
  findJmtpfsDevices,
} = require("./lib/kindle-detect");
const {
  DOLPHIN_BLOCKING_ERROR,
  convertEpubToAzw3,
  injectAsinIntoAzw3,
  readAsinFromBuffer,
  readAsinFromAzw3,
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

// Hits the public /ping endpoint — no auth required.
// Returns { ok: true } when the server responds with { "success": true }.
ipcMain.handle("ping-server", async (_, { serverUrl }) => {
  return new Promise((resolve) => {
    try {
      const url = new URL(`${serverUrl}/ping`);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "GET",
          rejectUnauthorized: false,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              if (json?.success === true) resolve({ ok: true });
              else resolve({ ok: false, error: "Not an ABS server" });
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

// Hits the public /status endpoint — no auth required.
// Returns { available: true } when the server's authActiveAuthMethods includes "openid".
ipcMain.handle("check-oidc-available", async (_, { serverUrl }) => {
  return new Promise((resolve) => {
    try {
      const url = new URL(`${serverUrl}/status`);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "GET",
          rejectUnauthorized: false,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              const methods = json?.authMethods;
              resolve({
                available: Array.isArray(methods) && methods.includes("openid"),
              });
            } catch {
              resolve({ available: false });
            }
          });
        },
      );
      req.on("error", () => resolve({ available: false }));
      req.end();
    } catch {
      resolve({ available: false });
    }
  });
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

// ── IPC: OIDC Login ───────────────────────────────────────────
// Opens the ABS OIDC flow in a dedicated BrowserWindow.
// Uses PKCE (S256) as required by the ABS OAuth2 implementation.
// On success emits "oidc-token" to the renderer with the user's API token.

// PKCE helpers (Node built-ins only, no extra deps)
function generateVerifier() {
  return crypto.randomBytes(40).toString("hex"); // 80-char hex → >256 bits
}

function generateChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url"); // base64url without padding
}

function generateState() {
  return crypto.randomBytes(20).toString("hex");
}

ipcMain.handle("start-oidc-login", async (event, { serverUrl }) => {
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);
  const state = generateState();

  // Use a dedicated, isolated session so OIDC cookies don't bleed into the
  // main app session and can be cleaned up completely afterwards.
  const oidcSession = session.fromPartition("persist:oidc-flow", {
    cache: false,
  });

  // Build the initial /auth/openid URL — ABS will 302-redirect to the IdP,
  // and after login the IdP posts back to /auth/openid/mobile-redirect which
  // in turn 302-redirects to abs2kindle://callback?code=…&state=…
  const authUrl = new URL(`${serverUrl}/auth/openid`);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", "abs2kindle://callback");
  authUrl.searchParams.set("client_id", "ABS2Kindle");
  authUrl.searchParams.set("state", state);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      // Clean up the OIDC session cookies so stale state never affects future flows.
      oidcSession.clearStorageData().catch(() => {});
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };

    const win = new BrowserWindow({
      width: 900,
      height: 700,
      parent: mainWindow,
      modal: true,
      autoHideMenuBar: true,
      webPreferences: {
        session: oidcSession,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // Intercept the abs2kindle://callback redirect that the ABS mobile-redirect
    // endpoint issues after the IdP logs the user in.
    win.webContents.on("will-navigate", (e, navUrl) => {
      if (!navUrl.startsWith("abs2kindle://callback")) return;
      e.preventDefault();
      handleCallback(navUrl);
    });

    // Electron also fires will-redirect for 302 responses; cover that path too.
    win.webContents.on("will-redirect", (e, navUrl) => {
      if (!navUrl.startsWith("abs2kindle://callback")) return;
      e.preventDefault();
      handleCallback(navUrl);
    });

    win.on("closed", () => {
      if (!settled) finish({ ok: false, error: "Login window was closed" });
    });

    win.loadURL(authUrl.toString()).catch((err) => {
      finish({ ok: false, error: err.message });
    });

    async function handleCallback(callbackUrl) {
      try {
        const parsed = new URL(callbackUrl);
        const returnedState = parsed.searchParams.get("state");
        const code = parsed.searchParams.get("code");

        if (returnedState !== state) {
          return finish({ ok: false, error: "OIDC state mismatch — possible CSRF" });
        }
        if (!code) {
          return finish({ ok: false, error: "No code received in callback" });
        }

        // Exchange the code for a token via /auth/openid/callback.
        // The session cookies from the /auth/openid request must accompany this
        // call — we pull them from the OIDC session's cookie store.
        const serverOrigin = new URL(serverUrl).origin;
        const cookieList = await oidcSession.cookies.get({ url: serverOrigin });
        const cookieHeader = cookieList
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");

        const tokenUrl = new URL(`${serverUrl}/auth/openid/callback`);
        tokenUrl.searchParams.set("state", state);
        tokenUrl.searchParams.set("code", code);
        tokenUrl.searchParams.set("code_verifier", verifier);

        const tokenResult = await new Promise((res, rej) => {
          const parsed2 = tokenUrl;
          const lib2 = parsed2.protocol === "https:" ? https : http;
          const req = lib2.request(
            {
              hostname: parsed2.hostname,
              port: parsed2.port || (parsed2.protocol === "https:" ? 443 : 80),
              path: parsed2.pathname + parsed2.search,
              method: "GET",
              headers: {
                Cookie: cookieHeader,
                Accept: "application/json",
              },
              rejectUnauthorized: false,
            },
            (r) => {
              let data = "";
              r.on("data", (c) => (data += c));
              r.on("end", () => {
                try {
                  res({ status: r.statusCode, body: JSON.parse(data) });
                } catch {
                  res({ status: r.statusCode, body: data });
                }
              });
            },
          );
          req.on("error", rej);
          req.end();
        });

        const token = tokenResult.body?.user?.token;
        if (!token) {
          const msg =
            typeof tokenResult.body === "string"
              ? tokenResult.body
              : (tokenResult.body?.error ?? `HTTP ${tokenResult.status}`);
          return finish({ ok: false, error: `Token exchange failed: ${msg}` });
        }

        finish({ ok: true, token });
      } catch (err) {
        finish({ ok: false, error: err.message });
      }
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
ipcMain.handle("detect-kindles", () => {
  // 1. GVFS / USB mass storage (GNOME and non-KDE)
  const found = findKindleMounts();
  if (found.length > 0) return found;

  // 2. KDE kmtpd D-Bus (no udev rule required)
  const kmtpd = findKmtpdDevices();
  if (kmtpd.length > 0) return kmtpd;

  // 3. jmtpfs FUSE (non-KDE fallback)
  const { execSync } = require("child_process");
  try {
    execSync("which jmtpfs", { stdio: "ignore" });
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
        epubPath = path.join(tmpDir, `${safeTitle}.epub`);
        await downloadFile(
          `${serverUrl}/api/items/${itemId}/ebook`,
          apiKey,
          epubPath,
        );

        // ── Step 3: convert EPUB → AZW3 ──────────────────────
        progress("converting", { title });
        azw3Path = path.join(tmpDir, `${safeTitle}.azw3`);
        convertEpubToAzw3(epubPath, azw3Path);
        fs.unlinkSync(epubPath);
        epubPath = null;

        // ── Step 4: inject real ASIN into AZW3 ───────────────
        if (asin) {
          injectAsinIntoAzw3(azw3Path, asin);
        } else {
          console.warn(
            `send-to-kindle: no ASIN for "${title}" — skipping injection`,
          );
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
        try {
          if (epubPath && fs.existsSync(epubPath)) fs.unlinkSync(epubPath);
        } catch (_) {}
        try {
          if (azw3Path && fs.existsSync(azw3Path)) fs.unlinkSync(azw3Path);
        } catch (_) {}

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
  const { execSync, spawn } = require("child_process");
  const BOOK_EXTS = [".epub", ".mobi", ".azw3", ".azw", ".pdf"];

  // Annotate a filename with its ASIN (read from the file if path is accessible).
  const annotate = (filename, dirPath) => {
    let asin = null;
    if (dirPath && /\.(azw3|mobi|azw)$/i.test(filename)) {
      asin = readAsinFromAzw3(path.join(dirPath, filename));
    }
    return { filename, asin };
  };

  // For kmtpd devices: spawn kioclient5 cat directly (no shell, so special
  // characters in filenames are safe), collect at most 64 KB of stdout, then
  // parse the ASIN from the EXTH header.
  const annotateViaKio = (filename, kioDocumentsUri) => {
    if (!/\.(azw3|mobi|azw)$/i.test(filename))
      return Promise.resolve({ filename, asin: null });
    const kioUri = `${kioDocumentsUri}/${filename}`;
    return new Promise((resolve) => {
      const chunks = [];
      let total = 0;
      const MAX = 65536;
      const child = spawn("kioclient5", ["--noninteractive", "cat", kioUri], {
        timeout: 15000,
      });
      child.stdout.on("data", (chunk) => {
        if (total >= MAX) return;
        const remaining = MAX - total;
        chunks.push(chunk.slice(0, remaining));
        total += Math.min(chunk.length, remaining);
        if (total >= MAX) {
          // We have enough — kill the child so it doesn't stream the whole file
          child.kill();
        }
      });
      const finish = () => {
        const buf = Buffer.concat(chunks);
        const asin = readAsinFromBuffer(buf);
        console.log(`annotateViaKio: ${filename} → asin=${asin}`);
        resolve({ filename, asin });
      };
      child.on("close", finish);
      child.on("error", (e) => {
        console.warn(`annotateViaKio: spawn error for ${filename}:`, e.message);
        resolve({ filename, asin: null });
      });
    });
  };

  try {
    if (device.via === "kmtpd") {
      const lsOut = execSync(
        `kioclient5 --noninteractive ls "${device.kioDocumentsUri}"`,
        { encoding: "utf8", timeout: 8000 },
      );
      const filenames = lsOut
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => BOOK_EXTS.some((ext) => l.toLowerCase().endsWith(ext)));
      // Run sequentially — kmtpd handles one MTP operation at a time; concurrent
      // kioclient5 calls against the same device corrupt each other's responses.
      const files = [];
      for (const filename of filenames) {
        files.push(await annotateViaKio(filename, device.kioDocumentsUri));
      }
      return { ok: true, files };
    } else {
      // Direct filesystem access (GVFS / USB) — read ASIN from each AZW3/MOBI.
      const files = fs
        .readdirSync(device.documentsPath)
        .filter((f) => BOOK_EXTS.some((ext) => f.toLowerCase().endsWith(ext)))
        .map((filename) => annotate(filename, device.documentsPath));
      return { ok: true, files };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("delete-kindle-book", async (_, { device, filename }) => {
  const { execSync } = require("child_process");

  // Reject path traversal attempts
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return { ok: false, error: "Invalid filename" };
  }

  try {
    if (device.via === "kmtpd") {
      const kioUri = `${device.kioDocumentsUri}/${filename}`;
      execSync(`kioclient5 --noninteractive remove "${kioUri}"`, {
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
