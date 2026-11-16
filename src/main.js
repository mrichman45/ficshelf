import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import ePub from "epubjs";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

// Android differs in three ways that matter here: the file picker returns
// content:// links rather than paths, there is no keyboard or right-click,
// and there is no system keyring to keep a password in.
const IS_ANDROID = /android/i.test(navigator.userAgent);
document.documentElement.classList.toggle("android", IS_ANDROID);

const $ = (sel) => document.querySelector(sel);

// ------------------------------------------------------------------ prefs
//
// Small per-device preferences (theme, reading font) live in localStorage.
// Every access is guarded: storage can be unavailable, and a preference is
// never worth failing over.

function pref(key, fallback) {
  try {
    return localStorage.getItem(`ficshelf.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function setPref(key, value) {
  try {
    localStorage.setItem(`ficshelf.${key}`, value);
  } catch {
    /* lasts until the app closes */
  }
}

// ------------------------------------------------------------------ theme

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let readerRestyle = null; // set while an EPUB is open

/// "light", "dark" or "sepia": what is actually on screen right now.
function effectiveTheme() {
  const choice = pref("theme", "system");
  if (choice === "system") return darkQuery.matches ? "dark" : "light";
  return choice;
}

function applyTheme() {
  const choice = pref("theme", "system");
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  document.querySelectorAll("[data-theme-choice]").forEach((b) => {
    b.classList.toggle("active", b.dataset.themeChoice === choice);
    b.setAttribute("aria-checked", String(b.dataset.themeChoice === choice));
  });
  // An open book follows along. (A hook rather than `state`, which does
  // not exist yet the first time this runs.)
  readerRestyle?.();
}

applyTheme();
darkQuery.addEventListener?.("change", applyTheme);

// Release builds on Android send nothing to the system log, so any error
// that would otherwise vanish is shown on screen instead.
window.addEventListener("error", (e) => toast(`Something went wrong: ${e.message}`, true));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  toast(`Something went wrong: ${typeof r === "string" ? r : r?.message || String(r)}`, true);
});
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  books: [],
  filter: "",
  sort: "added",
  libView: "all", // "all" or "series"
  openSeries: null, // the group key being looked at in the Series view
  reader: null, // { book, kind, cleanup, next, prev }
};

// ------------------------------------------------------------- plumbing

function toast(message, bad = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), bad ? 7000 : 3500);
}

async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(typeof e === "string" ? e : String(e), true);
    throw e;
  }
}

// window.confirm and window.prompt are not available in the Android webview,
// so questions go through the dialog plugin, which works everywhere.
async function confirmAsk(message) {
  try {
    return await ask(message, { title: "FicShelf", kind: "warning" });
  } catch {
    return window.confirm(message);
  }
}

function show(view) {
  if (view !== "reader") closeReader();
  if (view === "bookmarks" && !shelfState.loadedOnce) loadShelf(true);
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
}

$$("#nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

// -------------------------------------------------------------- library

async function refreshLibrary() {
  state.books = await call("list_books", { sort: state.sort });
  renderShelf();
  await refreshUpdateBadge();
}

function matchesFilter(book) {
  if (!state.filter) return true;
  const needle = state.filter.toLowerCase();
  return [book.title, book.author, book.series, book.folder].some((v) =>
    (v || "").toLowerCase().includes(needle),
  );
}

// ---------------------------------------------------------------- series
//
// A book's group is its series when it has one, otherwise the folder it was
// added from, otherwise "Other books".

const OTHER = "Other books";

function groupOf(book) {
  return book.series || book.folder || OTHER;
}

function seriesOrder(a, b) {
  const ai = a.series_index ?? Infinity;
  const bi = b.series_index ?? Infinity;
  if (ai !== bi) return ai - bi;
  return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
}

function formatIndex(n) {
  return Number.isInteger(n) ? String(n) : String(n);
}

function groups(books) {
  const map = new Map();
  for (const b of books) {
    const key = groupOf(b);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(b);
  }
  for (const list of map.values()) list.sort(seriesOrder);
  return [...map.entries()].sort(([a], [b]) => {
    if (a === OTHER) return 1;
    if (b === OTHER) return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  });
}

$$(".tabs button[data-libview]").forEach((b) =>
  b.addEventListener("click", () => {
    state.libView = b.dataset.libview;
    state.openSeries = null;
    $$(".tabs button[data-libview]").forEach((x) => x.classList.toggle("active", x === b));
    renderShelf();
  }),
);

$("#btn-series-back").addEventListener("click", () => {
  state.openSeries = null;
  renderShelf();
});

// --------------------------------------------------------------- shelf

function coverInto(holder, bookId) {
  invoke("book_cover", { id: bookId })
    .then((url) => {
      if (!url) return;
      const img = document.createElement("img");
      img.className = "cover";
      img.src = url;
      img.alt = "";
      holder.replaceWith(img);
    })
    .catch(() => {});
}

function cardShell(titleText, subText, coverBook) {
  const card = document.createElement("div");
  card.className = "card";
  const holder = document.createElement("div");
  holder.className = "placeholder";
  holder.textContent = titleText;
  card.appendChild(holder);
  if (coverBook?.has_cover) coverInto(holder, coverBook.id);

  const meta = document.createElement("div");
  meta.className = "meta";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = titleText;
  const a = document.createElement("div");
  a.className = "a";
  a.textContent = subText || "";
  meta.append(t, a);
  card.appendChild(meta);
  return card;
}

function bookCard(book, { showNumber = false } = {}) {
  const card = cardShell(book.title, book.author, book);
  card.title = book.missing ? `Missing: ${book.path}` : book.path;

  const fmt = document.createElement("span");
  fmt.className = "fmt";
  fmt.textContent = book.format;
  card.appendChild(fmt);

  if (book.drm) {
    const badge = document.createElement("span");
    badge.className = "badge lock";
    badge.textContent = "🔒";
    badge.title = `Locked with ${book.drm}`;
    card.appendChild(badge);
  } else if (book.has_update) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "new";
    card.appendChild(badge);
  } else if (book.missing) {
    const badge = document.createElement("span");
    badge.className = "badge warn";
    badge.textContent = "missing";
    card.appendChild(badge);
  } else if (showNumber && book.series_index != null) {
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = `#${formatIndex(book.series_index)}`;
    card.appendChild(num);
  }

  let pressedLong = false;
  card.addEventListener("click", () => {
    if (pressedLong) {
      pressedLong = false;
      return;
    }
    if (book.drm) openLocked(book);
    else openBook(book.id);
  });
  if (IS_ANDROID) {
    onLongPress(card, () => {
      pressedLong = true;
      openBookMenu(book);
    });
  } else {
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openBookMenu(book);
    });
  }
  return card;
}

function seriesCard(name, books) {
  const card = cardShell(name, `${books.length} book${books.length === 1 ? "" : "s"}`, books.find((b) => b.has_cover) || books[0]);
  card.classList.add("series-card");
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(books.length);
  card.appendChild(count);
  card.addEventListener("click", () => {
    state.openSeries = name;
    renderShelf();
    $("#view-library").scrollTop = 0;
  });
  return card;
}

function renderShelf() {
  const shelf = $("#shelf");
  shelf.textContent = "";
  $("#library-empty").hidden = state.books.length > 0;
  const visible = state.books.filter(matchesFilter);

  const head = $("#series-head");
  head.hidden = !(state.libView === "series" && state.openSeries);

  if (state.libView === "all") {
    for (const book of visible) shelf.appendChild(bookCard(book));
    return;
  }

  const all = groups(visible);
  if (state.openSeries) {
    const entry = all.find(([k]) => k === state.openSeries);
    if (!entry) {
      // The series emptied (everything removed or renamed): back to the list.
      state.openSeries = null;
      return renderShelf();
    }
    $("#series-name").textContent = entry[0];
    for (const book of entry[1]) shelf.appendChild(bookCard(book, { showNumber: true }));
    return;
  }
  for (const [name, books] of all) shelf.appendChild(seriesCard(name, books));
}

// ----------------------------------------------------------- locked books
//
// FicShelf cannot open a DRM-locked book; only software licensed for that
// DRM can. It keeps the book in the library and hands it to such an app.

const MIME = { epub: "application/epub+zip", pdf: "application/pdf" };

async function openLocked(book) {
  if (IS_ANDROID) {
    const ok = window.FicShelfAndroid?.openExternally?.(book.path, MIME[book.format] || "*/*");
    if (!ok) {
      toast(
        `“${book.title}” is locked with ${book.drm}. Install a reader that supports it, such as PocketBook, then tap it again.`,
        true,
      );
    }
    return;
  }
  try {
    await invoke("open_externally", { id: book.id });
    toast(`Opening “${book.title}” in your default reader. It is locked with ${book.drm}, which FicShelf cannot open.`);
  } catch (e) {
    toast(
      `“${book.title}” is locked with ${book.drm}. Install Adobe Digital Editions to read it. (${e})`,
      true,
    );
  }
}

// ------------------------------------------------------ menu and editing

let menuBook = null;

function openBookMenu(book) {
  menuBook = book;
  $("#book-menu-title").textContent = book.title;
  $("#book-menu").showModal();
}

$("#book-menu-cancel").addEventListener("click", () => $("#book-menu").close());
$("#book-menu").addEventListener("click", (e) => {
  // A tap on the dimmed backdrop closes the menu.
  if (e.target === $("#book-menu")) $("#book-menu").close();
});

$("#book-menu-remove").addEventListener("click", async () => {
  $("#book-menu").close();
  const book = menuBook;
  if (!book) return;
  if (await confirmAsk(`Remove "${book.title}" from the library?\n\nThe file itself is not deleted.`)) {
    await call("forget_book", { id: book.id });
    await refreshLibrary();
  }
});

$("#book-menu-edit").addEventListener("click", () => {
  $("#book-menu").close();
  const book = menuBook;
  if (!book) return;
  $("#edit-title").value = book.title;
  $("#edit-author").value = book.author || "";
  $("#edit-series").value = book.series || "";
  $("#edit-index").value = book.series_index ?? "";
  const names = [...new Set(state.books.map((b) => b.series).filter(Boolean))].sort();
  const list = $("#series-names");
  list.textContent = "";
  for (const n of names) {
    const o = document.createElement("option");
    o.value = n;
    list.appendChild(o);
  }
  $("#edit-dialog").showModal();
});

$("#edit-cancel").addEventListener("click", () => $("#edit-dialog").close());

$("#edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const book = menuBook;
  if (!book) return;
  const raw = $("#edit-index").value.trim();
  const index = raw === "" ? null : Number(raw);
  try {
    await call("update_metadata", {
      id: book.id,
      title: $("#edit-title").value,
      author: $("#edit-author").value,
      series: $("#edit-series").value,
      seriesIndex: Number.isFinite(index) ? index : null,
    });
  } catch {
    return; // the toast says why; leave the form open to fix it
  }
  $("#edit-dialog").close();
  // If the book moved to another series, follow it there.
  if (state.openSeries && state.libView === "series") {
    const moved = $("#edit-series").value.trim();
    if (moved) state.openSeries = moved;
  }
  await refreshLibrary();
  toast("Saved.");
});

/// Hold a finger still on `el` for about half a second.
function onLongPress(el, fn) {
  let timer = null;
  let start = null;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, 550);
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) cancel();
  }, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
  // The webview's own long-press menu would otherwise appear on top.
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

$("#filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderShelf();
});

$("#sort").addEventListener("change", async (e) => {
  state.sort = e.target.value;
  await refreshLibrary();
});

$("#btn-add-files").addEventListener("click", async () => {
  try {
    await addFiles();
  } catch (e) {
    toast(`Could not add files: ${typeof e === "string" ? e : e?.message || String(e)}`, true);
  }
});

async function addFiles() {
  const picked = await openDialog({
    multiple: true,
    // Android filters by MIME type and has none for CBZ, so a filter there
    // would hide comics; the backend checks each file's contents instead.
    filters: IS_ANDROID
      ? undefined
      : [{ name: "Books and comics", extensions: ["epub", "pdf", "cbz", "zip"] }],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  const report = IS_ANDROID ? await importByCopy(paths) : await call("import_paths", { paths });
  await refreshLibrary();
  reportImport(report);
}

/// Android: read each picked file through the system and hand the bytes to
/// the backend, which keeps a copy in the app's own storage.
async function importByCopy(uris) {
  const report = { added: [], skipped: [], failed: [] };
  for (const [i, uri] of uris.entries()) {
    const n = `${i + 1} of ${uris.length}`;
    let step = "copying it into the library";
    try {
      // The backend opens the link and copies the file itself, a piece at a
      // time; passing the contents through here would run a phone out of
      // memory on a large comic.
      toast(`Adding ${n}…`);
      const book = await invoke("import_uri", { uri });
      report.added.push(book);
    } catch (e) {
      const why = typeof e === "string" ? e : e?.message || String(e);
      report.failed.push([uri, `while ${step}: ${why}`]);
    }
  }
  return report;
}

// Android: the native side shows the system folder picker and answers with
// every book it found inside, which are then imported one at a time.
let folderPicked = null;
window.__ficshelfFolderPicked = (json) => {
  const resolve = folderPicked;
  folderPicked = null;
  resolve?.(json ? JSON.parse(json) : null);
};

async function addAndroidFolder() {
  if (!window.FicShelfAndroid?.pickFolder) {
    toast("This version cannot add folders yet.", true);
    return;
  }
  const items = await new Promise((resolve) => {
    folderPicked = resolve;
    window.FicShelfAndroid.pickFolder();
  });
  if (!items) return; // cancelled
  if (!items.length) {
    toast("No EPUB, PDF or CBZ files in that folder.", true);
    return;
  }
  const report = { added: [], skipped: [], failed: [] };
  for (const [i, item] of items.entries()) {
    toast(`Adding ${i + 1} of ${items.length}: ${item.name}`);
    try {
      report.added.push(await invoke("import_uri", { uri: item.uri, folder: item.folder }));
    } catch (e) {
      report.failed.push([item.name, typeof e === "string" ? e : e?.message || String(e)]);
    }
  }
  await refreshLibrary();
  reportImport(report);
}

$("#btn-add-folder").addEventListener("click", async () => {
  if (IS_ANDROID) {
    try {
      await addAndroidFolder();
    } catch (e) {
      toast(`Could not add the folder: ${e?.message || e}`, true);
    }
    return;
  }
  const dir = await openDialog({ directory: true });
  if (!dir) return;
  const report = await call("scan_folder", { path: dir, recursive: true });
  await refreshLibrary();
  reportImport(report);
});

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function reportImport(report) {
  const locked = report.added.filter((b) => b.drm);
  if (locked.length && !report.failed.length) {
    const what = locked.length === 1 ? `“${locked[0].title}” is` : `${locked.length} of them are`;
    toast(
      `${report.added.length} added. ${what} DRM-locked: tap to open in a reader app that supports it.`,
    );
    return;
  }
  const bits = [`${report.added.length} added`];
  if (report.skipped.length) bits.push(`${report.skipped.length} skipped`);
  if (report.failed.length) bits.push(`${report.failed.length} failed`);
  // With a single failure, say why right away rather than only counting it.
  if (report.failed.length === 1) bits.push(`— ${report.failed[0][1]}`);
  toast(bits.join(", "), report.failed.length > 0);
  if (report.failed.length) console.warn("Import failures:", report.failed);
}

// --------------------------------------------------------------- reader

function closeReader() {
  if (state.reader?.cleanup) {
    try {
      state.reader.cleanup();
    } catch {
      /* a reader that will not close cleanly must not trap the user */
    }
  }
  state.reader = null;
  setVolumePaging(false);
  $("#view-reader").classList.remove("kind-epub");
  $("#select-bar").hidden = true;
  $("#view-reader").classList.remove("immersive");
  $("#epub-area").hidden = true;
  $("#epub-area").textContent = "";
  $("#pdf-canvas").hidden = true;
  $("#cbz-image").hidden = true;
  $("#reader-error").hidden = true;
}

// ------------------------------------------------------- volume buttons
//
// On Android the native side catches the volume buttons while a book is
// open and calls this; everywhere else they change the volume as usual.
// Volume down is the next page, volume up the previous one.

const VOLUME_PAGING_KEY = "ficshelf.volumePaging";

function volumePagingWanted() {
  try {
    return localStorage.getItem(VOLUME_PAGING_KEY) !== "off";
  } catch {
    return true;
  }
}

function setVolumePaging(on) {
  try {
    window.FicShelfAndroid?.setVolumePaging(Boolean(on && volumePagingWanted()));
  } catch {
    /* not on Android, or an older build without the native half */
  }
}

window.__ficshelfPage = (dir) => {
  if (dir === "next") state.reader?.next?.();
  else state.reader?.prev?.();
};

// The Android back button walks the webview's history, so opening a book
// pushes an entry and going back closes the reader instead of the app.
function leaveReader() {
  if (history.state?.reader) history.back();
  else show("library");
}
window.addEventListener("popstate", () => {
  if (state.reader || $("#view-reader").classList.contains("active")) show("library");
});

$("#reader-back").addEventListener("click", leaveReader);
$("#reader-next").addEventListener("click", () => state.reader?.next?.());
$("#reader-prev").addEventListener("click", () => state.reader?.prev?.());

document.addEventListener("keydown", (e) => {
  if (!state.reader) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") state.reader.next?.();
  if (e.key === "ArrowLeft" || e.key === "PageUp") state.reader.prev?.();
  if (e.key === "Escape") leaveReader();
});

async function openBook(id) {
  const { book, pages } = await call("open_book", { id });
  if (book.missing) {
    toast(`That file is no longer at ${book.path}`, true);
    return;
  }

  closeReader();
  show("reader");
  setVolumePaging(true);
  if (!history.state?.reader) history.pushState({ reader: true }, "");
  $("#reader-title").textContent = book.title;
  $("#reader-progress").textContent = "";

  try {
    if (book.format === "epub") await openEpub(book);
    else if (book.format === "pdf") await openPdf(book);
    else await openCbz(book, pages);
  } catch (e) {
    $("#reader-error").hidden = false;
    $("#reader-error").textContent = `Could not open this file: ${e}`;
  }
}

function saveWhere(book, position) {
  invoke("save_position", { id: book.id, position: String(position) }).catch(() => {});
}

// ------------------------------------------------------------- touch
//
// Swipe left or right to turn the page; tap the outer thirds to do the same;
// tap the middle to hide or show the reader's toolbar.

function touchTurner(pageX) {
  let start = null;
  return {
    start(e) {
      const t = e.changedTouches?.[0];
      if (t) start = { x: t.screenX, y: t.screenY, at: Date.now() };
    },
    end(e) {
      const t = e.changedTouches?.[0];
      if (!t || !start || !state.reader) return;
      const dx = t.screenX - start.x;
      const dy = t.screenY - start.y;
      const quick = Date.now() - start.at < 350;
      start = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        dx < 0 ? state.reader.next?.() : state.reader.prev?.();
      } else if (quick && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        const x = pageX(t);
        if (x < 0.3) state.reader.prev?.();
        else if (x > 0.7) state.reader.next?.();
        else $("#view-reader").classList.toggle("immersive");
      }
    },
  };
}

// For the PDF and comic readers, which draw straight into the page.
const stageTouch = touchTurner((t) => t.clientX / window.innerWidth);
$("#reader-stage").addEventListener("touchstart", (e) => stageTouch.start(e), { passive: true });
$("#reader-stage").addEventListener("touchend", (e) => {
  if (state.reader && state.reader.kind !== "epub") stageTouch.end(e);
});

// Unfolding the Fold, or rotating a phone, changes the page size.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.reader?.resize?.(), 200);
});

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ------------------------------------------------- page colours and fonts

// The page inside an EPUB matches the app's theme. Dark and Sepia also set
// the text colour firmly, since a book that fixes its own black text would
// otherwise be unreadable on a dark page.
const PAGE_THEMES = {
  light: { bg: "#faf7f3", ink: "#201b18", link: "#9c5a28", force: false },
  dark: { bg: "#14110f", ink: "#e6dfd7", link: "#d9a070", force: true },
  sepia: { bg: "#f4ecd8", ink: "#3b2f22", link: "#8a5a2b", force: true },
};

function registerPageThemes(rendition) {
  for (const [name, t] of Object.entries(PAGE_THEMES)) {
    const imp = t.force ? " !important" : "";
    rendition.themes.register(name, {
      body: { background: `${t.bg}${imp}`, color: `${t.ink}${imp}` },
      "p, div, span, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, em, strong, i, b": t.force
        ? { color: "inherit !important", "background-color": "transparent !important" }
        : {},
      a: { color: `${t.link}${imp}` },
    });
  }
}

const FONT_SIZES = [70, 80, 90, 100, 110, 120, 135, 150, 170, 200];
const FACES = {
  book: "",
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

function fontSize() {
  const n = Number(pref("fontSize", "100"));
  return FONT_SIZES.includes(n) ? n : 100;
}

function applyPageStyle(rendition) {
  rendition.themes.select(effectiveTheme());
  rendition.themes.fontSize(`${fontSize()}%`);
  rendition.themes.font(FACES[pref("fontFace", "book")] ?? "");
}

// --------------------------------------------------- highlights and notes

const HIGHLIGHT = {
  yellow: "#f5d33c",
  green: "#6fcf6f",
  blue: "#6aa9f5",
  pink: "#f28ab2",
};

function highlightStyle(color) {
  return { fill: HIGHLIGHT[color] || HIGHLIGHT.yellow, "fill-opacity": "0.35", "mix-blend-mode": "normal" };
}

/// Everything about the open book's annotations, set up by openEpub.
const notes = {
  rendition: null,
  book: null,
  list: [],
  selection: null, // { cfi, text, contents } while text is selected
  editing: null, // the annotation in the note sheet, or a pending new one
};

function drawHighlight(a) {
  const r = notes.rendition;
  if (!r) return;
  r.annotations.remove(a.cfi, "highlight");
  r.annotations.highlight(a.cfi, { id: a.id }, () => openNoteSheet(a), "ficshelf-hl", highlightStyle(a.color));
}

function clearSelection() {
  try {
    notes.selection?.contents?.window?.getSelection()?.removeAllRanges();
  } catch {
    /* the page may already have moved on */
  }
  notes.selection = null;
  $("#select-bar").hidden = true;
}

async function addHighlight(color, withNote) {
  const sel = notes.selection;
  if (!sel || !notes.book) return;
  clearSelection();
  let a;
  try {
    a = await call("add_annotation", {
      bookId: notes.book.id,
      cfi: sel.cfi,
      excerpt: sel.text,
      note: null,
      color,
    });
  } catch {
    return;
  }
  notes.list.push(a);
  drawHighlight(a);
  if (withNote) openNoteSheet(a);
}

document.querySelectorAll("#select-bar .swatch").forEach((b) =>
  b.addEventListener("click", () => addHighlight(b.dataset.color, false)),
);
$("#select-note").addEventListener("click", () => addHighlight("yellow", true));
$("#select-cancel").addEventListener("click", clearSelection);

function openNoteSheet(a) {
  notes.editing = { ...a };
  const ex = $("#note-excerpt");
  ex.textContent = a.excerpt;
  ex.style.setProperty("--c", HIGHLIGHT[a.color] || HIGHLIGHT.yellow);
  $("#note-text").value = a.note || "";
  document.querySelectorAll("#note-colors .swatch").forEach((b) =>
    b.classList.toggle("active", b.dataset.color === a.color),
  );
  $("#note-sheet").showModal();
}

document.querySelectorAll("#note-colors .swatch").forEach((b) =>
  b.addEventListener("click", () => {
    if (!notes.editing) return;
    notes.editing.color = b.dataset.color;
    $("#note-excerpt").style.setProperty("--c", HIGHLIGHT[b.dataset.color]);
    document.querySelectorAll("#note-colors .swatch").forEach((x) => x.classList.toggle("active", x === b));
  }),
);

$("#note-cancel").addEventListener("click", () => $("#note-sheet").close());

$("#note-save").addEventListener("click", async () => {
  const e = notes.editing;
  if (!e) return;
  let updated;
  try {
    updated = await call("update_annotation", { id: e.id, note: $("#note-text").value, color: e.color });
  } catch {
    return;
  }
  notes.list = notes.list.map((a) => (a.id === updated.id ? updated : a));
  drawHighlight(updated);
  $("#note-sheet").close();
});

$("#note-delete").addEventListener("click", async () => {
  const e = notes.editing;
  if (!e) return;
  try {
    await call("delete_annotation", { id: e.id });
  } catch {
    return;
  }
  notes.list = notes.list.filter((a) => a.id !== e.id);
  notes.rendition?.annotations.remove(e.cfi, "highlight");
  $("#note-sheet").close();
});

$("#reader-notes").addEventListener("click", () => {
  const list = $("#notes-list");
  list.textContent = "";
  $("#notes-empty").hidden = notes.list.length > 0;
  for (const a of notes.list) {
    const li = document.createElement("li");
    li.style.setProperty("--c", HIGHLIGHT[a.color] || HIGHLIGHT.yellow);
    const ex = document.createElement("div");
    ex.className = "ex";
    ex.textContent = a.excerpt.length > 220 ? `${a.excerpt.slice(0, 220)}…` : a.excerpt;
    li.appendChild(ex);
    if (a.note) {
      const nt = document.createElement("div");
      nt.className = "nt";
      nt.textContent = a.note;
      li.appendChild(nt);
    }
    li.addEventListener("click", () => {
      $("#notes-sheet").close();
      notes.rendition?.display(a.cfi);
    });
    list.appendChild(li);
  }
  $("#notes-sheet").showModal();
});
$("#notes-done").addEventListener("click", () => $("#notes-sheet").close());

// The Aa sheet.
function syncFontSheet() {
  $("#font-size-label").textContent = `${fontSize()}%`;
  const face = pref("fontFace", "book");
  document.querySelectorAll("#font-face button").forEach((b) =>
    b.classList.toggle("active", b.dataset.face === face),
  );
}

function stepFont(dir) {
  const i = FONT_SIZES.indexOf(fontSize());
  const next = FONT_SIZES[Math.min(Math.max(i + dir, 0), FONT_SIZES.length - 1)];
  setPref("fontSize", String(next));
  syncFontSheet();
  readerRestyle?.();
}

$("#reader-aa").addEventListener("click", () => {
  syncFontSheet();
  $("#font-sheet").showModal();
});
$("#font-smaller").addEventListener("click", () => stepFont(-1));
$("#font-larger").addEventListener("click", () => stepFont(1));
document.querySelectorAll("#font-face button").forEach((b) =>
  b.addEventListener("click", () => {
    setPref("fontFace", b.dataset.face);
    syncFontSheet();
    readerRestyle?.();
  }),
);
$("#font-done").addEventListener("click", () => $("#font-sheet").close());

// A tap on the dimmed area around any sheet closes it.
document.querySelectorAll("dialog.sheet").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  }),
);

/// The reading area's size in whole CSS pixels.
function areaSize(el) {
  const r = el.getBoundingClientRect();
  return { width: Math.floor(r.width), height: Math.floor(r.height) };
}

async function openEpub(book) {
  const area = $("#epub-area");
  area.hidden = false;

  // Let the reader view finish laying out before measuring it. Measured too
  // early, the area reports a fraction of its real size and epub.js draws
  // the book small in the top-left corner.
  await nextFrame();
  await nextFrame();
  const { width, height } = areaSize(area);

  const epub = ePub(convertFileSrc(book.path), { openAs: "epub" });
  const rendition = epub.renderTo(area, {
    width,
    height,
    flow: "paginated",
    // Two pages side by side only when there is room for them, such as the
    // Fold's inner screen in landscape; one page on a phone.
    spread: width >= 800 ? "auto" : "none",
    minSpreadWidth: 800,
  });

  // Covers and other full-page images: fit the page, keep their shape, and
  // centre them, rather than appearing at whatever size they were drawn.
  rendition.themes.default({
    "img, svg, image": {
      "max-width": "100% !important",
      "max-height": "96vh !important",
      "object-fit": "contain",
    },
    "body > div:only-child > img, body > img:only-child": {
      display: "block",
      margin: "0 auto !important",
    },
  });

  registerPageThemes(rendition);
  applyPageStyle(rendition);
  readerRestyle = () => applyPageStyle(rendition);
  $("#view-reader").classList.add("kind-epub");

  // Hiding the toolbar, folding or unfolding, and rotating all change the
  // reading area's size; keep the book matched to it.
  let resizeTimer = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const size = areaSize(area);
      if (size.width > 0 && size.height > 0) rendition.resize(size.width, size.height);
    }, 150);
  });
  observer.observe(area);

  await rendition.display(book.position || undefined);

  // The book lives in an iframe, so its touches arrive through epub.js
  // rather than the page. screenX is used because the iframe's own
  // coordinates span every page of the chapter, not just the visible one.
  const turner = touchTurner((t) => t.screenX / window.screen.width);
  rendition.on("touchstart", (e) => turner.start(e));
  rendition.on("touchend", (e) => {
    // Lifting a finger after selecting text must not also turn the page.
    const sel = e.view?.getSelection?.();
    if (sel && !sel.isCollapsed) return;
    turner.end(e);
  });

  // Highlights and notes.
  notes.rendition = rendition;
  notes.book = book;
  notes.list = [];
  try {
    notes.list = await invoke("list_annotations", { bookId: book.id });
  } catch {
    /* a book with no readable notes still reads */
  }
  for (const a of notes.list) drawHighlight(a);

  rendition.on("selected", (cfi, contents) => {
    let text = "";
    try {
      text = contents.window.getSelection().toString();
    } catch {
      /* fall through to the empty check */
    }
    if (!text.trim()) return;
    notes.selection = { cfi, text, contents };
    $("#select-bar").hidden = false;
  });

  rendition.on("relocated", (location) => {
    clearSelection();
    saveWhere(book, location.start.cfi);
    const pct = epub.locations?.percentageFromCfi?.(location.start.cfi);
    $("#reader-progress").textContent =
      typeof pct === "number" && !Number.isNaN(pct) ? `${Math.round(pct * 100)}%` : "";
  });

  state.reader = {
    book,
    kind: "epub",
    next: () => rendition.next(),
    prev: () => rendition.prev(),
    // The ResizeObserver above already follows every size change.
    resize: () => {},
    cleanup: () => {
      observer.disconnect();
      clearTimeout(resizeTimer);
      readerRestyle = null;
      clearSelection();
      notes.rendition = null;
      notes.book = null;
      notes.list = [];
      $("#view-reader").classList.remove("kind-epub");
      rendition.destroy();
      epub.destroy();
    },
  };

  // Locations make the percentage readout meaningful but cost a pass over the
  // whole book, so they are generated in the background and never awaited.
  epub.ready
    .then(() => epub.locations.generate(1600))
    .catch(() => {});
}

async function openPdf(book) {
  const canvas = $("#pdf-canvas");
  canvas.hidden = false;
  const ctx = canvas.getContext("2d");

  const doc = await pdfjs.getDocument(convertFileSrc(book.path)).promise;
  let page = Math.min(Math.max(parseInt(book.position || "1", 10) || 1, 1), doc.numPages);

  const render = async () => {
    const p = await doc.getPage(page);
    // Fit the width of the stage, within reason, and respect high-DPI screens.
    const stageWidth = Math.max($("#reader-stage").clientWidth - 28, 320);
    const base = p.getViewport({ scale: 1 });
    const scale = Math.min(stageWidth / base.width, 3);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = p.getViewport({ scale: scale * dpr });

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width / dpr}px`;

    await p.render({ canvasContext: ctx, viewport }).promise;
    $("#reader-progress").textContent = `${page} / ${doc.numPages}`;
    saveWhere(book, page);

    // A PDF has no cover of its own, so the first page becomes one.
    if (page === 1 && !book.has_cover) {
      try {
        const thumb = document.createElement("canvas");
        const tv = p.getViewport({ scale: 400 / base.width });
        thumb.width = tv.width;
        thumb.height = tv.height;
        await p.render({ canvasContext: thumb.getContext("2d"), viewport: tv }).promise;
        await invoke("set_cover_from_data_url", {
          id: book.id,
          dataUrl: thumb.toDataURL("image/jpeg", 0.75),
        });
        book.has_cover = true;
      } catch {
        /* a missing cover is cosmetic */
      }
    }
  };

  await render();

  state.reader = {
    book,
    kind: "pdf",
    next: () => {
      if (page < doc.numPages) {
        page += 1;
        render();
      }
    },
    prev: () => {
      if (page > 1) {
        page -= 1;
        render();
      }
    },
    resize: () => render(),
    cleanup: () => doc.destroy(),
  };
}

async function openCbz(book, pages) {
  if (!pages.length) throw new Error("no images in this archive");
  const img = $("#cbz-image");
  img.hidden = false;

  let index = Math.min(Math.max(parseInt(book.position || "0", 10) || 0, 0), pages.length - 1);

  const render = async () => {
    img.src = await invoke("cbz_page", { id: book.id, name: pages[index] });
    $("#reader-progress").textContent = `${index + 1} / ${pages.length}`;
    saveWhere(book, index);
  };

  await render();

  state.reader = {
    book,
    kind: "cbz",
    next: () => {
      if (index < pages.length - 1) {
        index += 1;
        render();
      }
    },
    prev: () => {
      if (index > 0) {
        index -= 1;
        render();
      }
    },
    cleanup: () => {
      img.src = "";
    },
  };
}

// ------------------------------------------------------------ AO3 search

const AO3_WORK_RE = /archiveofourown\.org\/works\/(\d+)|^\s*(\d{3,})\s*$/i;

$("#btn-ao3-search").addEventListener("click", runSearch);
$("#ao3-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});

async function runSearch() {
  const query = $("#ao3-query").value.trim();
  if (!query) return;

  const direct = query.match(AO3_WORK_RE);
  $("#ao3-status").textContent = "Asking AO3…";
  $("#ao3-results").textContent = "";

  try {
    if (direct) {
      const id = Number(direct[1] || direct[2]);
      const book = await call("ao3_save_work", { workId: id });
      $("#ao3-status").textContent = `Saved “${book.title}”.`;
      await refreshLibrary();
      return;
    }
    const hits = await call("ao3_search", { query, page: 1 });
    renderHits(hits);
    $("#ao3-status").textContent = hits.length
      ? `${hits.length} works.`
      : "Nothing found. AO3's own search page may word it differently.";
  } catch {
    $("#ao3-status").textContent = "";
  }
}

function renderHits(hits) {
  const box = $("#ao3-results");
  box.textContent = "";

  for (const hit of hits) {
    const el = document.createElement("article");
    el.className = "hit";

    const h = document.createElement("h3");
    h.textContent = hit.title;
    el.appendChild(h);

    const by = document.createElement("div");
    by.className = "by";
    by.textContent =
      (hit.authors.length ? hit.authors.join(", ") : "Anonymous") +
      (hit.fandoms.length ? ` — ${hit.fandoms.join(", ")}` : "");
    el.appendChild(by);

    if (hit.summary) {
      const s = document.createElement("p");
      s.className = "sum";
      s.textContent = hit.summary;
      el.appendChild(s);
    }

    const stats = document.createElement("div");
    stats.className = "stats";
    const chapters =
      hit.chapters_posted == null
        ? ""
        : `${hit.chapters_posted}/${hit.chapters_total ?? "?"} chapters`;
    for (const bit of [
      chapters,
      hit.words ? `${hit.words.toLocaleString()} words` : "",
      hit.complete ? "complete" : "in progress",
      hit.updated || "",
    ]) {
      if (!bit) continue;
      const span = document.createElement("span");
      span.textContent = bit;
      stats.appendChild(span);
    }
    el.appendChild(stats);

    if (hit.tags.length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const t of hit.tags) {
        const s = document.createElement("span");
        s.className = "tag";
        s.textContent = t;
        tags.appendChild(s);
      }
      el.appendChild(tags);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    const save = document.createElement("button");
    save.className = "primary";
    save.textContent = "Save to library";
    save.addEventListener("click", async () => {
      save.disabled = true;
      save.textContent = "Downloading…";
      try {
        const book = await call("ao3_save_work", { workId: hit.work_id });
        save.textContent = "Saved";
        toast(`Saved “${book.title}”.`);
        await refreshLibrary();
      } catch {
        save.disabled = false;
        save.textContent = "Save to library";
      }
    });
    actions.appendChild(save);
    el.appendChild(actions);

    box.appendChild(el);
  }
}

$("#btn-save-search").addEventListener("click", async () => {
  const query = $("#ao3-query").value.trim();
  if (!query) return;
  // No prompt() on Android; the query itself is a fine name there.
  const name = IS_ANDROID ? query : prompt("Name this search:", query);
  if (!name) return;
  await call("add_search", { name, query });
  await refreshSavedSearches();
  toast("Search saved.");
});

async function refreshSavedSearches() {
  const list = $("#saved-list");
  list.textContent = "";
  const searches = await call("list_searches");
  for (const s of searches) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = s.name;
    a.title = s.query;
    a.addEventListener("click", async () => {
      $("#ao3-query").value = s.query;
      await call("touch_search", { id: s.id });
      runSearch();
    });
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Delete this saved search";
    del.addEventListener("click", async () => {
      await call("delete_search", { id: s.id });
      refreshSavedSearches();
    });
    li.append(a, del);
    list.appendChild(li);
  }
}

// -------------------------------------------------------------- updates

$("#btn-check-updates").addEventListener("click", async () => {
  const btn = $("#btn-check-updates");
  btn.disabled = true;
  $("#updates-status").textContent = "Checking, slowly and politely…";
  try {
    const report = await call("ao3_check_updates", { limit: 40 });
    $("#updates-status").textContent =
      `Checked ${report.checked}. ${report.with_updates.length} with new chapters.` +
      (report.errors.length ? ` ${report.errors.length} could not be checked.` : "");
    if (report.errors.length) console.warn("Update errors:", report.errors);
    renderUpdates(report.with_updates);
    await refreshLibrary();
  } finally {
    btn.disabled = false;
  }
});

function renderUpdates(books) {
  const box = $("#updates-list");
  box.textContent = "";
  for (const book of books) {
    const el = document.createElement("article");
    el.className = "hit";

    const h = document.createElement("h3");
    h.textContent = book.title;
    el.appendChild(h);

    const by = document.createElement("div");
    by.className = "by";
    by.textContent = book.author || "";
    el.appendChild(by);

    const stats = document.createElement("div");
    stats.className = "stats";
    const seen = document.createElement("span");
    seen.textContent = `had ${book.chapters_seen ?? "?"} chapters`;
    const now = document.createElement("span");
    now.textContent = `now ${book.chapters_total ?? "more"}`;
    stats.append(seen, now);
    el.appendChild(stats);

    const actions = document.createElement("div");
    actions.className = "actions";
    const get = document.createElement("button");
    get.className = "primary";
    get.textContent = "Download the new version";
    get.addEventListener("click", async () => {
      get.disabled = true;
      get.textContent = "Downloading…";
      try {
        await call("ao3_save_work", { workId: book.ao3_work_id });
        toast(`Updated “${book.title}”.`);
        await refreshLibrary();
        const fresh = await call("list_updates");
        renderUpdates(fresh);
      } catch {
        get.disabled = false;
        get.textContent = "Download the new version";
      }
    });
    const read = document.createElement("button");
    read.textContent = "Read the old copy";
    read.addEventListener("click", () => openBook(book.id));
    actions.append(get, read);
    el.appendChild(actions);

    box.appendChild(el);
  }
}

async function refreshUpdateBadge() {
  try {
    const updates = await invoke("list_updates");
    const badge = $("#update-badge");
    badge.textContent = String(updates.length);
    badge.hidden = updates.length === 0;
  } catch {
    /* the badge is decoration; never let it break startup */
  }
}

// ------------------------------------------------------------ bookmarks
//
// The user's own AO3 Bookmarks and Marked for Later, listed a page at a time.
// Nothing here downloads on its own: Save puts a work in the queue, and the
// queue only runs when the user presses Start, saving at most `cap` works per
// run, one after another. The backend paces every request regardless.
//
// There is no "save all" on purpose. Hundreds of back-to-back downloads from a
// signed-in account is the pattern AO3 blocks, and it can cost the account.

const QUEUE_MAX = 100;
const COOLDOWN_MS = 60_000; // after a run that used its whole allowance

const shelfState = {
  shelf: "bookmarks",
  page: 0,
  entries: [],
  skipped: 0,
  hasMore: false,
  loading: false,
  loadedOnce: false,
};

const queue = {
  items: [], // { workId, title, status: "waiting" | "busy" | "failed", error }
  running: false,
  stopAsked: false,
  coolUntil: 0,
};

$$(".tabs button[data-shelf]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.shelf === shelfState.shelf) return;
    shelfState.shelf = b.dataset.shelf;
    $$(".tabs button[data-shelf]").forEach((x) => x.classList.toggle("active", x === b));
    loadShelf(true);
  }),
);
$("#btn-shelf-refresh").addEventListener("click", () => loadShelf(true));
$("#btn-shelf-more").addEventListener("click", () => loadShelf(false));
$("#shelf-hide-saved").addEventListener("change", renderShelfList);

async function loadShelf(reset) {
  if (shelfState.loading) return;
  if (reset) {
    shelfState.page = 0;
    shelfState.entries = [];
    shelfState.skipped = 0;
    shelfState.hasMore = false;
    renderShelfList();
  }
  shelfState.loading = true;
  shelfState.loadedOnce = true;
  const wanted = shelfState.shelf;
  $("#btn-shelf-more").hidden = true;
  $("#shelf-status").textContent = "Asking AO3…";

  try {
    const out = await invoke("ao3_shelf", { shelf: wanted, page: shelfState.page + 1 });
    if (wanted !== shelfState.shelf) return; // the user switched tabs meanwhile
    shelfState.page = out.page;
    shelfState.entries.push(...out.entries);
    shelfState.skipped += out.skipped;
    shelfState.hasMore = out.has_more;
    renderShelfList();
  } catch (e) {
    $("#shelf-status").textContent = typeof e === "string" ? e : String(e);
    $("#btn-shelf-more").hidden = !shelfState.hasMore;
  } finally {
    shelfState.loading = false;
  }
}

function shelfStatusText() {
  const n = shelfState.entries.length;
  const saved = shelfState.entries.filter((e) => e.book_id != null).length;
  if (!n && !shelfState.hasMore) {
    return shelfState.shelf === "later"
      ? "Nothing marked for later. (This list needs reading history turned on in your AO3 preferences.)"
      : "No bookmarks.";
  }
  let t = `${n} works listed, ${saved} already in your library.`;
  if (shelfState.skipped) t += ` ${shelfState.skipped} series, external or deleted works not shown.`;
  if (shelfState.hasMore) t += " More on AO3.";
  return t;
}

function isQueued(workId) {
  return queue.items.some((q) => q.workId === workId);
}

function renderShelfList() {
  const box = $("#shelf-list");
  box.textContent = "";
  const hideSaved = $("#shelf-hide-saved").checked;

  for (const entry of shelfState.entries) {
    const inLibrary = entry.book_id != null;
    if (hideSaved && inLibrary && !entry.has_update) continue;

    const el = document.createElement("article");
    el.className = "hit" + (inLibrary && !entry.has_update ? " saved" : "");

    const h = document.createElement("h3");
    h.textContent = entry.title;
    el.appendChild(h);

    const by = document.createElement("div");
    by.className = "by";
    by.textContent =
      (entry.authors.length ? entry.authors.join(", ") : "Anonymous") +
      (entry.fandoms.length ? ` — ${entry.fandoms.join(", ")}` : "");
    el.appendChild(by);

    const stats = document.createElement("div");
    stats.className = "stats";
    for (const bit of [
      entry.chapters_posted == null
        ? ""
        : `${entry.chapters_posted}/${entry.chapters_total ?? "?"} chapters`,
      entry.words ? `${entry.words.toLocaleString()} words` : "",
      entry.complete ? "complete" : "in progress",
      entry.updated || "",
    ]) {
      if (!bit) continue;
      const span = document.createElement("span");
      span.textContent = bit;
      stats.appendChild(span);
    }
    el.appendChild(stats);

    const actions = document.createElement("div");
    actions.className = "actions";

    if (inLibrary) {
      const st = document.createElement("span");
      st.className = "state";
      st.textContent = entry.has_update ? "In your library — newer chapters on AO3" : "In your library";
      const read = document.createElement("button");
      read.textContent = "Read";
      read.addEventListener("click", () => openBook(entry.book_id));
      actions.append(st, read);
    }

    if (!inLibrary || entry.has_update) {
      const save = document.createElement("button");
      save.className = "primary";
      const label = inLibrary ? "Save the new version" : "Save";
      const sync = () => {
        const q = isQueued(entry.work_id);
        save.textContent = q ? "Queued — remove" : label;
        save.classList.toggle("primary", !q);
      };
      sync();
      save.addEventListener("click", () => {
        if (isQueued(entry.work_id)) unqueue(entry.work_id);
        else enqueue(entry);
        sync();
      });
      actions.appendChild(save);
    }

    el.appendChild(actions);
    box.appendChild(el);
  }

  $("#shelf-status").textContent = shelfStatusText();
  $("#btn-shelf-more").hidden = !shelfState.hasMore || shelfState.loading;
}

function enqueue(entry) {
  if (queue.items.length >= QUEUE_MAX) {
    toast(`The queue holds at most ${QUEUE_MAX}. Let some finish first.`, true);
    return;
  }
  queue.items.push({ workId: entry.work_id, title: entry.title, status: "waiting", error: "" });
  renderQueue();
}

function unqueue(workId) {
  const i = queue.items.findIndex((q) => q.workId === workId && q.status !== "busy");
  if (i >= 0) queue.items.splice(i, 1);
  renderQueue();
}

function renderQueue() {
  const list = $("#queue-list");
  list.textContent = "";
  for (const item of queue.items) {
    const li = document.createElement("li");
    li.className = item.status;
    const name = document.createElement("span");
    name.textContent = item.title;
    name.title = item.status === "failed" ? item.error : item.title;
    li.appendChild(name);

    if (item.status === "busy") {
      const s = document.createElement("em");
      s.className = "muted small";
      s.textContent = "saving…";
      li.appendChild(s);
    } else {
      if (item.status === "failed") {
        const retry = document.createElement("button");
        retry.textContent = "↻";
        retry.title = `Failed: ${item.error}\nClick to try again on the next run.`;
        retry.addEventListener("click", () => {
          item.status = "waiting";
          item.error = "";
          renderQueue();
        });
        li.appendChild(retry);
      }
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Take this out of the queue";
      del.addEventListener("click", () => {
        unqueue(item.workId);
        renderShelfList();
      });
      li.appendChild(del);
    }
    list.appendChild(li);
  }

  const waiting = queue.items.filter((q) => q.status === "waiting").length;
  const cooling = Date.now() < queue.coolUntil;
  $("#queue-empty").hidden = queue.items.length > 0;
  $("#btn-queue-start").disabled = queue.running || waiting === 0 || cooling;
  $("#btn-queue-start").textContent = waiting
    ? `Start (${Math.min(waiting, Number($("#queue-cap").value))})`
    : "Start";
  $("#btn-queue-stop").hidden = !queue.running;
  $("#btn-queue-clear").disabled = queue.running || queue.items.length === 0;
}

$("#queue-cap").addEventListener("change", renderQueue);

$("#btn-queue-clear").addEventListener("click", () => {
  if (queue.running) return;
  queue.items = [];
  renderQueue();
  renderShelfList();
});

$("#btn-queue-stop").addEventListener("click", () => {
  queue.stopAsked = true;
  $("#btn-queue-stop").disabled = true;
  $("#queue-status").textContent = "Stopping after the current work…";
});

$("#btn-queue-start").addEventListener("click", runQueue);

async function runQueue() {
  if (queue.running) return;
  const cap = Number($("#queue-cap").value) || 10;
  queue.running = true;
  queue.stopAsked = false;
  $("#btn-queue-stop").disabled = false;

  let saved = 0;
  let failed = 0;
  let halted = "";

  try {
    while (saved + failed < cap && !queue.stopAsked) {
      const item = queue.items.find((q) => q.status === "waiting");
      if (!item) break;

      item.status = "busy";
      renderQueue();
      $("#queue-status").textContent = `Saving ${saved + failed + 1} of up to ${cap}…`;

      try {
        // Not `call`: a failure is shown in the queue rather than as a toast
        // per work.
        const book = await invoke("ao3_save_work", { workId: item.workId });
        saved += 1;
        queue.items.splice(queue.items.indexOf(item), 1);
        for (const e of shelfState.entries) {
          if (e.work_id === item.workId) {
            e.book_id = book.id;
            e.has_update = false;
          }
        }
      } catch (e) {
        failed += 1;
        item.status = "failed";
        item.error = typeof e === "string" ? e : String(e);
        // AO3 telling us to slow down, or the session going away, ends the
        // run outright. Carrying on would be exactly the wrong response.
        if (/slow down|429|signed us out|sign in/i.test(item.error)) {
          halted = item.error;
          break;
        }
      }
      renderQueue();
      renderShelfList();
    }
  } finally {
    queue.running = false;
    const usedAll = saved + failed >= cap;
    if (usedAll) {
      queue.coolUntil = Date.now() + COOLDOWN_MS;
      setTimeout(renderQueue, COOLDOWN_MS + 50);
    }
    const left = queue.items.filter((q) => q.status === "waiting").length;
    let msg = `Saved ${saved}.`;
    if (failed) msg += ` ${failed} failed (hover for why).`;
    if (halted) msg += ` Stopped: ${halted}`;
    else if (left && usedAll) msg += ` ${left} still queued; Start is available again in a minute.`;
    else if (left) msg += ` ${left} still queued.`;
    $("#queue-status").textContent = msg;
    renderQueue();
    renderShelfList();
    if (saved) await refreshLibrary();
  }
}

renderQueue();

// ------------------------------------------------------------- settings

$("#btn-change-dir").addEventListener("click", async () => {
  const dir = await openDialog({ directory: true });
  if (!dir) return;
  await call("set_library_dir", { path: dir });
  await refreshSettings();
  toast("Downloads folder changed.");
});

document.querySelectorAll("[data-theme-choice]").forEach((b) =>
  b.addEventListener("click", () => {
    setPref("theme", b.dataset.themeChoice);
    applyTheme();
  }),
);

$("#volume-paging").checked = volumePagingWanted();
$("#volume-paging").addEventListener("change", (e) => {
  try {
    localStorage.setItem(VOLUME_PAGING_KEY, e.target.checked ? "on" : "off");
  } catch {
    /* storage unavailable; the choice lasts until the app closes */
  }
});

async function refreshSettings() {
  const s = await call("get_settings");
  $("#library-dir").textContent = s.library_dir;
  await refreshAo3Status();
}

async function refreshAo3Status() {
  let status;
  try {
    status = await invoke("ao3_status");
  } catch {
    return; // a keyring that will not answer must not break Settings
  }
  const signedIn = Boolean(
    status.logged_in || (status.username && status.has_saved_password),
  );
  $("#ao3-signed-in").hidden = !signedIn;
  $("#ao3-signed-out").hidden = signedIn;
  $("#ao3-who").textContent = status.username || "";
  if (!signedIn && status.username && !$("#ao3-user").value) {
    $("#ao3-user").value = status.username;
  }
  $("#ao3-store-desktop").hidden = !status.can_save_password;
  $("#ao3-store-phone").hidden = status.can_save_password;
  $("#btn-ao3-signout").textContent = status.can_save_password
    ? "Sign out and forget"
    : "Sign out";
}

$("#btn-ao3-signin").addEventListener("click", async () => {
  const btn = $("#btn-ao3-signin");
  const username = $("#ao3-user").value.trim();
  const password = $("#ao3-pass").value;
  if (!username || !password) {
    toast("Both the username and the password are needed.", true);
    return;
  }
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    await call("ao3_sign_in", { username, password });
    toast(`Signed in to AO3 as ${username}.`);
  } finally {
    // Clear the password from the page whether it worked or not, so it is not
    // sitting in the DOM afterwards.
    $("#ao3-pass").value = "";
    btn.disabled = false;
    btn.textContent = "Sign in";
    await refreshAo3Status();
  }
});

$("#btn-ao3-signout").addEventListener("click", async () => {
  const question = IS_ANDROID
    ? "Sign out of AO3?"
    : "Sign out and delete the saved password from this computer?";
  if (!(await confirmAsk(question))) return;
  await call("ao3_sign_out");
  await refreshAo3Status();
  toast(IS_ANDROID ? "Signed out." : "Signed out. The password has been removed.");
});

// ----------------------------------------------------------------- boot

(async function boot() {
  await refreshLibrary();
  await refreshSavedSearches();
  await refreshSettings();
  renderUpdates(await call("list_updates"));
})().catch((e) => toast(`Could not start: ${e}`, true));
