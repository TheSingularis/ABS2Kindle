const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Build a device entry object for GVFS/USB/jmtpfs mounts.
 * rawName is already URI-decoded and stripped of the "mtp:" prefix.
 */
function buildDeviceEntry(mountPath, rawName, documentsPath) {
  let name = rawName.replace(/_/g, " ").trim();
  if (!name || name.length < 2) name = "Kindle";

  let bookCount = 0;
  try {
    bookCount = fs
      .readdirSync(documentsPath)
      .filter((f) =>
        [".epub", ".mobi", ".azw3", ".azw"].some((ext) => f.endsWith(ext)),
      ).length;
  } catch (_) {}

  return { name, path: mountPath, documentsPath, bookCount };
}

/**
 * Detect Kindles via GVFS FUSE mounts (GNOME/non-KDE) and USB mass storage.
 * Also handles Windows drive-letter detection.
 */
function findKindleMounts() {
  const platform = process.platform;
  const found = [];

  if (platform === "linux") {
    const uid = process.getuid();
    const gvfsBase = `/run/user/${uid}/gvfs`;

    try {
      if (fs.existsSync(gvfsBase)) {
        for (const entry of fs.readdirSync(gvfsBase)) {
          if (!entry.startsWith("mtp:")) continue;
          const mountPath = `${gvfsBase}/${entry}`;

          let rawName;
          try {
            rawName = decodeURIComponent(
              entry
                .replace(/^mtp:host=/, "")
                .replace(/^mtp:%2F/, "")
                .replace(/^mtp:\//, ""),
            );
          } catch {
            rawName = entry;
          }

          try {
            for (const storage of fs.readdirSync(mountPath)) {
              const storagePath = `${mountPath}/${storage}`;
              const documentsPath = `${storagePath}/documents`;
              if (fs.existsSync(documentsPath)) {
                found.push(buildDeviceEntry(storagePath, rawName, documentsPath));
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // Classic USB mass storage fallback (older Kindles or manual mounts)
    const username = os.userInfo().username;
    const fallbackDirs = [
      `/media/${username}`,
      `/run/media/${username}`,
      "/mnt",
    ];
    for (const base of fallbackDirs) {
      try {
        if (!fs.existsSync(base)) continue;
        for (const entry of fs.readdirSync(base)) {
          const fullPath = `${base}/${entry}`;
          const documentsPath = `${fullPath}/documents`;
          if (
            entry.toLowerCase().includes("kindle") &&
            fs.existsSync(documentsPath)
          ) {
            found.push(buildDeviceEntry(fullPath, entry, documentsPath));
          }
        }
      } catch (_) {}
    }
  } else if (platform === "win32") {
    for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
      const drivePath = `${letter}:\\`;
      try {
        const documentsPath = `${drivePath}documents`;
        if (fs.existsSync(drivePath) && fs.existsSync(documentsPath)) {
          found.push(buildDeviceEntry(drivePath, `Kindle (${letter}:)`, documentsPath));
        }
      } catch (_) {}
    }
  }

  return found;
}

/**
 * Detect Kindles via KDE's kmtpd D-Bus service.
 * Returns device objects with a kioDocumentsUri that kioclient5 can write to
 * without conflicting with kmtpd's USB interface ownership.
 */
function findKmtpdDevices() {
  const { execSync } = require("child_process");
  const found = [];

  const dbusGet = (objPath, method, ...args) => {
    try {
      return execSync(
        ["dbus-send", "--session", "--print-reply", "--dest=org.kde.kiod6",
          objPath, method, ...args].join(" "),
        { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      return null;
    }
  };

  const devicesOut = dbusGet("/modules/kmtpd", "org.kde.kmtp.Daemon.listDevices");
  if (!devicesOut) return found;

  const devicePaths = [...devicesOut.matchAll(/object path "([^"]+)"/g)].map((m) => m[1]);

  for (const devPath of devicePaths) {
    const devProps = dbusGet(
      devPath,
      "org.freedesktop.DBus.Properties.GetAll",
      'string:"org.kde.kmtp.Device"',
    );
    if (!devProps) continue;
    const nameMatch = devProps.match(/"friendlyName"[\s\S]*?string "([^"]+)"/);
    const deviceName = nameMatch ? nameMatch[1] : "Kindle";

    const storagesOut = dbusGet(devPath, "org.kde.kmtp.Device.listStorages");
    if (!storagesOut) continue;
    const storagePaths = [...storagesOut.matchAll(/object path "([^"]+)"/g)].map((m) => m[1]);

    for (const storagePath of storagePaths) {
      const storageProps = dbusGet(
        storagePath,
        "org.freedesktop.DBus.Properties.GetAll",
        'string:"org.kde.kmtp.Storage"',
      );
      if (!storageProps) continue;
      const descMatch = storageProps.match(/"description"[\s\S]*?string "([^"]+)"/);
      const storageName = descMatch ? descMatch[1] : "Internal Storage";

      const kioDocumentsUri = `mtp:/${deviceName}/${storageName}/documents`;
      try {
        execSync(`kioclient5 --noninteractive ls "${kioDocumentsUri}"`, {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        continue; // no documents folder on this storage
      }

      let bookCount = 0;
      try {
        const lsOut = execSync(`kioclient5 --noninteractive ls "${kioDocumentsUri}"`, {
          encoding: "utf8",
          timeout: 5000,
        });
        bookCount = (lsOut.match(/\.(epub|mobi|azw3|azw)\n/gi) || []).length;
      } catch (_) {}

      found.push({
        name: deviceName,
        storageName,
        documentsPath: kioDocumentsUri, // sentinel for renderer display
        kioDocumentsUri,
        bookCount,
        via: "kmtpd",
      });
    }
  }

  return found;
}

/**
 * Detect Kindles via jmtpfs FUSE mounts (non-KDE fallback).
 */
function findJmtpfsDevices() {
  const { execSync, spawnSync } = require("child_process");
  const found = [];

  let listOutput = "";
  try {
    const result = spawnSync("jmtpfs", ["-l"], { encoding: "utf8", timeout: 5000 });
    listOutput = result.stdout + result.stderr;
  } catch {
    return found;
  }

  const deviceLines = listOutput.split("\n").filter((l) => /^\d+,/.test(l.trim()));
  if (deviceLines.length === 0) return found;

  for (const line of deviceLines) {
    const parts = line.split(",").map((s) => s.trim());
    const [busNum, devNum, , , product, vendor] = parts;
    const displayName = [vendor, product].filter(Boolean).join(" ").trim() || "Kindle";

    const mountDir = path.join(os.tmpdir(), `abs2kindle_mtp_${busNum}_${devNum}`);
    try {
      fs.mkdirSync(mountDir, { recursive: true });
      try { execSync(`fusermount -u "${mountDir}"`, { stdio: "ignore" }); } catch (_) {}

      const mount = spawnSync("jmtpfs", [`-device=${busNum},${devNum}`, mountDir], {
        encoding: "utf8",
        timeout: 10000,
      });
      if (mount.status !== 0) {
        console.error("jmtpfs mount failed:", mount.stderr);
        continue;
      }

      const scanDirs = (base, depth = 0) => {
        if (depth > 2) return;
        try {
          for (const entry of fs.readdirSync(base)) {
            const full = path.join(base, entry);
            if (entry.toLowerCase() === "documents") {
              found.push(buildDeviceEntry(path.dirname(full), displayName, full));
              return;
            }
            try {
              if (fs.statSync(full).isDirectory()) scanDirs(full, depth + 1);
            } catch (_) {}
          }
        } catch (_) {}
      };
      scanDirs(mountDir);
    } catch (e) {
      console.error("jmtpfs setup error:", e.message);
    }
  }

  return found;
}

module.exports = { findKindleMounts, findKmtpdDevices, findJmtpfsDevices };
