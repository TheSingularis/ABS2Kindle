# AZW3 ASIN Injection — Research Notes

**Date:** March 13, 2026  
**Outcome:** Working. Tested with *Dungeon Crawler Carl* (ASIN: `B08BKGYQXW`).

---

## What We're Doing and Why

When Calibre converts an EPUB to AZW3, it:
- ✅ Sets the EBOK flag correctly (EXTH record type 501 = `"EBOK"`)
- ❌ **Replaces the ASIN with a fresh UUID** (EXTH record type 113 gets a random UUID like `17845e62-...`)

Without a real ASIN in record 113, the Kindle cannot look up the cover from Amazon's servers and may not place the book under the "Books" tab.

The fix is to overwrite EXTH type-113's data with the real ASIN after conversion.

---

## AZW3 / KF8 File Format — What Matters Here

An AZW3 file is a **PalmDB container**. Its structure:

```
[PalmDB header — 78 bytes]
[PalmDB record list — num_records × 8 bytes each]
  └─ each entry: 4-byte absolute file offset + 4-byte attributes
[Record 0  ← the KF8 boundary/metadata record]
  ├─ PalmDOC header (16 bytes)
  ├─ MOBI stub header (8 bytes, hlen=8 — KF8 compat skeleton only)
  ├─ 256-byte region (mostly 0xFF, some internal KF8 pointers)
  ├─ EXTH section  ← where the ASIN lives
  │    4 bytes: "EXTH" magic
  │    4 bytes: total section length
  │    4 bytes: record count
  │    [records...]  ← each: type(4) + len(4) + data(len-8)
  └─ fullName string (title, null-terminated, right after EXTH)
[Record 1 … Record N — compressed text, images, indices, etc.]
```

**The PalmDB record list stores absolute file offsets.** If you change the size of any bytes inside record 0, every record from ~4 onwards shifts in the file but their offsets in the record list still point to the old positions → the Kindle reads garbage → file appears corrupted and doesn't show up.

---

## EXTH Record Types Used

| Type | Purpose | Calibre's value after conversion |
|------|---------|----------------------------------|
| 113  | Primary ASIN — used by Kindle for cover lookup | UUID (e.g. `17845e62-6a04-4ef3-bded-2d0fa1361bc4`) — **wrong** |
| 504  | Secondary ASIN copy (newer firmware) | absent |
| 501  | File type flag | `EBOK` — ✅ correct |
| 503  | Title | correct |
| 100  | Author | correct |

---

## The Correct Patch Strategy

### What NOT to do

Do **not** splice bytes in or out of the EXTH section. Even a 1-byte change in size breaks the PalmDB record list offsets for all subsequent records. This causes the file to appear corrupted on the Kindle (it won't even show up in the library).

### What TO do: overwrite type-113 in-place

Calibre writes a 36-byte UUID as the EXTH type-113 data. The full record is 44 bytes (8-byte header + 36-byte data). Our ASIN is 10 bytes — shorter than 36.

**Write the ASIN into the first 10 bytes of the data field, then fill the remaining 26 bytes with `\x00` null padding.** The declared record length (`rlen = 44`) does not change. The file size does not change. No PalmDB offsets are touched.

```
Before: [type=113][len=44][17845e62-6a04-4ef3-bded-2d0fa1361bc4]
After:  [type=113][len=44][B08BKGYQXW\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00]
```

The Kindle reads exactly `rlen - 8` bytes of data from the record. It reads `B08BKGYQXW` and stops at the null byte, which is a valid C-string terminator. The trailing nulls are ignored.

### What about type-504?

Type-504 (secondary ASIN) is absent from Calibre's output. Adding it would require inserting bytes into the EXTH section, which changes the file size and corrupts PalmDB offsets (see above). **Omitting it is safe** — the Kindle resolves covers and library placement from type-113 alone. Type-504 is only a redundant copy used by some newer firmware revisions; omitting it has no observed effect on functionality.

---

## The Pipeline (`scripts/test-transfer.js`)

```
1. GET /api/items/{id}           → verify ASIN present in ABS metadata
2. GET /api/items/{id}/ebook     → download EPUB to /tmp
3. ebook-convert src.epub out.azw3 --output-profile=kindle_pw3
4. injectAsinIntoAzw3(azw3Path, asin)
   └─ find EXTH, walk to type-113, overwrite data in-place with null-padded ASIN
   └─ assert file size unchanged (sanity check against accidental corruption)
5. kioclient5 --noninteractive --overwrite copy file://…/out.azw3 mtp:/…/documents/
6. kioclient5 ls … | grep filename   → verify file landed on device
```

**Kindle detection used:** KDE kmtpd D-Bus path (`via: "kmttpd"`).  
**KIO documents URI:** `mtp:/Kindle Paperwhite/Internal Storage/documents`

---

## Known Firmware Issue: "Invalid ASIN" on First Open

A bug in recent Kindle firmware (2024–2025) shows an "Invalid ASIN" error on the very first open of a newly sideloaded EBOK-flagged book. The book is fine — it's a firmware indexing bug. **Workaround:** tap ⋮ → *Go To* → first chapter. Subsequent opens are normal.

---

## References

- MobileRead Forums — KF8/MOBI EXTH record types
- Calibre source: `src/calibre/ebooks/mobi/writer/` (EXTH generation)
- PalmDB format spec: `https://wiki.mobileread.com/wiki/PalmDOC`
- ABS API: `GET /api/items/{id}` → `.media.metadata.asin`
