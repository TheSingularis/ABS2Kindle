const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// Store verifier temporarily between steps
// Persisted to disk so it survives the process being killed and relaunched by the OS protocol handler
let pendingOidcVerifier = null;
const OIDC_PENDING_PATH = path.join(
  os.tmpdir(),
  "abs2kindle-oidc-pending.json",
);

function savePendingOidc(data) {
  pendingOidcVerifier = data;
  try {
    fs.writeFileSync(OIDC_PENDING_PATH, JSON.stringify(data));
  } catch {}
}

function loadPendingOidc() {
  try {
    if (fs.existsSync(OIDC_PENDING_PATH))
      pendingOidcVerifier = JSON.parse(
        fs.readFileSync(OIDC_PENDING_PATH, "utf8"),
      );
  } catch {
    pendingOidcVerifier = null;
  }
}

function clearPendingOidc() {
  pendingOidcVerifier = null;
  try {
    fs.unlinkSync(OIDC_PENDING_PATH);
  } catch {}
}

function base64URLEncode(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

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
function exchangeCodeForToken(serverUrl, code, codeVerifier) {
  const http = require("http");
  const https = require("https");

  return new Promise((resolve, reject) => {
    const url = new URL(`${serverUrl}/auth/openid/callback`);
    url.searchParams.set("code", code);
    url.searchParams.set("code_verifier", codeVerifier);

    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Bad response from server"));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function handleAuthCallback(url) {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code");
    const error = parsed.searchParams.get("error");
    const returnedState = parsed.searchParams.get("state");

    if (error) {
      mainWindow?.webContents.send("oidc-error", error);
      return;
    }

    if (!code || !pendingOidcVerifier) {
      mainWindow?.webContents.send("oidc-error", "Missing code or verifier");
      return;
    }

    const { verifier, serverUrl, state } = pendingOidcVerifier;

    if (returnedState !== state) {
      clearPendingOidc();
      mainWindow?.webContents.send("oidc-error", "State parameter mismatch");
      return;
    }

    clearPendingOidc();

    // Exchange code for token
    const result = await exchangeCodeForToken(serverUrl, code, verifier);

    if (result?.user?.token) {
      saveSettings({ apiKey: result.user.token, authMethod: "oidc" });
      mainWindow?.webContents.send("oidc-success", {
        token: result.user.token,
        username: result.user.username,
      });
    } else {
      mainWindow?.webContents.send("oidc-error", "No token in response");
    }
  } catch (e) {
    mainWindow?.webContents.send("oidc-error", e.message);
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
  // Generate PKCE pair
  const verifier = base64URLEncode(crypto.randomBytes(32));
  const challenge = base64URLEncode(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  const state = base64URLEncode(crypto.randomBytes(16));

  pendingOidcVerifier = { verifier, serverUrl, state };
  savePendingOidc({ verifier, serverUrl, state });
  const params = new URLSearchParams({
    redirect_uri: "abs2kindle://auth",
    client_id: "ABS2Kindle",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  const url = `${serverUrl}/auth/openid?${params.toString()}`;
  console.log("Opening OIDC URL:", url);
  shell.openExternal(url);
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

// On Linux, setAsDefaultProtocolClient requires a registered .desktop file.
// We write one at runtime so the OS can dispatch abs2kindle:// URLs back to us.
function registerLinuxProtocol() {
  if (process.platform !== "linux") return;
  const { execSync } = require("child_process");
  const desktopDir = path.join(os.homedir(), ".local", "share", "applications");
  const desktopPath = path.join(desktopDir, "abs2kindle.desktop");
  const exec = process.execPath; // path to the electron binary
  const appPath = path.resolve(__dirname, "..");

  const contents =
    [
      "[Desktop Entry]",
      "Name=ABS2Kindle",
      "Type=Application",
      `Exec=${exec} ${appPath} %u`,
      "MimeType=x-scheme-handler/abs2kindle;",
      "NoDisplay=true",
    ].join("\n") + "\n";

  try {
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(desktopPath, contents);
    execSync(
      `xdg-mime default abs2kindle.desktop x-scheme-handler/abs2kindle`,
      { stdio: "ignore" },
    );
    execSync(`update-desktop-database ${desktopDir}`, { stdio: "ignore" });
  } catch (e) {
    console.error("Failed to register protocol handler:", e.message);
  }
}

app.whenReady().then(() => {
  registerLinuxProtocol();
  loadSettings();
  loadPendingOidc();
  createWindow();

  // Handle protocol callback on the initial launch (e.g. when no prior instance was running)
  const callbackUrl = process.argv.find((arg) =>
    arg.startsWith("abs2kindle://"),
  );
  if (callbackUrl) handleAuthCallback(callbackUrl);
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
