# ABS2Kindle — Copilot Instructions

## General Rules

- **Always update `README.md`** after any major changes (new features, changed behaviour, updated setup steps, new dependencies, etc.).
- **On every release / version tag**, always:
  1. Update `CHANGELOG.md` — add a new `## [vX.Y.Z] — YYYY-MM-DD` block at the top with all changes grouped under `Added`, `Fixed`, `Changed`, `Removed`; add a reference link at the bottom.
  2. **Write changelog entries for end users, not developers.** Describe what the user sees or experiences — never mention internal implementation details (class names, function names, architectural patterns, CSS properties, etc.). Ask: _"would a non-technical user find this meaningful?"_
  3. Commit the changelog before or alongside the tag.
  4. Write a **verbose GitHub release body** that includes every `Added` / `Fixed` / `Changed` / `Removed` item from that version's changelog section — never just a one-liner.

## Project

Electron app that connects an Audiobookshelf (ABS) server to a Kindle.
Think knockoff iTunes for ABS → Kindle: browse the library, select audiobooks/ebooks, send to a detected Kindle device.

## Stack

- **Runtime**: System Electron (`/run/current-system/sw/bin/electron`)
- **Entry**: `src/main.js`
- **Renderer**: `src/renderer/index.html` + `src/renderer/app.js` + `src/renderer/style.css`
- **Preload bridge**: `src/preload.js` (context-isolated, `window.api`)
- **Build**: `electron-builder` — targets AppImage/deb (Linux) and NSIS (Windows)
- **Dev run**: `npm start` → `electron "$PWD"` (Linux); `npm run start:windows` → `electron .` (Windows)
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
- **ASIN cache**: `app.getPath("userData")/kindle-asin-cache.json` — maps `filename → asin` for Windows MTP devices; written after successful transfer, evicted on delete, persisted across sessions

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
listKindleBooks({ device }); // → { ok, files: [{ filename, asin }] }
deleteKindleBook({ device, filename }); // → { ok } | { ok: false, error }
onTransferProgress(callback); // registers listener for "transfer-progress" events; returns unsubscribe fn
onKindleAsinResolved(callback); // registers listener for "kindle-asin-resolved" events (Windows MTP background resolution); returns unsubscribe fn
```

## IPC Handlers (main.js)

| Channel                | Type         | Notes                                                                                                                                                       |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`                 | handle       | returns `"pong"`                                                                                                                                            |
| `get-settings`         | handle       | returns in-memory `settingsStore`                                                                                                                           |
| `save-settings`        | handle       | merges + writes `settings.json`                                                                                                                             |
| `test-connection`      | handle       | GET `/api/libraries` with Bearer token                                                                                                                      |
| `get-libraries`        | handle       | GET `/api/libraries` — returns `{ ok, libraries }`                                                                                                          |
| `get-books`            | handle       | GET `/api/libraries/:id/items` — returns `{ ok, books }`                                                                                                    |
| `detect-kindles`       | handle       | Windows: Shell.Application COM; Linux: GVFS → kmtpd → jmtpfs                                                                                                |
| `list-kindle-books`    | handle       | Lists books on connected Kindle; Windows MTP returns cached ASINs and kicks off background resolution                                                       |
| `delete-kindle-book`   | handle       | Deletes a book from Kindle by filename; evicts ASIN cache on Windows MTP                                                                                    |
| `send-to-kindle`       | handle       | downloads EPUB to tmp, converts, copies to Kindle; up to 3 books processed concurrently (steps 1–4), copy step serialised; emits `transfer-progress` events |
| `transfer-progress`    | send (event) | main → renderer; payload `{ itemId, status, name?, error? }`                                                                                                |
| `kindle-asin-resolved` | send (event) | main → renderer (Windows MTP only); payload `{ filename, asin }` as background resolution completes                                                         |
| `window-minimize`      | on           | minimize focused window                                                                                                                                     |
| `window-maximize`      | on           | toggle maximize on focused window                                                                                                                           |
| `window-close`         | on           | close focused window                                                                                                                                        |

### Transfer progress `status` values

| Status             | Meaning                                                    |
| ------------------ | ---------------------------------------------------------- |
| `downloading`      | Fetching EPUB from ABS server                              |
| `copying`          | Writing file to Kindle                                     |
| `done`             | File confirmed on device                                   |
| `error`            | Generic failure                                            |
| `dolphin-blocking` | Non-KDE: file manager holds MTP device; user must close it |

## Kindle Detection

Detection is platform-aware. On Windows, Shell.Application COM is used. On Linux, the 3-tier chain runs in priority order; first non-empty result wins:

| Tier | Platform | Function                    | Works On                                               |
| ---- | -------- | --------------------------- | ------------------------------------------------------ |
| —    | Windows  | `findKindleMountsWindows()` | Windows — Shell.Application enumerates MTP devices     |
| 1    | Linux    | `findKindleMounts()`        | GVFS FUSE (`/run/user/<uid>/gvfs/`) + USB mass storage |
| 2    | Linux    | `findKmtpdDevices()`        | KDE — queries `org.kde.kiod6` D-Bus (kmtpd module)     |
| 3    | Linux    | `findJmtpfsDevices()`       | Non-KDE Linux — mounts via `jmtpfs` FUSE               |

### `findKmtpdDevices()` detail

- D-Bus service: `org.kde.kiod6`, object paths `/modules/kmtpd/device0`, `/modules/kmtpd/device0/storage0`
- Reads `org.kde.kmtp.Device.friendlyName` and `org.kde.kmtp.Storage.description` via `dbus-send`
- Builds `kioDocumentsUri = "mtp:/<friendlyName>/<storageName>/documents"`
- Verifies `documents/` exists with `kioclient5 ls <kioDocumentsUri>`
- Returns `{ name, storageName, documentsPath, kioDocumentsUri, bookCount, via: "kmtpd" }`

### Device object shapes

```js
// Windows MTP (Shell.Application)
{ name, deviceName, storageName, isMtpWindows: true, documentsPath: null, bookCount }

// kmtpd (KDE)
{ name, storageName, documentsPath, kioDocumentsUri, bookCount, via: "kmtpd" }

// GVFS / USB / jmtpfs
{ name, path, documentsPath, bookCount }   // built by buildDeviceEntry()
```

**Windows note**: `documentsPath` is `null` for Windows MTP devices. All file ops go through PowerShell + `Shell.Application` COM. All user-supplied strings interpolated into PowerShell scripts must be escaped with `psEsc = (s) => s.replace(/'/g, "''")`.

## Transfer Pipeline — `send-to-kindle` handler

Up to 3 books are processed concurrently through steps 1–4. Step 5 (copy) is always serialised — only one Kindle write runs at a time. Progress events are emitted per-book as each step completes.

```
Per book (up to 3 concurrent):
1. absRequest items/:id          → fetch metadata (title, ASIN)
2. GET /api/items/:id/ebook      → download EPUB to /tmp/abs2k_<itemId>.epub
3. convertEpubToAzw3()           → ebook-convert epub → azw3 (--output-profile=kindle_pw3) [async — non-blocking]
4. injectAsinIntoAzw3()          → overwrite EXTH type-113 in-place with real ASIN (null-padded)

Serial copy gate (one at a time):
5. copyToKindle()                → transfer .azw3 to Kindle documents folder
```

- `convertEpubToAzw3` is **async** (wraps `execFile` in a Promise) — the main thread stays responsive during conversion
- On Windows: the tmp file is renamed to `<safeTitle>.azw3` before `CopyHere` (Shell.Application always uses source filename), then renamed back for cleanup

- Tmp files are named `abs2k_<itemId>.epub/.azw3` to avoid collisions between concurrent tasks
- If the item has no ASIN in ABS metadata, conversion still proceeds but ASIN injection is skipped (warning logged)
- Calibre (`ebook-convert`) must be installed; throws if not found
- The AZW3 is what lands on the Kindle — never a raw EPUB
- If a dolphin-blocking error occurs during copy, `abortCopies` is set and all pending copy-queue entries are skipped
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
#titlebar        drag region, WM buttons (min/max/close)
#sidebar
  #nav-library   → shows #view-library
  #nav-settings  → shows #view-settings
  #devices-section  Kindle device list + refresh button
    .device-entry       normal detected device
    .device-busy        device held by file manager (non-KDE only)
#content
  #view-library
    #library-toolbar   sticky toolbar (top of library view)
      #search          text search
      #sort-by         select: date added / title / author
      #filter-by       select: all / has ASIN / missing ASIN
    #book-grid
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
- `requestSingleInstanceLock()` enforced — second instance quits immediately; kill leftover `electron.exe` processes before re-launching on Windows
- `http`/`https` used for outbound requests (not `electron.net`); `rejectUnauthorized: false` on `test-connection` to tolerate self-signed certs
- **Never kill `kiod6`** — it owns the USB MTP interface on KDE; killing it drops the Kindle connection entirely
- No udev rules required — `kioclient5` works within the existing KDE MTP session
- **PowerShell escaping**: all user/device strings interpolated into PS scripts must go through `psEsc = (s) => s.replace(/'/g, "''")` (single-quote doubling for PS single-quoted strings)
- **Library filtering**: `applyFilters()` in `app.js` is the single entry point for re-rendering the book grid — call it instead of dispatching synthetic `input` events on `#search`
