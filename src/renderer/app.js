// ── Navigation ────────────────────────────────────────────────
const views = {
  library: document.getElementById("view-library"),
  settings: document.getElementById("view-settings"),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle("hidden", k !== name);
  });
  document
    .getElementById("nav-library")
    .classList.toggle("active", name === "library");
  document
    .getElementById("nav-settings")
    .classList.toggle("active", name === "settings");
}

document
  .getElementById("nav-library")
  .addEventListener("click", () => showView("library"));
document
  .getElementById("nav-settings")
  .addEventListener("click", () => showView("settings"));

// ── Window controls ───────────────────────────────────────────
document
  .getElementById("btn-minimize")
  .addEventListener("click", () => window.api.windowMinimize());
document
  .getElementById("btn-maximize")
  .addEventListener("click", () => window.api.windowMaximize());
document
  .getElementById("btn-close")
  .addEventListener("click", () => window.api.windowClose());

// ── Settings & Auth ───────────────────────────────────────────
let currentAuthMethod = "apikey";

const toggleApikey = document.getElementById("toggle-apikey");
const toggleOidc = document.getElementById("toggle-oidc");
const authApikey = document.getElementById("auth-apikey");
const authOidc = document.getElementById("auth-oidc");

toggleApikey.addEventListener("click", () => {
  currentAuthMethod = "apikey";
  toggleApikey.classList.add("active");
  toggleOidc.classList.remove("active");
  authApikey.classList.remove("hidden");
  authOidc.classList.add("hidden");
});

toggleOidc.addEventListener("click", () => {
  currentAuthMethod = "oidc";
  toggleOidc.classList.add("active");
  toggleApikey.classList.remove("active");
  authOidc.classList.remove("hidden");
  authApikey.classList.add("hidden");
});

document.getElementById("btn-save").addEventListener("click", async () => {
  const serverUrl = document
    .getElementById("input-url")
    .value.trim()
    .replace(/\/$/, "");
  const apiKey = document.getElementById("input-apikey").value.trim();
  await window.api.saveSettings({ serverUrl, apiKey, authMethod: "apikey" });
  document.getElementById("test-result").textContent = "Saved.";
  document.getElementById("test-result").className = "ok";
});

document.getElementById("btn-test").addEventListener("click", async () => {
  const el = document.getElementById("test-result");
  el.textContent = "Testing…";
  el.className = "";
  const serverUrl = document
    .getElementById("input-url")
    .value.trim()
    .replace(/\/$/, "");
  const apiKey = document.getElementById("input-apikey").value.trim();
  const result = await window.api.testConnection({ serverUrl, apiKey });
  if (result.ok) {
    el.textContent = `✓ Connected — ${result.count} librar${result.count === 1 ? "y" : "ies"} found`;
    el.className = "ok";
  } else {
    el.textContent = `✗ ${result.error}`;
    el.className = "err";
  }
});

document
  .getElementById("btn-oidc-login")
  .addEventListener("click", async () => {
    const serverUrl = document
      .getElementById("input-url")
      .value.trim()
      .replace(/\/$/, "");
    if (!serverUrl) {
      document.getElementById("oidc-status").textContent =
        "Enter your server URL first";
      return;
    }
    document.getElementById("oidc-status").textContent =
      "Waiting for browser login…";
    await window.api.startOidc({ serverUrl });
  });

window.api.onOidcSuccess(async ({ token }) => {
  await window.api.saveSettings({ authMethod: "oidc", apiKey: token });
  document.getElementById("oidc-status").textContent = "";
  document.getElementById("oidc-token-display").classList.remove("hidden");
});

window.api.onOidcError((err) => {
  document.getElementById("oidc-status").textContent = `✗ ${err}`;
});

document
  .getElementById("btn-oidc-clear")
  .addEventListener("click", async () => {
    await window.api.saveSettings({ authMethod: "apikey", apiKey: "" });
    document.getElementById("oidc-token-display").classList.add("hidden");
    document.getElementById("oidc-status").textContent = "";
  });

// ── Startup ───────────────────────────────────────────────────
async function loadSettingsIntoForm() {
  const settings = await window.api.getSettings();
  if (settings.serverUrl) {
    document.getElementById("input-url").value = settings.serverUrl;
  }
  if (settings.authMethod === "oidc") {
    if (settings.apiKey) {
      document.getElementById("oidc-token-display").classList.remove("hidden");
    }
  } else if (settings.apiKey) {
    document.getElementById("input-apikey").value = settings.apiKey;
  }
}

loadSettingsIntoForm();
