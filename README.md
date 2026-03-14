# ABS2Kindle

Send ebooks from your [Audiobookshelf](https://www.audiobookshelf.org/) library directly to a connected Kindle.

## Features

- **Home page** — personalized shelves mirroring the ABS Home view: Continue Series, Recently Added, Recent Series, Discover, Read Again, and Newest Authors (requires an authenticated session; shelves populate as you use ABS)
- Browse your ABS library and select books to send
- Auto-detects connected Kindle devices (KDE, GNOME, and other Linux desktops)
- Converts EPUB → AZW3 via Calibre ebook-convert before transfer
- Injects the book's ASIN into the AZW3 so it matches your Kindle library
- Transfers the AZW3 directly to the Kindle's documents folder

## Requirements

### Runtime

- [Electron](https://www.electronjs.org/) — must be available on `PATH` or set in `package.json`
- [Calibre](https://calibre-ebook.com/) (`ebook-convert`) — required for EPUB → AZW3 conversion

| Distro | Command |
|---|---|
| Arch / Manjaro | `sudo pacman -S calibre` |
| Debian / Ubuntu | `sudo apt install calibre` |
| Fedora | `sudo dnf install calibre` |
| NixOS | Add `calibre` to `environment.systemPackages`, then `sudo nixos-rebuild switch` |

### Kindle detection (Linux)

Kindles connect via MTP. ABS2Kindle tries three detection methods in order, automatically:

| Priority | Method | Works on |
|---|---|---|
| 1 | GVFS FUSE mount | GNOME and most non-KDE desktops |
| 2 | KDE `kmtpd` D-Bus + `kioclient5` | KDE Plasma (no extra config needed) |
| 3 | `jmtpfs` FUSE mount | Any desktop, if `jmtpfs` is installed |

**KDE users**: no configuration required. The app talks directly to KDE's own MTP daemon (`kmtpd`) over D-Bus and copies files using `kioclient5`, which is part of the standard KDE install.

**Non-KDE users** (GNOME, XFCE, etc.): the app reads the GVFS mount at `/run/user/<uid>/gvfs/`. If that isn't available, install `jmtpfs` as a fallback.

#### Installing `jmtpfs` (non-KDE fallback only)

| Distro | Command |
|---|---|
| Arch / Manjaro | `sudo pacman -S jmtpfs` |
| Debian / Ubuntu | `sudo apt install jmtpfs` |
| Fedora | `sudo dnf install jmtpfs` |
| NixOS | Add `jmtpfs` to `environment.systemPackages` in `configuration.nix`, then `sudo nixos-rebuild switch` |

## Setup

1. Clone the repo and install JS dependencies:
   ```sh
   git clone https://github.com/TheSingularis/ABS2Kindle
   cd ABS2Kindle
   npm install
   ```
2. Run:
   ```sh
   npm start
   ```
3. Open **Settings**, enter your Audiobookshelf server URL and choose an auth method:

   The **Server URL** field auto-saves after you stop typing — a green ✓ badge confirms it was saved. If the URL doesn't respond as a valid ABS server, a red ✗ badge is shown and the URL is not saved.

   **API Key** (default)
   - Paste your ABS API key into the *API Key* field and click **Save**
   - You can find your key in ABS → Config → Users → *your account*

   **OIDC / SSO**
   - Switch the toggle to *OIDC / SSO*
   - The server URL is saved automatically once validated; click **Sign in with SSO**
   - A browser window will open showing your server's login page
   - Log in as normal — the app captures the token automatically and saves it
   - The OIDC option is only available if your ABS server has OpenID Connect configured (ABS Settings → Authentication → OpenID Connect)

4. Plug in your Kindle and click **↻ Refresh** in the Devices panel

## Transfer Pipeline

When you send a book, ABS2Kindle runs these steps automatically:

1. **Fetch metadata** — retrieves title and ASIN from the ABS server
2. **Download EPUB** — downloads the ebook from ABS to a temp file
3. **Convert** — runs `ebook-convert` (Calibre) to produce an AZW3 optimised for Kindle Paperwhite (`--output-profile=kindle_pw3`)
4. **Inject ASIN** — patches the EXTH block of the AZW3 in-place so Kindle matches it to your library (skipped if the item has no ASIN in ABS)
5. **Copy to Kindle** — transfers the AZW3 to the Kindle's documents folder

Progress for each step is shown in the UI next to the book.

## Troubleshooting

**Kindle shows as "busy" (non-KDE only)**
Another process is holding the USB interface. This shouldn't happen on KDE since the app uses kmtpd directly. On other desktops, make sure no file manager has the device open.

**Transfer fails with "Dolphin may be holding the device"**
A Dolphin window is actively browsing the Kindle. Close it and try again — the app will retry automatically on the next send.

**Kindle not detected at all**
- Make sure the Kindle is unlocked and showing "Connected" on its screen
- Try unplugging and replugging, then click **↻ Refresh**
- KDE users: verify `kioclient5` is on your PATH (`which kioclient5`)
- Non-KDE users: verify `jmtpfs -l` lists the device

## Building

```sh
# Linux (AppImage + deb)
npm run build:linux

# Windows (NSIS installer)
npm run build:win
```

## Stack

- Electron (frameless window, context-isolated renderer)
- Plain HTML/CSS/JS — no frontend framework
- Node `http`/`https` for ABS API requests
- KDE: `kioclient5` + kmtpd D-Bus for Kindle access
- GNOME/other: GVFS FUSE mount or `jmtpfs`
