# Flatpak Packaging

## Files

| File | Purpose |
|------|---------|
| `com.abs2kindle.ABS2Kindle.yml` | Flatpak manifest |
| `com.abs2kindle.ABS2Kindle.desktop` | Desktop entry |
| `com.abs2kindle.ABS2Kindle.metainfo.xml` | AppStream metadata (required by Flathub) |
| `com.abs2kindle.ABS2Kindle.png` | 256×256 app icon (add manually) |
| `generated-sources.json` | Offline npm sources (generated — see below) |

## Prerequisites

```bash
pip install flatpak-node-generator
flatpak install flathub org.freedesktop.Sdk//24.08
flatpak install flathub org.electronjs.Electron2.BaseApp//24.08
```

## Generate offline npm sources

Flatpak builds have no network access, so all npm dependencies must be
pre-fetched into `generated-sources.json`. Re-run this whenever
`package-lock.json` changes:

```bash
flatpak-node-generator npm package-lock.json -o build/flatpak/generated-sources.json
```

## Local test build

```bash
flatpak-builder --force-clean build-dir build/flatpak/com.abs2kindle.ABS2Kindle.yml
flatpak-builder --run build-dir build/flatpak/com.abs2kindle.ABS2Kindle.yml abs2kindle
```

## Submitting to Flathub

1. Add the app icon at `flatpak/com.abs2kindle.ABS2Kindle.png` (256×256 PNG)
2. Run `flatpak-node-generator` to produce `generated-sources.json`
3. Fork [flathub/flathub](https://github.com/flathub/flathub) on GitHub
4. Create a new branch named `com.abs2kindle.ABS2Kindle`
5. Add all files from this directory to the root of that branch
6. Open a pull request — Flathub bot will run a validation build
7. Once approved, Flathub maintainers merge and the app appears in
   GNOME Software / KDE Discover automatically

See: https://docs.flathub.org/docs/for-app-authors/submission
