# ABS2Kindle — Copilot Instructions

## Project

Electron app that connects an Audiobookshelf (ABS) server to a Kindle.
Think knockoff iTunes for ABS → Kindle: browse the library, select audiobooks/ebooks, send to a detected Kindle device.

## Stack

- **Runtime**: System Electron (`/run/current-system/sw/bin/electron`)
- **Entry**: `src/main.js`
- **Renderer**: `src/renderer/index.html` + `src/renderer/app.js` + `src/renderer/style.css`
- **Preload bridge**: `src/preload.js` (context-isolated, `window.api`)
- **Build**: `electron-builder` — targets AppImage/deb (Linux) and NSIS (Windows)
- **Dev run**: `npm start` → `electron "$PWD"`
- **Kindle transport (KDE/MTP)**: `kioclient5` + kmtpd D-Bus (primary on KDE); GVFS FUSE (GNOME); `jmtpfs` FUSE (non-KDE fallback)

## File Map

| File                      | Role                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/main.js`             | Main process: window, IPC handlers, settings, Kindle detection, file transfer, Linux protocol handler |
| `src/preload.js`          | Exposes `window.api` to renderer via `contextBridge`                                                  |
| `src/renderer/app.js`     | Renderer logic: navigation, settings form, library UI, Kindle sidebar, transfer progress              |
| `src/renderer/index.html` | App shell: titlebar, sidebar, library grid, settings panel                                            |
| `src/renderer/style.css`  | Styles (includes `.device-busy` / `.device-busy-hint` for busy-device state)                          |

## Authentication

**API key only.** There is no OAuth/OIDC flow.

- User enters `serverUrl` + `apiKey` in Settings
- Saved to `settings.json` via `save-settings` IPC → `saveSettings()`
- `test-connection` IPC hits `{serverUrl}/api/libraries` with `Authorization: Bearer <apiKey>` using Node `http`/`https`
- No `crypto`, no `net: electronNet`, no OIDC session state anywhere in the codebase

## Settings Storage

- Path: `app.getPath("userData")/settings.json`
- Shape: `{ serverUrl, apiKey }`
- Loaded at startup via `loadSettings()`, merged on save via `saveSettings(data)`

## `window.api` surface (preload.js)

```js
ping(); // → "pong"
windowMinimize();
windowMaximize();
windowClose();

// Settings
getSettings(); // → settingsStore object
saveSettings(data); // → { ok: true }
testConnection({ serverUrl, apiKey }); // → { ok, count } | { ok: false, error }

// Library
getLibraries(); // → { ok, libraries } | { ok: false, error }
getBooks({ libraryId }); // → { ok, books } | { ok: false, error }

// Kindle
detectKindles(); // → [ deviceObject, ... ]
sendToKindle({ itemIds, kindleDocumentsPath, device }); // → { results: [...] }
onTransferProgress(callback); // registers listener for "transfer-progress" events; returns unsubscribe fn
```

## IPC Handlers (main.js)

| Channel             | Type         | Notes                                                                         |
| ------------------- | ------------ | ----------------------------------------------------------------------------- |
| `ping`              | handle       | returns `"pong"`                                                              |
| `get-settings`      | handle       | returns in-memory `settingsStore`                                             |
| `save-settings`     | handle       | merges + writes `settings.json`                                               |
| `test-connection`   | handle       | GET `/api/libraries` with Bearer token                                        |
| `get-libraries`     | handle       | GET `/api/libraries` — returns `{ ok, libraries }`                            |
| `get-books`         | handle       | GET `/api/libraries/:id/items` — returns `{ ok, books }`                      |
| `detect-kindles`    | handle       | 3-tier detection: GVFS → kmtpd → jmtpfs                                       |
| `send-to-kindle`    | handle       | downloads EPUB to tmp, calls `copyToKindle`, emits `transfer-progress` events |
| `transfer-progress` | send (event) | main → renderer; payload `{ itemId, status, name?, error? }`                  |
| `window-minimize`   | on           | minimize focused window                                                       |
| `window-maximize`   | on           | toggle maximize on focused window                                             |
| `window-close`      | on           | close focused window                                                          |

### Transfer progress `status` values

| Status             | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `downloading`      | Fetching EPUB from ABS server                              |
| `copying`          | Writing file to Kindle                                     |
| `done`             | File confirmed on device                                   |
| `error`            | Generic failure                                            |
| `dolphin-blocking` | Non-KDE: file manager holds MTP device; user must close it |

## Kindle Detection — 3-Tier Chain (`detect-kindles`)

Detection runs in priority order; first non-empty result wins:

| Tier | Function              | Works On                                                                       |
| ---- | --------------------- | ------------------------------------------------------------------------------ |
| 1    | `findKindleMounts()`  | GVFS FUSE (`/run/user/<uid>/gvfs/`) + USB mass storage + Windows drive letters |
| 2    | `findKmtpdDevices()`  | KDE — queries `org.kde.kiod6` D-Bus (kmtpd module)                             |
| 3    | `findJmtpfsDevices()` | Non-KDE Linux — mounts via `jmtpfs` FUSE                                       |

### `findKmtpdDevices()` detail

- D-Bus service: `org.kde.kiod6`, object paths `/modules/kmtpd/device0`, `/modules/kmtpd/device0/storage0`
- Reads `org.kde.kmtp.Device.friendlyName` and `org.kde.kmtp.Storage.description` via `dbus-send`
- Builds `kioDocumentsUri = "mtp:/<friendlyName>/<storageName>/documents"`
- Verifies `documents/` exists with `kioclient5 ls <kioDocumentsUri>`
- Returns `{ name, storageName, documentsPath, kioDocumentsUri, bookCount, via: "kmtpd" }`

### Device object shapes

```js
// kmtpd (KDE)
{ name, storageName, documentsPath, kioDocumentsUri, bookCount, via: "kmtpd" }

// GVFS / USB / jmtpfs
{ name, path, documentsPath, bookCount }   // built by buildDeviceEntry()
```

## Transfer Pipeline — `send-to-kindle` handler

Each item goes through 5 steps in sequence. Progress events are emitted between steps.

```
1. absRequest items/:id          → fetch metadata (title, ASIN)
2. GET /api/items/:id/ebook      → download EPUB to /tmp
3. convertEpubToAzw3()           → ebook-convert epub → azw3 (--output-profile=kindle_pw3)
4. injectAsinIntoAzw3()          → overwrite EXTH type-113 in-place with real ASIN (null-padded)
5. copyToKindle()                → transfer .azw3 to Kindle documents folder
```

- If the item has no ASIN in ABS metadata, conversion still proceeds but ASIN injection is skipped (warning logged)
- Calibre (`ebook-convert`) must be installed; throws if not found
- The AZW3 is what lands on the Kindle — never a raw EPUB
- See `.vscode/notes/azw3-asin-injection.md` for the in-place patch rationale

### Transfer progress `status` values

| Status             | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `downloading`      | Fetching metadata + EPUB from ABS server                   |
| `converting`       | Running ebook-convert EPUB → AZW3                          |
| `copying`          | Writing AZW3 to Kindle                                     |
| `done`             | File confirmed transferred                                 |
| `error`            | Generic failure                                            |
| `dolphin-blocking` | Non-KDE: file manager holds MTP device; user must close it |

## Linux Protocol Handler

`registerLinuxProtocol()` in `src/main.js` writes two files on startup (Linux only):

- `~/.local/share/applications/abs2kindle-url-handler.sh` — shell wrapper that forwards `abs2kindle://` URLs to the running app via a Unix socket (`/tmp/abs2kindle.sock`) using `socat`, `node net`, or `nc`
- `~/.local/share/applications/abs2kindle.desktop` — registers `x-scheme-handler/abs2kindle` MIME type pointing at the wrapper

The `.desktop` `Exec` line always invokes the wrapper script — no dev/prod split needed since the wrapper is launch-method agnostic.

> **Note**: The protocol handler exists as infrastructure for future features. It is not currently used for auth.

## UI Structure

```
#titlebar        drag region, search bar, WM buttons (min/max/close)
#sidebar
  #nav-library   → shows #view-library
  #nav-settings  → shows #view-settings
  #devices-section  Kindle device list + refresh button
    .device-entry       normal detected device
    .device-busy        device held by file manager (non-KDE only)
#content
  #view-library  #book-grid
  #view-settings
    #settings-form
      #input-url      server URL
      #auth-apikey
        #input-apikey
        #btn-save / #btn-test / #test-result
#bottombar       selection label + "Send to Kindle" button
```

## Key Conventions

- Frameless window (`frame: false`); custom titlebar handles WM actions
- `contextIsolation: true`, `nodeIntegration: false` — all Node access goes through preload
- `app.commandLine.appendSwitch("disable-gpu-vsync")` suppresses VSync log noise
- `requestSingleInstanceLock()` enforced — second instance quits immediately
- `http`/`https` used for outbound requests (not `electron.net`); `rejectUnauthorized: false` on `test-connection` to tolerate self-signed certs
- **Never kill `kiod6`** — it owns the USB MTP interface on KDE; killing it drops the Kindle connection entirely
- No udev rules required — `kioclient5` works within the existing KDE MTP session
