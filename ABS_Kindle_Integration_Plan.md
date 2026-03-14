# AudioBookshelf → Kindle Sideloading Tool
## Integration Plan — v1.0 · March 2026

---

## Overview

This document outlines the full integration plan for a tool that connects AudioBookshelf (ABS) to a Kindle Paperwhite via USB — functioning similarly to iTunes for ebooks. The goal is reliable cover display, correct library categorisation, and maximum Kindle feature support for sideloaded titles.

The approach leverages ABS's existing metadata infrastructure, the abs-tract custom provider for ASIN/ISBN enrichment, and careful ebook file preparation before MTP transfer to the Kindle.

---

## Architecture

### Components

- **AudioBookshelf (Docker)** — source library and metadata store
- **abs-tract** — custom ABS metadata provider (Goodreads + Kindle Store)
- **Your sideloading tool** — orchestrates conversion, metadata injection, and MTP transfer
- **Kindle Paperwhite 2024** — target device, connected via USB/MTP

### Data Flow

```
Book added to ABS
  → ABS scans embedded file metadata
  → abs-tract enriches with ISBN + ASIN
  → User initiates sync
  → Tool fetches metadata from ABS API
  → Tool converts and injects ASIN into file
  → Tool transfers via MTP
  → Kindle resolves cover from Amazon servers via ASIN
```

---

## Phase 1: AudioBookshelf & abs-tract Setup

### 1.1 Deploy abs-tract alongside ABS

abs-tract is a Docker service that exposes a custom metadata provider endpoint to ABS. It sources data from Goodreads (general metadata, ISBN) and the Kindle Store (ASIN, high-quality cover images).

Add to your existing `docker-compose.yml`:

```yaml
abs-tract:
  image: ghcr.io/ahobsonsayers/abs-tract:latest
  restart: unless-stopped
  ports:
    - "3006:3006"
```

### 1.2 Register abs-tract in ABS

- Open ABS → Settings → Metadata Tools
- Add custom provider URL: `http://abs-tract:3006` (or your host IP if not on the same Docker network)
- Set abs-tract as the default or preferred provider for ebook libraries

> ⚠️ abs-tract matches approximately 90% of libraries. Goodreads' search is imperfect — a small number of obscure titles may need manual ASIN entry.

### 1.3 Configure auto-match on scan

- ABS Settings → Libraries → [your ebook library] → Enable **Auto Match** on new additions
- This ensures that when a new book is added, ABS immediately runs the abs-tract match and stores ISBN + ASIN in the item's metadata without manual intervention

---

## Phase 2: Metadata Fields Your Tool Reads from ABS

Your tool queries the ABS REST API to retrieve the following fields per book before initiating a transfer. These fields are populated by abs-tract and available on each library item.

**API endpoint:** `GET /api/items/{libraryItemId}` — metadata is at `.media.metadata`

| Field | Description |
|---|---|
| `isbn` | ISBN-13 of the best available edition (from Goodreads via abs-tract) |
| `asin` | Kindle Store ASIN (from abs-tract's Kindle provider — used for cover lookup) |
| `title` | Book title (fallback identifier if ASIN is missing) |
| `authorName` | Author name (fallback identifier) |
| `coverPath` | Path to cover image cached by ABS (used as embedded cover fallback) |

---

## Phase 3: File Preparation Before Transfer

### 3.1 Format

Target format is **AZW3 (KF8)**. If the source file is EPUB, convert using Calibre's `ebook-convert` CLI or the `calibredb` Python bindings before injecting metadata. AZW3 has better Kindle compatibility than EPUB for sideloading.

### 3.2 ASIN injection into OPF metadata

This is the critical step. The ASIN must be written into the ebook's OPF metadata so the Kindle can find the correct cover from Amazon's servers.

For **EPUB2**, add to the OPF `<metadata>` block:
```xml
<dc:identifier opf:scheme="AMAZON">{ASIN}</dc:identifier>
```

For **EPUB3**:
```xml
<dc:identifier>urn:AMAZON:{ASIN}</dc:identifier>
```

### 3.3 File type flag: EBOK vs PDOC

Set the file type flag to **EBOK** (not PDOC). This tells the Kindle to treat the book as a store title, which enables cover lookup from Amazon's servers and places the book under the "Books" tab rather than "Docs".

> ⚠️ PDOC mode makes covers work via embedded image but loses Goodreads integration and puts the book in the Docs tab. EBOK + real ASIN is the better path for a polished experience.

### 3.4 Embed cover image as fallback

Even though the Kindle will fetch the cover from Amazon's servers via the ASIN, always embed the cover image inside the file itself. Use the high-resolution cover image from ABS (sourced from Kindle Store via abs-tract). This acts as a fallback if the device is offline at first scan.

For the **2024 Kindle Paperwhite**, target cover resolution is **1680×1264 pixels**.

---

## Phase 4: MTP Transfer

### 4.1 MTP protocol

The 2024 Kindle Paperwhite does not mount as a USB mass storage device — it uses MTP (Media Transfer Protocol). Your tool must use an MTP library:

- **Node.js:** `node-mtp` or `jmtp`
- **Python:** `pymtp` (wraps libmtp) or libmtp bindings
- **Cross-platform:** libmtp directly via FFI

> ⚠️ On macOS, the Kindle will not appear without additional MTP software (Android File Transfer or OpenMTP). Document this as a prerequisite for Mac users.

### 4.2 Transfer targets on device

- Book file → `Internal Storage/documents/`
- Cover thumbnail → `Internal Storage/system/thumbnails/`

### 4.3 Thumbnail filename format

The thumbnail file must be named correctly for the Kindle to associate it with the book:

```
thumbnail_{ASIN}_EBOK_portrait.jpg
```

Where `{ASIN}` matches exactly the ASIN injected into the OPF metadata. Transfer the book file and thumbnail in the same MTP session.

---

## Phase 5: Known Issues & Mitigations

### 5.1 Invalid ASIN firmware bug (2024–2025)

A bug in recent Kindle firmware causes an "Invalid ASIN" error on the first open of newly sideloaded EBOK-flagged books. The book itself is fine — the error is in the firmware's library indexing step.

**Mitigation:** Add a first-run notice in your tool's UI informing users that if this error appears, they should tap the three-dot menu → "Go To" → first chapter to bypass it. Subsequent opens work normally.

### 5.2 Cover overwrite on WiFi sync

If the device goes online before the thumbnail is written, Amazon's servers may overwrite the thumbnail with a generic placeholder. Writing the thumbnail as part of the same MTP transfer session (before ejecting the device) wins this race in the majority of cases.

### 5.3 abs-tract match failures (~10%)

Approximately 10% of libraries will have titles abs-tract cannot match — typically obscure, self-published, or regional titles with no Goodreads/Kindle Store listing. For these, your tool should fall back to **PDOC mode with an embedded cover** rather than transferring a file with no valid ASIN.

---

## Feature Matrix: EBOK + Real ASIN

| Feature | Status | Notes |
|---|---|---|
| Cover display | ✅ Works | Fetched from Amazon servers via ASIN |
| Appears under "Books" tab | ✅ Works | EBOK flag ensures correct placement |
| Goodreads integration | ✅ Works | Requires valid real ASIN |
| Vocabulary Builder | ✅ Works | Device-level, unaffected by sideload method |
| Highlights / notes (local) | ✅ Works | Saved to My Clippings on device |
| X-Ray | ❌ Unavailable | Server-side Amazon feature, store purchases only |
| Word Wise | ❌ Unavailable | Requires Kindle Store listing association |
| Cross-device Whispersync | ❌ Unavailable | Only available via Personal Documents pipeline |

---

## Complete Transfer Flow

| Step | Action |
|---|---|
| 1 | User adds ebook to ABS library |
| 2 | ABS scans file, extracts embedded metadata |
| 3 | abs-tract auto-match runs → populates ISBN and ASIN in ABS metadata store |
| 4 | User opens your tool, selects book(s) to sync to Kindle |
| 5 | Tool queries ABS API → retrieves ASIN, ISBN, title, author, coverPath |
| 6 | Tool converts file to AZW3 if needed (via Calibre CLI or bindings) |
| 7 | Tool injects ASIN into OPF metadata as AMAZON identifier, sets EBOK flag |
| 8 | Tool embeds high-res cover image inside the file (1680×1264 for PW 2024) |
| 9 | Tool connects to Kindle via MTP |
| 10 | Tool writes book file to `Internal Storage/documents/` |
| 11 | Tool writes `thumbnail_{ASIN}_EBOK_portrait.jpg` to `Internal Storage/system/thumbnails/` |
| 12 | Tool ejects device cleanly |
| 13 | Kindle indexes new book, fetches cover from Amazon servers via ASIN |
| 14 | Book appears in "Books" tab with correct cover and Goodreads integration |

---

## References & Resources

- **abs-tract GitHub:** github.com/ahobsonsayers/abs-tract
- **ABS API docs:** audiobookshelf.org/api
- **MobileRead Forums:** mobileread.com (Kindle sideloading threads)
- **Calibre source (MTP implementation):** github.com/kovidgoyal/calibre
- **libmtp:** libmtp.sourceforge.net
