// ── Settings cache (for cover URLs etc) ──────────────────────
let settingsForRenderer = {};

async function initSettings() {
  settingsForRenderer = await window.api.getSettings();
}

// ── Icon helper ───────────────────────────────────────────────
// Returns an SVG element referencing the sprite symbol by id.
function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${id}`);
  svg.appendChild(use);
  return svg;
}

// Returns an SVG icon as an HTML string (for innerHTML templates).
function iconHtml(id) {
  return `<svg class="icon"><use href="#icon-${id}"></use></svg>`;
}

// ── Navigation ────────────────────────────────────────────────
const views = {
  home: document.getElementById("view-home"),
  library: document.getElementById("view-library"),
  settings: document.getElementById("view-settings"),
  kindle: document.getElementById("view-kindle"),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle("hidden", k !== name);
  });
  document
    .getElementById("nav-home")
    .classList.toggle("active", name === "home");
  document
    .getElementById("nav-library")
    .classList.toggle("active", name === "library");
  document
    .getElementById("nav-settings")
    .classList.toggle("active", name === "settings");

  // Switching views always discards any library selection.
  selectedBooks.clear();
  updateBottomBar();
}

document.getElementById("nav-library").addEventListener("click", () => {
  showView("library");
  if (allBooks.length === 0) loadLibrary();
});
document.getElementById("nav-home").addEventListener("click", () => {
  showView("home");
  loadHome();
});
document.getElementById("nav-settings").addEventListener("click", () => {
  showView("settings");
  // Re-position the slider now that the panel is visible and has layout.
  requestAnimationFrame(() => {
    const active = document.querySelector(".auth-pill-btn.active");
    if (active) positionPillSlider(active);
  });
});

// ── Kindle Detection ──────────────────────────────────────────
let detectedKindles = [];
let selectedKindle = null;

// Sanitized stems of files currently on the selected Kindle.
// Updated whenever Kindle books are loaded; used to badge library cards.
let kindleBookStems = new Set();

// Shared sanitizer — matches the filename sanitization used during send.
const sanitizeTitle = (s) => s.replace(/[<>:"/\\|?*]/g, "_");

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
    kindleBookStems.clear();
    document.getElementById("search").dispatchEvent(new Event("input"));
    updateBottomBar();
    return;
  }

  // Check if any entry is a "busy" error (device seen but USB held by OS daemon)
  const busyEntry = detectedKindles.find((d) => d.error === "busy");
  if (busyEntry) {
    list.innerHTML = `
      <div class="no-device device-busy">
        ${iconHtml("alert")} <strong>${busyEntry.name}</strong> detected but busy<br>
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
      <div class="device-name">${iconHtml("smartphone")} ${device.name}</div>
      <div class="device-sub">${device.bookCount} book${device.bookCount !== 1 ? "s" : ""} on device</div>
    `;
    el.addEventListener("click", () => {
      document
        .querySelectorAll(".device-entry")
        .forEach((d) => d.classList.remove("selected"));
      el.classList.add("selected");
      selectedKindle = device;
      updateBottomBar();
      openKindleView(device);
    });
    list.appendChild(el);

    // Auto-select first device found
    if (i === 0) {
      selectedKindle = device;
      // Load Kindle books in the background immediately so on-Kindle badges
      // are accurate as soon as the device is detected, without waiting for
      // the user to open the Kindle view.
      loadKindleBooks(device).catch(() => {});
    }
  });

  updateBottomBar();
}

document
  .getElementById("refresh-devices")
  .addEventListener("click", refreshKindles);

// Auto-detect on load
refreshKindles();

// ── Kindle Device View ────────────────────────────────────────
async function openKindleView(device) {
  document.getElementById("kindle-view-title").textContent = device.name;
  document.getElementById("kindle-view-subtitle").textContent =
    device.storageName ? device.storageName : "";
  showView("kindle");
  await loadKindleBooks(device);
}

async function loadKindleBooks(device) {
  const listEl = document.getElementById("kindle-book-list");
  listEl.innerHTML = '<div class="empty-state">Loading books…</div>';

  const result = await window.api.listKindleBooks({ device });

  if (!result.ok) {
    listEl.innerHTML = `<div class="empty-state">Error: ${result.error}</div>`;
    return;
  }

  if (result.files.length === 0) {
    listEl.innerHTML =
      '<div class="empty-state">No books on this Kindle.</div>';
    return;
  }

  // Build lookups for matching Kindle files back to ABS library items.
  // Priority: ASIN (definitive) → sanitized title stem (fallback).
  const bookByAsin = new Map();
  const bookByTitle = new Map();
  for (const book of allBooks) {
    const asin = book.media?.metadata?.asin;
    const title = book.media?.metadata?.title;
    if (asin) bookByAsin.set(asin, book);
    if (title) bookByTitle.set(sanitizeTitle(title), book);
  }

  // Strip extension from filename to get the safe title key
  const stemFromFilename = (fname) => fname.replace(/\.[^.]+$/, "");

  // Populate the kindle stem set and re-render the library grid so "on Kindle"
  // badges appear immediately without requiring a manual refresh.
  // Track both ASIN and title-stem so renderGrid can match either way.
  kindleBookStems.clear();
  for (const { filename, asin } of result.files) {
    if (asin) {
      // Store the ASIN directly so renderGrid can look it up
      kindleBookStems.add(`asin:${asin}`);
    }
    kindleBookStems.add(stemFromFilename(filename));
  }
  // Re-render badges while preserving any active search filter.
  document.getElementById("search").dispatchEvent(new Event("input"));

  listEl.innerHTML = "";
  result.files.forEach(({ filename, asin }) => {
    const stem = stemFromFilename(filename);
    // ASIN match is definitive; fall back to sanitized title stem
    const matchedBook =
      (asin && bookByAsin.get(asin)) ?? bookByTitle.get(stem) ?? null;
    const hasCover = matchedBook && matchedBook.media?.coverPath;
    const displayTitle = matchedBook?.media?.metadata?.title ?? stem;
    const displayAuthor = matchedBook?.media?.metadata?.authorName ?? "";

    const row = document.createElement("div");
    row.className = "kindle-book-row";
    row.dataset.filename = filename;

    // Cover thumbnail
    const thumbEl = document.createElement("div");
    thumbEl.className = "kindle-book-thumb";
    if (hasCover) {
      const img = document.createElement("img");
      img.src = `${settingsForRenderer.serverUrl}/api/items/${matchedBook.id}/cover?token=${settingsForRenderer.apiKey}`;
      img.alt = "";
      img.onerror = () => {
        img.remove();
        thumbEl.appendChild(icon("book"));
      };
      thumbEl.appendChild(img);
    } else {
      thumbEl.appendChild(icon("book"));
    }

    // Text block
    const textEl = document.createElement("div");
    textEl.className = "kindle-book-text";

    const nameEl = document.createElement("span");
    nameEl.className = "kindle-book-name";
    nameEl.textContent = displayTitle;
    nameEl.title = filename;
    textEl.appendChild(nameEl);

    if (displayAuthor) {
      const authorEl = document.createElement("span");
      authorEl.className = "kindle-book-author";
      authorEl.textContent = displayAuthor;
      textEl.appendChild(authorEl);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "secondary kindle-remove-btn";
    removeBtn.appendChild(icon("trash"));
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      removeBtn.innerHTML = "";
      removeBtn.appendChild(icon("trash"));
      const res = await window.api.deleteKindleBook({ device, filename });
      if (res.ok) {
        row.classList.add("kindle-row-removed");
        // Fade out then remove
        setTimeout(() => row.remove(), 300);
        // Update book count in sidebar
        device.bookCount = Math.max(0, (device.bookCount ?? 1) - 1);
        document
          .querySelectorAll(".device-entry.selected .device-sub")
          .forEach((el) => {
            el.textContent = `${device.bookCount} book${device.bookCount !== 1 ? "s" : ""} on device`;
          });
      } else {
        removeBtn.disabled = false;
        removeBtn.innerHTML = "";
        removeBtn.appendChild(icon("trash"));
        // Show inline error
        let errEl = row.querySelector(".kindle-remove-error");
        if (!errEl) {
          errEl = document.createElement("span");
          errEl.className = "kindle-remove-error";
          row.appendChild(errEl);
        }
        errEl.textContent = res.error;
      }
    });

    row.appendChild(thumbEl);
    row.appendChild(textEl);
    row.appendChild(removeBtn);
    listEl.appendChild(row);
  });
}

document.getElementById("btn-back-to-library").addEventListener("click", () => {
  showView("library");
});

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

// ── Home (Personalized) View ──────────────────────────────────
// Mirrors the ABS Home page: shelves returned by /api/libraries/:id/personalized
// Each shelf has an id, label, type ('book' | 'series' | 'authors'), and entities.

// Shelf IDs that are relevant for ebook readers (skip audio-only shelves).
// We map the ABS shelf IDs to friendly display names where the label differs.
const HOME_SHELF_LABELS = {
  "continue-series": "Continue Series",
  "recently-added": "Recently Added",
  recommended: "Discover",
  "listen-again": "Read Again",
  // Fall through to shelf.label for anything else
};

// Shelves we never want to show regardless of what the server returns.
const HOME_SHELF_HIDDEN = new Set(["recent-series", "newest-authors"]);

let homeLoaded = false;

async function loadHome() {
  const container = document.getElementById("home-shelves");

  // Only re-fetch if we don't have a library yet.
  if (!currentLibraryId) {
    // Make sure the library list has been fetched so we have an ID.
    const libraries = await window.api.getLibraries();
    if (libraries?.error) {
      container.innerHTML = `<div class="empty-state">Error: ${libraries.error}</div>`;
      return;
    }
    const bookLibs = (libraries || []).filter((l) => l.mediaType === "book");
    if (bookLibs.length === 0) {
      container.innerHTML =
        '<div class="empty-state">No book libraries found.</div>';
      return;
    }
    currentLibraryId = bookLibs[0].id;
  }

  container.innerHTML = '<div class="empty-state">Loading…</div>';
  homeLoaded = false;

  const result = await window.api.getPersonalized({
    libraryId: currentLibraryId,
  });

  if (!result.ok) {
    container.innerHTML = `<div class="empty-state">Error: ${result.error}</div>`;
    return;
  }

  renderHomeShelves(result.shelves, container);
  homeLoaded = true;
}

function renderHomeShelves(shelves, container) {
  container.innerHTML = "";

  // Filter to shelves we care about; keep original order from the server.
  const visibleShelves = shelves.filter((s) => {
    if (s.entities.length === 0) return false;
    // Skip podcast/episode-only shelves — we only handle ebooks here.
    if (s.type === "episode") return false;
    // Skip explicitly hidden shelves.
    if (HOME_SHELF_HIDDEN.has(s.id)) return false;
    return true;
  });

  if (visibleShelves.length === 0) {
    container.innerHTML =
      '<div class="empty-state">Nothing to show yet. Start reading on ABS to populate your Home page.</div>';
    return;
  }

  for (const shelf of visibleShelves) {
    const label = HOME_SHELF_LABELS[shelf.id] ?? shelf.label;
    const section = document.createElement("section");
    section.className = "home-shelf";
    section.dataset.shelfId = shelf.id;

    const heading = document.createElement("h2");
    heading.className = "home-shelf-heading";
    heading.textContent = label;
    section.appendChild(heading);

    const row = document.createElement("div");
    row.className = "home-shelf-row";

    if (shelf.type === "series") {
      shelf.entities.forEach((series) => {
        row.appendChild(buildSeriesCard(series));
      });
    } else {
      // 'book' type — render normal book cards (selectable for Send to Kindle)
      shelf.entities.forEach((item) => {
        row.appendChild(buildHomeBookCard(item));
      });
    }

    section.appendChild(row);
    container.appendChild(section);
  }
}

// Book card for the home shelves — same selectable behaviour as the library grid.
function buildHomeBookCard(item) {
  const meta = item.media?.metadata ?? {};
  const title = meta.title ?? "Untitled";
  const author = meta.authorName ?? "";
  const hasCover = !!item.media?.coverPath;
  const asin = meta.asin ?? null;

  const card = document.createElement("div");
  card.className = "home-book-card";
  card.dataset.id = item.id;

  // On-Kindle badge check
  const asinKey = asin ? `asin:${asin}` : null;
  const isOnKindle =
    (asinKey !== null && kindleBookStems.has(asinKey)) ||
    kindleBookStems.has(sanitizeTitle(title));

  const coverEl = document.createElement("div");
  coverEl.className = "home-book-cover";
  if (hasCover) {
    const img = document.createElement("img");
    img.src = `${settingsForRenderer.serverUrl}/api/items/${item.id}/cover?token=${settingsForRenderer.apiKey}`;
    img.alt = "";
    img.addEventListener("error", () => {
      img.remove();
      coverEl.classList.add("home-book-cover--placeholder");
      coverEl.appendChild(icon("book"));
    });
    coverEl.appendChild(img);
  } else {
    coverEl.classList.add("home-book-cover--placeholder");
    coverEl.appendChild(icon("book"));
  }

  // ASIN status badge (top-right) — same logic as the library grid
  const asinState = asin ? "ok" : "missing";
  const asinLabel = asin ? "ASIN present" : "No ASIN in metadata";
  const asinBadge = document.createElement("div");
  asinBadge.className = `asin-badge asin-${asinState}`;
  asinBadge.setAttribute("aria-label", asinLabel);
  asinBadge.innerHTML =
    `<svg viewBox="0 0 16 16"><use href="#icon-asin-${asinState}"></use></svg>` +
    `<span class="asin-badge-label">${asinLabel}</span>`;
  coverEl.appendChild(asinBadge);

  if (isOnKindle) {
    const badge = document.createElement("div");
    badge.className = "on-kindle-badge";
    badge.setAttribute("aria-label", "Already on Kindle");
    badge.innerHTML =
      `<svg viewBox="0 0 16 16"><use href="#icon-smartphone"></use></svg>` +
      `<span class="on-kindle-badge-label">On Kindle</span>`;
    coverEl.appendChild(badge);
  }

  const titleEl = document.createElement("div");
  titleEl.className = "home-book-title";
  titleEl.title = title;
  titleEl.textContent = title;

  const authorEl = document.createElement("div");
  authorEl.className = "home-book-author";
  authorEl.textContent = author;

  card.appendChild(coverEl);
  card.appendChild(titleEl);
  if (author) card.appendChild(authorEl);

  card.addEventListener("click", () => {
    const isSelected = card.classList.toggle("selected");
    if (isSelected) {
      selectedBooks.add(item.id);
    } else {
      selectedBooks.delete(item.id);
    }
    updateBottomBar();
  });

  return card;
}

// Series card — shows a mosaic of up to 4 book covers, series name, book count.
function buildSeriesCard(series) {
  const card = document.createElement("div");
  card.className = "home-series-card";

  const mosaic = document.createElement("div");
  mosaic.className = "home-series-mosaic";

  const books = series.books ?? [];
  const previewBooks = books.slice(0, 4);

  if (previewBooks.length === 0) {
    mosaic.classList.add("home-series-mosaic--empty");
    mosaic.appendChild(icon("book"));
  } else {
    previewBooks.forEach((b) => {
      const img = document.createElement("img");
      img.src = `${settingsForRenderer.serverUrl}/api/items/${b.id}/cover?token=${settingsForRenderer.apiKey}`;
      img.alt = "";
      img.addEventListener("error", () => {
        img.remove();
        const ph = document.createElement("div");
        ph.className = "home-series-mosaic-ph";
        ph.appendChild(icon("book"));
        mosaic.appendChild(ph);
      });
      mosaic.appendChild(img);
    });
  }

  const nameEl = document.createElement("div");
  nameEl.className = "home-series-name";
  nameEl.title = series.name;
  nameEl.textContent = series.name;

  const countEl = document.createElement("div");
  countEl.className = "home-series-count";
  const n = books.length;
  countEl.textContent = `${n} book${n !== 1 ? "s" : ""}`;

  card.appendChild(mosaic);
  card.appendChild(nameEl);
  card.appendChild(countEl);
  return card;
}

// ── Library ───────────────────────────────────────────────────
let allBooks = [];
let selectedBooks = new Set();
let currentLibraryId = null;

async function loadLibrary() {
  const grid = document.getElementById("book-grid");
  const isFirstLoad = allBooks.length === 0;

  // On first load show a placeholder; on subsequent refreshes keep the
  // existing cards visible so the search filter isn't blown away.
  if (isFirstLoad) {
    grid.innerHTML = '<div class="empty-state">Loading libraries…</div>';
  }

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

  if (isFirstLoad) {
    grid.innerHTML = '<div class="empty-state">Loading books…</div>';
  }

  const result = await window.api.getBooks({ libraryId: currentLibraryId });

  if (result?.error) {
    grid.innerHTML = `<div class="empty-state">Error: ${result.error}</div>`;
    return;
  }

  allBooks = result.results ?? [];
  document.getElementById("search").dispatchEvent(new Event("input"));
}

function renderGrid(books) {
  const grid = document.getElementById("book-grid");

  // Changing the grid always invalidates the current selection.
  selectedBooks.clear();
  updateBottomBar();

  if (books.length === 0) {
    grid.innerHTML = '<div class="empty-state">No books found.</div>';
    return;
  }

  grid.innerHTML = "";
  books.forEach((book) => {
    const meta = book.media?.metadata ?? {};
    const title = meta.title ?? "Untitled";
    const author = meta.authorName ?? "Unknown";
    const hasCover = !!book.media?.coverPath;

    // ── ASIN badge state ─────────────────────────────────────
    // 'ok'      → ASIN present (green check)
    // 'missing' → no ASIN (amber dash)
    // 'error'   → reserved for future use, e.g. malformed ASIN (red ×)
    const asinState = meta.asin ? "ok" : "missing";
    const asinBadgeIcon = {
      ok: "asin-ok",
      missing: "asin-missing",
      error: "asin-error",
    }[asinState];
    const asinLabel = {
      ok: "ASIN present",
      missing: "No ASIN in metadata",
      error: "Metadata error",
    }[asinState];

    const card = document.createElement("div");
    card.className = "book-card";
    card.dataset.id = book.id;

    // ── On-Kindle indicator ──────────────────────────────────
    // Match by ASIN first (definitive), fall back to sanitized title stem.
    const asinKey = meta.asin ? `asin:${meta.asin}` : null;
    const isOnKindle =
      (asinKey !== null && kindleBookStems.has(asinKey)) ||
      kindleBookStems.has(sanitizeTitle(title));

    // Cover element — use <img> with SVG icon fallback, or just the icon
    const coverEl = document.createElement("div");
    coverEl.className = "book-cover-wrap";
    if (hasCover) {
      const img = document.createElement("img");
      img.className = "book-cover";
      img.src = `${settingsForRenderer.serverUrl}/api/items/${book.id}/cover?token=${settingsForRenderer.apiKey}`;
      img.alt = "";
      img.addEventListener("error", () => {
        img.remove();
        coverEl.classList.add("book-cover-placeholder");
        coverEl.appendChild(icon("book"));
      });
      coverEl.appendChild(img);
    } else {
      coverEl.classList.add("book-cover-placeholder");
      coverEl.appendChild(icon("book"));
    }

    // ASIN status badge (top-right of cover)
    const badge = document.createElement("div");
    badge.className = `asin-badge asin-${asinState}`;
    badge.setAttribute("aria-label", asinLabel);
    badge.innerHTML =
      `<svg viewBox="0 0 16 16"><use href="#icon-${asinBadgeIcon}"></use></svg>` +
      `<span class="asin-badge-label">${asinLabel}</span>`;
    coverEl.appendChild(badge);

    // On-Kindle badge (bottom-left of cover)
    if (isOnKindle) {
      const kindleBadge = document.createElement("div");
      kindleBadge.className = "on-kindle-badge";
      kindleBadge.setAttribute("aria-label", "Already on Kindle");
      kindleBadge.innerHTML =
        `<svg viewBox="0 0 16 16"><use href="#icon-smartphone"></use></svg>` +
        `<span class="on-kindle-badge-label">On Kindle</span>`;
      coverEl.appendChild(kindleBadge);
    }

    const titleEl = document.createElement("div");
    titleEl.className = "book-title";
    titleEl.title = title;
    titleEl.textContent = title;

    const authorEl = document.createElement("div");
    authorEl.className = "book-author";
    authorEl.textContent = author;

    card.appendChild(coverEl);
    card.appendChild(titleEl);
    card.appendChild(authorEl);

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

// ── Transfer Progress Overlay ─────────────────────────────────
// Maps itemId → { rowEl, stepEl, iconEl } for live updates.
const txferRowMap = new Map();

// Step labels shown in each book row as the transfer advances.
const TXFER_STEP_LABELS = {
  downloading: "Downloading…",
  converting: "Converting to AZW3…",
  copying: "Copying to Kindle…",
  done: "Done",
  error: "Error",
  "dolphin-blocking": "Device busy",
};

// Icon id for each step state.
const TXFER_STEP_ICON = {
  downloading: "download",
  converting: "refresh", // spinner
  copying: "copy",
  done: "check",
  error: "x",
  "dolphin-blocking": "alert",
};

function showTransferOverlay(itemIds) {
  const overlay = document.getElementById("transfer-overlay");
  const listEl = document.getElementById("transfer-book-list");
  const fill = document.getElementById("transfer-progress-fill");
  const countLabel = document.getElementById("transfer-count-label");
  const titleEl = document.getElementById("transfer-title");
  const footer = document.getElementById("transfer-footer");

  txferRowMap.clear();
  listEl.innerHTML = "";
  fill.style.width = "0%";
  titleEl.textContent = "Sending to Kindle…";
  countLabel.textContent = `0 / ${itemIds.length}`;
  footer.classList.add("hidden");
  overlay.classList.remove("hidden");

  for (const id of itemIds) {
    const book = allBooks.find((b) => b.id === id);
    const title = book?.media?.metadata?.title ?? id;

    const row = document.createElement("div");
    row.className = "txfer-row";

    const iconWrap = document.createElement("div");
    iconWrap.className = "txfer-icon";
    iconWrap.appendChild(icon("refresh"));

    const textWrap = document.createElement("div");
    textWrap.className = "txfer-text";

    const titleEl2 = document.createElement("div");
    titleEl2.className = "txfer-title";
    titleEl2.title = title;
    titleEl2.textContent = title;

    const stepEl = document.createElement("div");
    stepEl.className = "txfer-step";
    stepEl.textContent = "Waiting…";

    textWrap.appendChild(titleEl2);
    textWrap.appendChild(stepEl);
    row.appendChild(iconWrap);
    row.appendChild(textWrap);
    listEl.appendChild(row);

    txferRowMap.set(id, { row, iconWrap, stepEl });
  }
}

function updateTransferRow(itemId, status, title, error, current, total) {
  const entry = txferRowMap.get(itemId);
  const fill = document.getElementById("transfer-progress-fill");
  const countLabel = document.getElementById("transfer-count-label");

  if (entry) {
    const { row, iconWrap, stepEl } = entry;

    // Update step label
    stepEl.textContent =
      status === "error" && error
        ? error
        : (TXFER_STEP_LABELS[status] ?? status);

    // Swap icon
    const iconId = TXFER_STEP_ICON[status] ?? "refresh";
    iconWrap.innerHTML = "";
    const svgEl = icon(iconId);
    if (status === "converting") {
      svgEl.classList.add("txfer-icon-spin");
    }
    iconWrap.appendChild(svgEl);

    // Row colour state
    row.classList.remove("txfer-active", "txfer-done", "txfer-error");
    if (status === "done") {
      row.classList.add("txfer-done");
    } else if (status === "error" || status === "dolphin-blocking") {
      row.classList.add("txfer-error");
    } else {
      row.classList.add("txfer-active");
    }

    // Use the title from the event if we have it (more reliable than the
    // pre-populated placeholder which might be the raw ABS item id)
    if (title) {
      const titleEl2 = row.querySelector(".txfer-title");
      if (titleEl2) titleEl2.textContent = title;
    }
  }

  // Update overall progress bar — count how many rows are terminal
  const doneCount = Array.from(txferRowMap.values()).filter(
    (e) =>
      e.row.classList.contains("txfer-done") ||
      e.row.classList.contains("txfer-error"),
  ).length;

  if (total > 0) {
    fill.style.width = `${Math.round((doneCount / total) * 100)}%`;
    countLabel.textContent = `${doneCount} / ${total}`;
  }
}

function finalizeTransferOverlay(succeeded, failed) {
  const titleEl = document.getElementById("transfer-title");
  const footer = document.getElementById("transfer-footer");
  const fill = document.getElementById("transfer-progress-fill");
  const total = txferRowMap.size;

  fill.style.width = "100%";

  const dolphinBlocking = failed.some((r) => r.error === "dolphin-blocking");
  if (dolphinBlocking) {
    titleEl.textContent = "Device busy — close Dolphin and retry";
  } else if (failed.length === 0) {
    titleEl.textContent = `${succeeded.length} book${succeeded.length > 1 ? "s" : ""} sent successfully`;
  } else if (succeeded.length === 0) {
    titleEl.textContent = `All ${failed.length} transfers failed`;
  } else {
    titleEl.textContent = `${succeeded.length} sent, ${failed.length} failed`;
  }

  footer.classList.remove("hidden");
}

document.getElementById("btn-transfer-close").addEventListener("click", () => {
  document.getElementById("transfer-overlay").classList.add("hidden");
});

document.getElementById("btn-send").addEventListener("click", async () => {
  if (selectedBooks.size === 0 || !selectedKindle) return;

  const btn = document.getElementById("btn-send");
  const label = document.getElementById("selection-label");
  btn.disabled = true;

  const itemIds = Array.from(selectedBooks);
  showTransferOverlay(itemIds);

  const removeListener = window.api.onTransferProgress(
    ({ current, total, itemId, status, title, error }) => {
      updateTransferRow(itemId, status, title, error, current, total);

      // Keep the bottom bar label updated as a brief summary
      if (status === "done") {
        label.innerHTML = `${iconHtml("check")} ${current} of ${total} done`;
      } else if (status === "error") {
        label.innerHTML = `${iconHtml("x")} Error on ${current} of ${total}`;
      } else if (status === "dolphin-blocking") {
        label.innerHTML = `${iconHtml("alert")} Device busy`;
      }
    },
  );

  try {
    const results = await window.api.sendToKindle({
      itemIds,
      kindleDocumentsPath: selectedKindle.documentsPath,
      device: selectedKindle,
    });

    removeListener();

    const succeeded = results.results.filter((r) => r.ok);
    const failed = results.results.filter((r) => !r.ok);
    const dolphinBlocking = failed.some((r) => r.error === "dolphin-blocking");

    finalizeTransferOverlay(succeeded, failed);

    if (dolphinBlocking) {
      label.innerHTML = `${iconHtml("alert")} Dolphin may be holding the device. Close any Dolphin windows showing your Kindle and try again.`;
    } else if (failed.length === 0) {
      label.innerHTML = `${iconHtml("check")} ${succeeded.length} book${succeeded.length > 1 ? "s" : ""} sent to ${selectedKindle.name}`;
    } else if (succeeded.length === 0) {
      label.innerHTML = `${iconHtml("x")} All ${failed.length} transfers failed`;
    } else {
      label.innerHTML = `${iconHtml("check")} ${succeeded.length} sent  ${iconHtml("x")} ${failed.length} failed`;
    }

    // Optimistically mark successfully-sent books as on-Kindle and re-render
    // badges immediately — no network refresh needed.
    const succeededIds = new Set(succeeded.map((r) => r.itemId));
    for (const book of allBooks) {
      if (!succeededIds.has(book.id)) continue;
      const title = book.media?.metadata?.title;
      const asin = book.media?.metadata?.asin;
      if (asin) kindleBookStems.add(`asin:${asin}`);
      if (title) kindleBookStems.add(sanitizeTitle(title));
    }

    if (succeededIds.size > 0) {
      // Re-render in place so on-Kindle badges appear immediately,
      // preserving whatever search filter is active.
      document.getElementById("search").dispatchEvent(new Event("input"));
    }
  } catch (e) {
    removeListener();
    label.innerHTML = `${iconHtml("x")} Transfer failed: ${e.message}`;
    finalizeTransferOverlay([], [{ error: e.message }]);
  }

  // Clear selection regardless of outcome
  selectedBooks.clear();
  document
    .querySelectorAll(".book-card.selected, .home-book-card.selected")
    .forEach((c) => c.classList.remove("selected"));
  btn.disabled = true;

  // Refresh Kindle sidebar book count to reflect new files
  refreshKindles();
});

// ── Settings & Auth ───────────────────────────────────────────

// ── Pill toggle ───────────────────────────────────────────────
// Positions the sliding highlight under the active pill button.
function positionPillSlider(activeBtn) {
  const track = activeBtn.closest(".auth-pill-track");
  const slider = track.querySelector(".auth-pill-slider");
  slider.style.width = `${activeBtn.offsetWidth}px`;
  slider.style.transform = `translateX(${activeBtn.offsetLeft - 3}px)`;
}

function setAuthMethod(method) {
  const isOidc = method === "oidc";
  const apikeyBtn = document.getElementById("pill-btn-apikey");
  const oidcBtn = document.getElementById("pill-btn-oidc");
  const track = document.getElementById("auth-panels-track");
  const oidcLoginBtn = document.getElementById("btn-oidc-login");

  apikeyBtn.classList.toggle("active", !isOidc);
  oidcBtn.classList.toggle("active", isOidc);
  track.classList.toggle("show-oidc", isOidc);
  // Hide the SSO button when the API Key panel is active
  oidcLoginBtn.classList.toggle("hidden", !isOidc);

  positionPillSlider(isOidc ? oidcBtn : apikeyBtn);
}

// Enable or disable the "Sign in with SSO" button based on server capability.
// The pill toggle itself is always clickable; the button inside the OIDC panel
// is what gets greyed out when the server doesn't have OIDC configured.
function setOidcPillAvailable(available) {
  const oidcLoginBtn = document.getElementById("btn-oidc-login");
  const oidcResult = document.getElementById("oidc-result");
  oidcLoginBtn.disabled = !available;
  if (!available) {
    oidcResult.innerHTML = `${iconHtml("x")} This server does not have OIDC / SSO configured. Make sure you're running ABS 3.5+ and that OIDC is set up correctly.`;
    oidcResult.className = "err";
  } else {
    // Clear any stale "not configured" message; leave success messages intact.
    if (
      oidcResult.className === "err" &&
      oidcResult.textContent.includes("OIDC")
    ) {
      oidcResult.textContent = "";
      oidcResult.className = "";
    }
  }
}

// Pill button clicks
document.getElementById("pill-btn-apikey").addEventListener("click", () => {
  setAuthMethod("apikey");
});
document.getElementById("pill-btn-oidc").addEventListener("click", () => {
  setAuthMethod("oidc");
});

// ── URL auto-save ─────────────────────────────────────────────
let urlSaveTimer = null;
const urlSavedBadge = document.getElementById("url-saved-badge");

function flashUrlSaved(ok) {
  urlSavedBadge.classList.remove("visible", "err");
  // Swap the icon to match the outcome.
  urlSavedBadge
    .querySelector("use")
    .setAttribute("href", ok ? "#icon-check" : "#icon-x");
  // Force reflow so re-adding the class re-triggers the CSS transition.
  void urlSavedBadge.offsetWidth;
  urlSavedBadge.classList.toggle("err", !ok);
  urlSavedBadge.classList.add("visible");
  clearTimeout(urlSavedBadge._hideTimer);
  urlSavedBadge._hideTimer = setTimeout(() => {
    urlSavedBadge.classList.remove("visible");
  }, 2000);
}

document.getElementById("input-url").addEventListener("input", () => {
  clearTimeout(urlSaveTimer);
  // Hide badge while the user is still typing.
  urlSavedBadge.classList.remove("visible");
  // Immediately disable OIDC pill whenever the URL changes — it will be
  // re-enabled only if the new URL turns out to be a valid ABS server with
  // OIDC configured.
  setOidcPillAvailable(false);

  urlSaveTimer = setTimeout(async () => {
    const serverUrl = document
      .getElementById("input-url")
      .value.trim()
      .replace(/\/$/, "");

    if (!serverUrl) return;

    // Validate that the URL points to a real ABS instance before saving.
    const ping = await window.api.pingServer({ serverUrl });
    if (!ping.ok) {
      flashUrlSaved(false);
      return;
    }

    // Check whether the server has OIDC enabled and update the pill accordingly.
    const oidcCheck = await window.api.checkOidcAvailable({ serverUrl });
    setOidcPillAvailable(oidcCheck.available);

    const currentMethod = document
      .getElementById("pill-btn-oidc")
      .classList.contains("active")
      ? "oidc"
      : "apikey";
    await window.api.saveSettings({ serverUrl, authMethod: currentMethod });
    flashUrlSaved(true);
  }, 800);
});

// ── API Key panel ─────────────────────────────────────────────
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
    el.innerHTML = `${iconHtml("check")} Connected — ${result.count} librar${result.count === 1 ? "y" : "ies"} found`;
    el.className = "ok";
  } else {
    el.innerHTML = `${iconHtml("x")} ${result.error}`;
    el.className = "err";
  }
});

// ── OIDC panel ────────────────────────────────────────────────
document
  .getElementById("btn-oidc-login")
  .addEventListener("click", async () => {
    const btn = document.getElementById("btn-oidc-login");
    const el = document.getElementById("oidc-result");
    const serverUrl = document
      .getElementById("input-url")
      .value.trim()
      .replace(/\/$/, "");

    if (!serverUrl) {
      el.innerHTML = `${iconHtml("x")} Enter the Server URL first.`;
      el.className = "err";
      return;
    }

    btn.disabled = true;
    el.textContent = "Opening login window…";
    el.className = "";

    const result = await window.api.startOidcLogin({ serverUrl });

    btn.disabled = false;

    if (result.ok) {
      // Persist the token as apiKey so all existing API calls continue to work.
      await window.api.saveSettings({
        serverUrl,
        apiKey: result.token,
        authMethod: "oidc",
      });
      settingsForRenderer = await window.api.getSettings();
      el.innerHTML = `${iconHtml("check")} Signed in successfully.`;
      el.className = "ok";
      // Trigger library load now that we have a valid token.
      loadLibrary();
    } else {
      el.innerHTML = `${iconHtml("x")} ${result.error}`;
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
  // Restore whichever auth method was saved last.
  // Use rAF so the pill buttons have a valid offsetWidth even when the
  // settings view is initially hidden (the nav click will also reposition).
  const restoredMethod =
    settingsForRenderer.authMethod === "oidc" ? "oidc" : "apikey";
  requestAnimationFrame(() => setAuthMethod(restoredMethod));

  // Check OIDC availability and update pill state.
  // Do this after rAF so setAuthMethod has already run.
  if (settingsForRenderer.serverUrl) {
    window.api
      .checkOidcAvailable({ serverUrl: settingsForRenderer.serverUrl })
      .then((r) => setOidcPillAvailable(r.available));
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  await initSettings();
  loadSettingsIntoForm();
  if (settingsForRenderer.serverUrl && settingsForRenderer.apiKey) {
    loadLibrary();
  }
});
