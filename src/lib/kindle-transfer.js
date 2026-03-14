const fs = require("fs");
const path = require("path");

const DOLPHIN_BLOCKING_ERROR = "DOLPHIN_BLOCKING";

/**
 * Convert an EPUB to AZW3 using Calibre's ebook-convert.
 * Throws if ebook-convert is not installed or the conversion fails.
 */
function convertEpubToAzw3(epubPath, azw3Path) {
  const { execFileSync } = require("child_process");
  if (fs.existsSync(azw3Path)) fs.unlinkSync(azw3Path);
  execFileSync(
    "ebook-convert",
    [epubPath, azw3Path, "--output-profile=kindle_pw3"],
    { timeout: 180_000, stdio: ["ignore", "ignore", "pipe"] },
  );
}

/**
 * Overwrite EXTH type-113 (primary ASIN) in an AZW3 file in-place.
 *
 * Calibre writes a 36-byte UUID into this record. We write the 10-byte ASIN
 * into the first 10 bytes and null-pad the remaining 26 bytes. The declared
 * record length (rlen = 44) and the total file size are unchanged, so no
 * PalmDB record-list offsets are disturbed.
 *
 * See .vscode/notes/azw3-asin-injection.md for the full rationale.
 */
function injectAsinIntoAzw3(filePath, asin) {
  const buf = fs.readFileSync(filePath);

  const exthOffset = buf.indexOf(Buffer.from("EXTH"));
  if (exthOffset < 0) throw new Error("EXTH section not found in AZW3 file");

  const recordCount = buf.readUInt32BE(exthOffset + 8);
  const asinBytes = Buffer.from(asin, "utf8");

  let pos = exthOffset + 12;
  let type113DataOffset = -1;
  let type113DataLen = 0;

  for (let i = 0; i < recordCount; i++) {
    const rtype = buf.readUInt32BE(pos);
    const rlen = buf.readUInt32BE(pos + 4);
    if (rtype === 113) {
      type113DataOffset = pos + 8;
      type113DataLen = rlen - 8;
      break;
    }
    pos += rlen;
  }

  if (type113DataOffset < 0)
    throw new Error("EXTH type-113 record not found — cannot inject ASIN");
  if (asinBytes.length > type113DataLen)
    throw new Error(
      `ASIN (${asinBytes.length} B) exceeds type-113 data slot (${type113DataLen} B)`,
    );

  const sizeBefore = buf.length;
  asinBytes.copy(buf, type113DataOffset);
  buf.fill(
    0,
    type113DataOffset + asinBytes.length,
    type113DataOffset + type113DataLen,
  );
  fs.writeFileSync(filePath, buf);

  // Sanity-check: file size must not change (would corrupt PalmDB offsets)
  const sizeAfter = fs.statSync(filePath).size;
  if (sizeAfter !== sizeBefore)
    throw new Error(
      `AZW3 size changed after ASIN injection (${sizeBefore} → ${sizeAfter}) — aborting`,
    );
}

/**
 * Parse the ASIN from EXTH type-113 in a Buffer containing (at least the
 * first 64 KB of) an AZW3/MOBI file.
 * Returns the ASIN string, or null if not present / unreadable.
 * Never throws.
 */
function readAsinFromBuffer(buf) {
  try {
    const exthOffset = buf.indexOf(Buffer.from("EXTH"));
    if (exthOffset < 0) return null;

    const recordCount = buf.readUInt32BE(exthOffset + 8);
    let pos = exthOffset + 12;

    for (let i = 0; i < recordCount; i++) {
      if (pos + 8 > buf.length) break;
      const rtype = buf.readUInt32BE(pos);
      const rlen = buf.readUInt32BE(pos + 4);
      if (rtype === 113) {
        const data = buf.slice(pos + 8, pos + rlen);
        const asin = data.toString("utf8").replace(/\0+$/, "").trim();
        return asin.length > 0 ? asin : null;
      }
      if (rlen < 8) break;
      pos += rlen;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Read the ASIN from EXTH type-113 in an AZW3/MOBI file on disk.
 * Returns the ASIN string (trimmed of null padding), or null if not found.
 * Never throws — any read/parse error returns null.
 */
function readAsinFromAzw3(filePath) {
  try {
    // Read only the first 64 KB — the EXTH section is always near the start
    const fd = fs.openSync(filePath, "r");
    const headBuf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    fs.closeSync(fd);
    return readAsinFromBuffer(headBuf.slice(0, bytesRead));
  } catch (_) {
    return null;
  }
}

/**
 * Copy srcPath to destPath on the Kindle using the appropriate method:
 *  - kmtpd (KDE): kioclient5, speaks KIO natively alongside kmtpd
 *  - GVFS/USB:    fs.copyFileSync, then gio copy as fallback
 *  - Fallback failure: throws DOLPHIN_BLOCKING_ERROR sentinel
 */
async function copyToKindle(srcPath, destPath, device) {
  const { execFile } = require("child_process");

  // ── KDE/kmtpd: use kioclient5 ────────────────────────────────
  if (device && device.via === "kmtpd") {
    const filename = path.basename(srcPath);
    const kioDestUri = `${device.kioDocumentsUri}/${filename}`;
    await new Promise((resolve, reject) => {
      execFile(
        "kioclient5",
        [
          "--noninteractive",
          "--overwrite",
          "copy",
          `file://${srcPath}`,
          kioDestUri,
        ],
        { timeout: 60000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(
              new Error(
                `kioclient5 copy failed: ${(stderr || err.message).trim()}`,
              ),
            );
          } else {
            resolve();
          }
        },
      );
    });
    return;
  }

  // ── Non-Linux: plain copy only ───────────────────────────────
  if (process.platform !== "linux") {
    fs.copyFileSync(srcPath, destPath);
    return;
  }

  // ── Attempt 1: direct fs copy (GVFS FUSE / USB mass storage) ─
  try {
    fs.copyFileSync(srcPath, destPath);
    return;
  } catch (e1) {
    console.warn(
      "copyToKindle: fs.copyFileSync failed, trying gio:",
      e1.message,
    );
  }

  // ── Attempt 2: gio copy ──────────────────────────────────────
  try {
    await new Promise((resolve, reject) => {
      execFile(
        "gio",
        ["copy", srcPath, destPath],
        { timeout: 30000 },
        (err, _stdout, stderr) => {
          if (err) {
            reject(
              new Error(`gio copy failed: ${(stderr || err.message).trim()}`),
            );
          } else {
            resolve();
          }
        },
      );
    });
    return;
  } catch (e2) {
    console.warn("copyToKindle: gio copy failed:", e2.message);
  }

  // ── Both methods failed ──────────────────────────────────────
  throw new Error(DOLPHIN_BLOCKING_ERROR);
}

module.exports = {
  DOLPHIN_BLOCKING_ERROR,
  convertEpubToAzw3,
  injectAsinIntoAzw3,
  readAsinFromBuffer,
  readAsinFromAzw3,
  copyToKindle,
};
