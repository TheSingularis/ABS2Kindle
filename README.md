# ABS2Kindle

Send ebooks from your [Audiobookshelf](https://www.audiobookshelf.org/) library directly to a connected Kindle.

## Features

- Browse your ABS library and select books to send
- Auto-detects connected Kindle devices
- Transfers EPUB files directly to the Kindle's documents folder

## Requirements

### Runtime

- [Electron](https://www.electronjs.org/) — must be available on `PATH` or set in `package.json`

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
3. Open **Settings**, enter your Audiobookshelf server URL and API key, and click **Save**
4. Plug in your Kindle and click **↻ Refresh** in the Devices panel

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
