# Changelog

All notable changes to ABS2Kindle are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions correspond to git tags.

---

## [v0.2.2] — 2026-03-14

### Added
- MOBI format support — MOBI files from ABS are now transferred to Kindle alongside EPUB/AZW3
- Filetype detection on download: the actual file extension returned by ABS is inspected instead of assuming EPUB

---

## [v0.2.1] — 2026-03-14

### Added
- **Windows MTP support** — Kindle detection and file transfer via `Shell.Application` COM on Windows; no extra drivers required
- Library search, sort (date added / title / author), and filter (all / has ASIN / missing ASIN) toolbar
- Background ASIN resolution for Windows MTP: `kindle-asin-resolved` event updates badges without blocking the UI
- ASIN cache persisted to `kindle-asin-cache.json` between sessions (Windows MTP)
- `npm run start:windows` dev script

### Fixed
- KDE/kmtpd: incorrect destination filenames when copying to Kindle Documents folder
- Various Windows-specific startup and dev-mode issues

### Changed
- EPUB → AZW3 conversion is now fully async (`execFile` wrapped in a Promise); main thread stays responsive during Calibre conversion
- Transfer pipeline processes up to 3 books concurrently; the Kindle write step is serialised to avoid MTP contention

---

## [v0.1.1] — 2026-03-14

### Added
- RPM (Fedora/RHEL) and Pacman (Arch) build targets in CI
- Flatpak manifest (`build/flatpak/`) and desktop entry for distribution via Flathub
- Build assets reorganised under `build/` directory

---

## [v0.1.0] — 2026-03-14

### Added
- Transfer progress overlay with per-book status badges (`downloading` → `converting` → `copying` → `done` / `error`)
- Concurrent transfers: up to 3 books can be processed simultaneously
- Home view showing the library grid on launch
- ASIN badge and "on Kindle" badge on book cards
- Search query is preserved when switching views or refreshing the library

### Changed
- UI polish pass: layout, spacing, and colour refinements across the app

---

## [v0.0.2] — 2026-03-13

### Added
- OIDC / SSO authentication support (experimental; superseded by API-key-only auth in later releases)

---

## [v0.0.1] — 2026-03-13

### Added
- Initial release
- Connect to an Audiobookshelf server using a server URL + API key
- Browse ebook libraries and display book covers / metadata
- Kindle detection: GVFS FUSE (GNOME), kmtpd D-Bus (KDE), jmtpfs FUSE fallback
- EPUB → AZW3 conversion via Calibre `ebook-convert`
- In-place ASIN injection into AZW3 EXTH header (enables Whispersync / library matching on device)
- List books currently on Kindle Documents folder
- Delete a book from the Kindle directly from the app
- Custom frameless window with titlebar (minimize / maximize / close)
- Settings panel: server URL + API key, connection test button
- Linux protocol handler (`abs2kindle://`) registered via `.desktop` file

---

[v0.2.2]: https://github.com/TheSingularis/ABS2Kindle/releases/tag/v0.2.2
[v0.2.1]: https://github.com/TheSingularis/ABS2Kindle/releases/tag/v0.2.1
[v0.1.1]: https://github.com/TheSingularis/ABS2Kindle/releases/tag/v0.1.1
[v0.1.0]: https://github.com/TheSingularis/ABS2Kindle/releases/tag/v0.1.0
[v0.0.2]: https://github.com/TheSingularis/ABS2Kindle/releases/tag/v0.0.2
[v0.0.1]: https://github.com/TheSingularis/ABS2Kindle/releases/tag/v0.0.1
