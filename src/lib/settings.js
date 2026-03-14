const { app } = require("electron");
const path = require("path");
const fs = require("fs");

const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

// Exported as a plain object so all modules share the same reference.
// loadSettings() and saveSettings() mutate it in-place.
const settingsStore = {};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
      Object.assign(settingsStore, data);
    }
  } catch {
    // leave settingsStore empty
  }
}

function saveSettings(data) {
  Object.assign(settingsStore, data);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settingsStore, null, 2));
}

module.exports = { settingsStore, loadSettings, saveSettings };
