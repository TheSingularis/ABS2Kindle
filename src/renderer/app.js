// ── Settings cache (for cover URLs etc) ──────────────────────
let settingsForRenderer = {};

async function initSettings() {
  settingsForRenderer = await window.api.getSettings();
}

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

document.getElementById("nav-library").addEventListener("click", () => {
  showView("library");
  if (allBooks.length === 0) loadLibrary();
});
document
  .getElementById("nav-settings")
  .addEventListener("click", () => showView("settings"));

// ── Kindle Detection ──────────────────────────────────────────
let detectedKindles = [];
let selectedKindle = null;

async function refreshKindles() {
  const list = document.getElementById("device-list");
  list.innerHTML = '<div class="no-device">Scanning…</div>';
  detectedKindles = await window.api.detectKindles();
  renderKindleSidebar();
}

function renderKindleSidebar() {
  const list = document.getElementById("device-list");

  if (detectedKindles.length === 0) {
    list.innerHTML = '<div class="no-device">No Kindle detected</div>';
    selectedKindle = null;
    updateBottomBar();
    return;
  }

  // Check if any entry is a "busy" error (device seen but USB held by OS daemon)
  const busyEntry = detectedKindles.find((d) => d.error === "busy");
  if (busyEntry) {
    list.innerHTML = `
      <div class="no-device device-busy">
        ⚠️ <strong>${busyEntry.name}</strong> detected but busy<br>
        <span class="device-busy-hint">System MTP daemon is holding the USB interface.<br>Apply the udev rule in README.md, then replug.</span>
      </div>`;
    selectedKindle = null;
    updateBottomBar();
    return;
  }

  list.innerHTML = "";
  detectedKindles.forEach((device, i) => {
    const el = document.createElement("div");
    el.className = "device-entry" + (i === 0 ? " selected" : "");
    el.innerHTML = `
      <div class="device-name">📱 ${device.name}</div>
      <div class="device-sub">${device.bookCount} book${device.bookCount !== 1 ? "s" : ""} on device</div>
    `;
    el.addEventListener("click", () => {
      document
        .querySelectorAll(".device-entry")
        .forEach((d) => d.classList.remove("selected"));
      el.classList.add("selected");
      selectedKindle = device;
      updateBottomBar();
    });
    list.appendChild(el);

    // Auto-select first device found
    if (i === 0) selectedKindle = device;
  });

  updateBottomBar();
}

document
  .getElementById("refresh-devices")
  .addEventListener("click", refreshKindles);

// Auto-detect on load
refreshKindles();

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

// ── Search ────────────────────────────────────────────────────
document.getElementById("search").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  const filtered = allBooks.filter((b) => {
    const title = b.media?.metadata?.title?.toLowerCase() ?? "";
    const author = b.media?.metadata?.authorName?.toLowerCase() ?? "";
    return title.includes(q) || author.includes(q);
  });
  renderGrid(filtered);
});

// ── Library ───────────────────────────────────────────────────
let allBooks = [];
let selectedBooks = new Set();
let currentLibraryId = null;

async function loadLibrary() {
  const grid = document.getElementById("book-grid");
  grid.innerHTML = '<div class="empty-state">Loading libraries…</div>';

  const libraries = await window.api.getLibraries();

  if (libraries?.error) {
    grid.innerHTML = `<div class="empty-state">Error: ${libraries.error}</div>`;
    return;
  }

  // Filter to ebook libraries only (type: 'book')
  const bookLibs = libraries.filter((l) => l.mediaType === "book");

  if (bookLibs.length === 0) {
    grid.innerHTML = '<div class="empty-state">No book libraries found.</div>';
    return;
  }

  // Use first book library for now
  currentLibraryId = bookLibs[0].id;
  grid.innerHTML = '<div class="empty-state">Loading books…</div>';

  const result = await window.api.getBooks({ libraryId: currentLibraryId });

  if (result?.error) {
    grid.innerHTML = `<div class="empty-state">Error: ${result.error}</div>`;
    return;
  }

  allBooks = result.results ?? [];
  renderGrid(allBooks);
}

function renderGrid(books) {
  const grid = document.getElementById("book-grid");

  if (books.length === 0) {
    grid.innerHTML = '<div class="empty-state">No books found.</div>';
    return;
  }

  grid.innerHTML = "";
  books.forEach((book) => {
    const meta = book.media?.metadata ?? {};
    const title = meta.title ?? "Untitled";
    const author = meta.authorName ?? "Unknown";
    const coverId = book.media?.coverPath ? book.id : null;

    const card = document.createElement("div");
    card.className = "book-card";
    card.dataset.id = book.id;

    const coverHtml = coverId
      ? `<img class="book-cover" src="${settingsForRenderer.serverUrl}/api/items/${book.id}/cover?token=${settingsForRenderer.apiKey}" onerror="this.replaceWith(makePlaceholder())" />`
      : `<div class="book-cover-placeholder">📖</div>`;

    card.innerHTML = `
      ${coverHtml}
      <div class="book-title" title="${title}">${title}</div>
      <div class="book-author">${author}</div>
    `;

    card.addEventListener("click", () => toggleBookSelection(book.id, card));
    grid.appendChild(card);
  });
}

function toggleBookSelection(id, card) {
  if (selectedBooks.has(id)) {
    selectedBooks.delete(id);
    card.classList.remove("selected");
  } else {
    selectedBooks.add(id);
    card.classList.add("selected");
  }
  updateBottomBar();
}

function updateBottomBar() {
  const label = document.getElementById("selection-label");
  const btn = document.getElementById("btn-send");
  const count = selectedBooks.size;

  if (count === 0) {
    label.textContent = "No books selected";
  } else if (!selectedKindle) {
    label.textContent = `${count} book${count > 1 ? "s" : ""} selected — connect a Kindle to send`;
  } else {
    label.textContent = `Send ${count} book${count > 1 ? "s" : ""} to ${selectedKindle.name}`;
  }

  btn.disabled = count === 0 || !selectedKindle;
}

document.getElementById("btn-send").addEventListener("click", async () => {
  if (selectedBooks.size === 0 || !selectedKindle) return;

  const btn = document.getElementById("btn-send");
  const label = document.getElementById("selection-label");
  btn.disabled = true;

  const removeListener = window.api.onTransferProgress(
    ({ current, total, status, title, error }) => {
      if (status === "downloading") {
        label.textContent = `⬇ Downloading ${current} of ${total}…`;
      } else if (status === "converting") {
        label.textContent = `⚙ Converting to AZW3: ${title}`;
      } else if (status === "copying") {
        label.textContent = `📋 Copying to Kindle: ${title}`;
      } else if (status === "done") {
        label.textContent = `✓ ${current} of ${total} done: ${title}`;
      } else if (status === "dolphin-blocking") {
        label.textContent = `⚠️ Dolphin may be holding the device. Close any Dolphin windows showing your Kindle and try again.`;
      } else if (status === "error") {
        label.textContent = `✗ Error on ${current} of ${total}: ${error}`;
      }
    },
  );

  try {
    const results = await window.api.sendToKindle({
      itemIds: Array.from(selectedBooks),
      kindleDocumentsPath: selectedKindle.documentsPath,
      device: selectedKindle,
    });

    removeListener();

    const succeeded = results.results.filter((r) => r.ok);
    const failed = results.results.filter((r) => !r.ok);
    const dolphinBlocking = failed.some((r) => r.error === "dolphin-blocking");

    if (dolphinBlocking) {
      label.textContent = `⚠️ Dolphin may be holding the device. Close any Dolphin windows showing your Kindle and try again.`;
    } else if (failed.length === 0) {
      label.textContent = `✓ ${succeeded.length} book${succeeded.length > 1 ? "s" : ""} sent to ${selectedKindle.name}`;
    } else if (succeeded.length === 0) {
      label.textContent = `✗ All ${failed.length} transfers failed`;
    } else {
      label.textContent = `✓ ${succeeded.length} sent  ✗ ${failed.length} failed`;
    }
  } catch (e) {
    removeListener();
    label.textContent = `✗ Transfer failed: ${e.message}`;
  }

  // Clear selection regardless of outcome
  selectedBooks.clear();
  document
    .querySelectorAll(".book-card.selected")
    .forEach((c) => c.classList.remove("selected"));
  btn.disabled = true;

  // Refresh Kindle book count to reflect new files
  refreshKindles();
});

// ── Settings & Auth ───────────────────────────────────────────
document.getElementById("btn-save").addEventListener("click", async () => {
  const serverUrl = document
    .getElementById("input-url")
    .value.trim()
    .replace(/\/$/, "");
  const apiKey = document.getElementById("input-apikey").value.trim();
  await window.api.saveSettings({ serverUrl, apiKey });
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

// ── Startup ───────────────────────────────────────────────────
async function loadSettingsIntoForm() {
  settingsForRenderer = await window.api.getSettings();
  if (settingsForRenderer.serverUrl) {
    document.getElementById("input-url").value = settingsForRenderer.serverUrl;
  }
  if (settingsForRenderer.apiKey) {
    document.getElementById("input-apikey").value = settingsForRenderer.apiKey;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  await initSettings();
  loadSettingsIntoForm();
  if (settingsForRenderer.serverUrl && settingsForRenderer.apiKey) {
    loadLibrary();
  }
});
