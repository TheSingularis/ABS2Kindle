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

## File Map

| File | Role |
|---|---|
| `src/main.js` | Main process: window, IPC handlers, settings, Linux protocol handler |
| `src/preload.js` | Exposes `window.api` to renderer via `contextBridge` |
| `src/renderer/app.js` | Renderer logic: navigation, settings form, library UI |
| `src/renderer/index.html` | App shell: titlebar, sidebar, library grid, settings panel |
| `src/renderer/style.css` | Styles |

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
ping()                               // → "pong"
windowMinimize()
windowMaximize()
windowClose()
getSettings()                        // → settingsStore object
saveSettings(data)                   // → { ok: true }
testConnection({ serverUrl, apiKey }) // → { ok, count } | { ok: false, error }
```

## IPC Handlers (main.js)

| Channel | Type | Notes |
|---|---|---|
| `ping` | handle | returns `"pong"` |
| `get-settings` | handle | returns in-memory `settingsStore` |
| `save-settings` | handle | merges + writes `settings.json` |
| `test-connection` | handle | GET `/api/libraries` with Bearer token |
| `window-minimize` | on | minimize focused window |
| `window-maximize` | on | toggle maximize on focused window |
| `window-close` | on | close focused window |

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
