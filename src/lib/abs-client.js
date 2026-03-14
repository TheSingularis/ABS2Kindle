const http = require("http");
const https = require("https");
const fs = require("fs");

/**
 * Make an authenticated GET request to the ABS API.
 * @param {string} serverUrl  e.g. "https://abs.example.com"
 * @param {string} apiKey
 * @param {string} endpoint   e.g. "items/abc123"  (no leading /api/)
 */
function absRequest(serverUrl, apiKey, endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${serverUrl}/api/${endpoint}`);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Could not parse response: " + e.message));
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Download a URL (with Bearer auth) to a local file path.
 * Follows a single level of 301/302 redirects.
 */
function downloadFile(url, apiKey, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        rejectUnauthorized: false,
      },
      (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          downloadFile(res.headers.location, apiKey, destPath)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Server returned ${res.statusCode}`));
          return;
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

module.exports = { absRequest, downloadFile };
