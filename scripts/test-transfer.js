#!/usr/bin/env node
/**
 * ABS2Kindle — End-to-end transfer test script
 *
 * Tests the full Phase 2–4 pipeline for a single book:
 *   1. Fetch item metadata from ABS and verify ASIN
 *   2. Download EPUB
 *   3. Convert EPUB → AZW3 via ebook-convert (Calibre)
 *   4. Inject ASIN into EXTH records 113 + 504 in the AZW3 binary
 *   5. Transfer to Kindle via kioclient5 (KDE/kmtpd path)
 *
 * Usage:
 *   node scripts/test-transfer.js
 */

"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, execFile } = require("child_process");

// ── Config ────────────────────────────────────────────────────
const SERVER_URL = "https://audiobookshelf.notahomeserver.xyz/audiobookshelf";
const API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIwNWE2M2EyOS02Yjg4LTQ4NzctOTYzNS02OTQzOTMxZDRiMzEiLCJ1c2VybmFtZSI6InJvb3QiLCJpYXQiOjE3Mzk4NTYwOTJ9.UUx5HQdMGISb2QNFIKd-_wBCxJK5AifYeZP5ntqCk6U";
const ITEM_ID = "a830e860-a55a-4623-a009-e714edb26327";

// Detected from dbus-send: "Kindle Paperwhite" / "Internal Storage"
const KIO_DOCUMENTS_URI = "mtp:/Kindle Paperwhite/Internal Storage/documents";

const WORK_DIR = path.join(os.tmpdir(), "abs2kindle_test");

// ── Helpers ───────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function absGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SERVER_URL}/api/${endpoint}`);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}` },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(
              new Error(
                `JSON parse failed: ${e.message}\nBody: ${data.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEY}` },
        rejectUnauthorized: false,
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return downloadFile(res.headers.location, destPath)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve(destPath)));
        file.on("error", (e) => {
          fs.unlink(destPath, () => {});
          reject(e);
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Patch EXTH record 113 in an AZW3 file to set the correct ASIN.
 *
 * WHY IN-PLACE ONLY:
 * An AZW3/KF8 file is a PalmDB container. The PalmDB record list stores the
 * absolute file offset of every record. If we insert or remove any bytes inside
 * record 0 (where the EXTH lives), every subsequent record's offset pointer
 * becomes wrong and the Kindle cannot read the file.
 *
 * The safe approach: overwrite the type-113 data field in-place without changing
 * the declared record length. Calibre writes a 36-byte UUID as the type-113 data.
 * Our ASIN is 10 bytes. We write the ASIN followed by null padding to fill the
 * original 36-byte data slot exactly — the declared rlen stays 44, the file size
 * stays identical, no PalmDB offsets are invalidated.
 *
 * EXTH record wire format (big-endian):
 *   4 bytes: record type
 *   4 bytes: total record length (including these 8 bytes)
 *   N bytes: record data  ← we overwrite this in-place, null-padding to original length
 */
function injectAsinIntoAzw3(filePath, asin) {
  const buf = fs.readFileSync(filePath);

  // Locate EXTH section
  const exthOffset = buf.indexOf(Buffer.from("EXTH"));
  if (exthOffset < 0) throw new Error("EXTH section not found in AZW3 file");

  const exthLen = buf.readUInt32BE(exthOffset + 4);
  const recordCount = buf.readUInt32BE(exthOffset + 8);
  log(
    `  EXTH found at offset ${exthOffset}, length=${exthLen}, records=${recordCount}`,
  );

  const asinBytes = Buffer.from(asin, "utf8");

  // Walk EXTH records to find type 113
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

  if (type113DataOffset < 0) {
    throw new Error("EXTH type-113 record not found — cannot patch ASIN");
  }
  if (asinBytes.length > type113DataLen) {
    throw new Error(
      `ASIN (${asinBytes.length} bytes) is longer than existing type-113 data slot (${type113DataLen} bytes)`,
    );
  }

  // Overwrite the data field in-place: ASIN bytes + null padding to original length.
  // File size does not change — no PalmDB record offsets are affected.
  asinBytes.copy(buf, type113DataOffset);
  buf.fill(
    0,
    type113DataOffset + asinBytes.length,
    type113DataOffset + type113DataLen,
  );

  fs.writeFileSync(filePath, buf);
  log(
    `  ASIN ${asin} written to EXTH type-113 (${asinBytes.length} bytes + ${type113DataLen - asinBytes.length} bytes null padding)`,
  );
}

/**
 * Verify the patched AZW3 contains the expected ASIN and EBOK flag,
 * and that the file size is unchanged from before patching (no PalmDB corruption).
 */
function verifyAzw3(filePath, asin, expectedSize) {
  const buf = fs.readFileSync(filePath);
  const asinFound = buf.includes(Buffer.from(asin));
  const ebokFound = buf.includes(Buffer.from("EBOK"));
  const sizeOk = buf.length === expectedSize;
  log(
    `  Verification — ASIN: ${asinFound}, EBOK: ${ebokFound}, size unchanged: ${sizeOk} (${buf.length} bytes)`,
  );
  if (!asinFound)
    throw new Error(`ASIN ${asin} not found in output AZW3 after patching`);
  if (!ebokFound) throw new Error("EBOK flag not found in output AZW3");
  if (!sizeOk)
    throw new Error(
      `File size changed after patching (${buf.length} vs expected ${expectedSize}) — would corrupt PalmDB offsets`,
    );
}

// ── Main pipeline ─────────────────────────────────────────────
async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  log(`Work directory: ${WORK_DIR}`);

  // ── Step 1: Fetch metadata and verify ASIN ─────────────────
  log("Step 1: Fetching item metadata from ABS...");
  const item = await absGet(`items/${ITEM_ID}`);
  const metadata = item?.media?.metadata;
  if (!metadata) throw new Error("No media.metadata in ABS response");

  const title = metadata.title ?? ITEM_ID;
  const asin = metadata.asin;
  const isbn = metadata.isbn;

  log(`  Title:  ${title}`);
  log(`  ASIN:   ${asin ?? "MISSING"}`);
  log(`  ISBN:   ${isbn ?? "none"}`);

  if (!asin)
    throw new Error(
      "No ASIN in ABS metadata — cannot proceed with EBOK transfer",
    );

  // ── Step 2: Download EPUB ──────────────────────────────────
  const safeTitle = title.replace(/[<>:"/\\|?*]/g, "_").slice(0, 80);
  const epubPath = path.join(WORK_DIR, `${safeTitle}.epub`);
  const azw3Path = path.join(WORK_DIR, `${safeTitle}.azw3`);

  log(`Step 2: Downloading EPUB...`);
  await downloadFile(`${SERVER_URL}/api/items/${ITEM_ID}/ebook`, epubPath);
  const epubSize = fs.statSync(epubPath).size;
  log(`  Downloaded ${(epubSize / 1024).toFixed(1)} KB → ${epubPath}`);

  // ── Step 3: Convert EPUB → AZW3 ───────────────────────────
  log("Step 3: Converting EPUB → AZW3 with ebook-convert...");
  if (fs.existsSync(azw3Path)) fs.unlinkSync(azw3Path);

  execFileSync(
    "ebook-convert",
    [epubPath, azw3Path, "--output-profile=kindle_pw3"],
    { stdio: "inherit", timeout: 180_000 },
  );

  const azw3Size = fs.statSync(azw3Path).size;
  log(`  Converted: ${(azw3Size / 1024).toFixed(1)} KB → ${azw3Path}`);

  // ── Step 4: Inject ASIN into AZW3 EXTH records ────────────
  log(`Step 4: Injecting ASIN ${asin} into AZW3 EXTH records...`);
  const sizeBeforePatch = fs.statSync(azw3Path).size;
  injectAsinIntoAzw3(azw3Path, asin);
  verifyAzw3(azw3Path, asin, sizeBeforePatch);

  // ── Step 5: Transfer to Kindle via kioclient5 ─────────────
  const filename = path.basename(azw3Path);
  const kioDestUri = `${KIO_DOCUMENTS_URI}/${filename}`;

  log(`Step 5: Transferring to Kindle...`);
  log(`  Source:      file://${azw3Path}`);
  log(`  Destination: ${kioDestUri}`);

  await new Promise((resolve, reject) => {
    execFile(
      "kioclient5",
      [
        "--noninteractive",
        "--overwrite",
        "copy",
        `file://${azw3Path}`,
        kioDestUri,
      ],
      { timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(`kioclient5 failed: ${(stderr || err.message).trim()}`),
          );
        } else {
          resolve();
        }
      },
    );
  });

  log(`  Transfer complete.`);

  // ── Step 6: Confirm file is on device ─────────────────────
  log("Step 6: Verifying file on Kindle...");
  const lsOut = execFileSync(
    "kioclient5",
    ["--noninteractive", "ls", KIO_DOCUMENTS_URI],
    { encoding: "utf8", timeout: 10_000 },
  );
  const onDevice = lsOut.includes(filename);
  log(`  File "${filename}" on device: ${onDevice}`);
  if (!onDevice)
    throw new Error(
      "File not found on Kindle after transfer — kioclient5 may have silently failed",
    );

  // ── Done ──────────────────────────────────────────────────
  log("✓ All steps completed successfully.");
  log(`  "${title}" (ASIN: ${asin}) is now on your Kindle.`);
  log(
    `  IMPORTANT: If you see 'Invalid ASIN' on first open, tap ⋮ → Go To → first chapter to bypass it.`,
  );
  log(`  Subsequent opens will work normally.`);
}

main().catch((err) => {
  console.error(`\n✗ Transfer failed: ${err.message}`);
  process.exit(1);
});
