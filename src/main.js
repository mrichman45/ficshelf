import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen as onEvent } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
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

// ----------------------------------------------------------------- motion

function applyMotion() {
  const choice = pref("motion", "system");
  if (choice === "system") document.documentElement.removeAttribute("data-motion");
  else document.documentElement.setAttribute("data-motion", choice);
  document.querySelectorAll("[data-motion-choice]").forEach((b) => {
    b.classList.toggle("active", b.dataset.motionChoice === choice);
    b.setAttribute("aria-checked", String(b.dataset.motionChoice === choice));
  });
}
applyMotion();

// ------------------------------------------------------------ brightness
//
// Swipe up or down along the left edge to dim or brighten the page, as in
// FBReader. It dims with an overlay rather than the phone's own brightness.

function applyDim() {
  const d = Math.min(0.85, Math.max(0, Number(pref("dim", "0")) || 0));
  $("#view-reader").style.setProperty("--dim", String(d));
  $("#view-reader").classList.toggle("no-edge-dim", pref("edgeDim", "on") !== "on");
  return d;
}
applyDim();
{
  const edge = $("#dim-edge");
  let start = null;
  let hideLabel = null;
  edge.addEventListener("touchstart", (e) => {
    start = { y: e.touches[0].clientY, dim: applyDim() };
  }, { passive: true });
  edge.addEventListener("touchmove", (e) => {
    if (!start) return;
    e.preventDefault();
    const h = edge.getBoundingClientRect().height || 1;
    // Up brightens, down dims.
    const dim = Math.min(0.85, Math.max(0, start.dim + ((e.touches[0].clientY - start.y) / h) * 0.9));
    setPref("dim", dim.toFixed(3));
    applyDim();
    const label = $("#dim-label");
    label.textContent = `Brightness ${Math.round((1 - dim / 0.85) * 100)}%`;
    label.hidden = false;
    clearTimeout(hideLabel);
    hideLabel = setTimeout(() => (label.hidden = true), 900);
  }, { passive: false });
  edge.addEventListener("touchend", () => (start = null));
}
$("#edge-dim").checked = pref("edgeDim", "on") === "on";
$("#edge-dim").addEventListener("change", (e) => {
  setPref("edgeDim", e.target.checked ? "on" : "off");
  if (!e.target.checked) setPref("dim", "0");
  applyDim();
});

// How pages turn: slide (default), shift, fade or none.
function applyTurn() {
  const choice = pref("turn", "slide");
  document.documentElement.setAttribute("data-turn", choice);
  document.querySelectorAll("[data-turn-choice]").forEach((b) => {
    b.classList.toggle("active", b.dataset.turnChoice === choice);
    b.setAttribute("aria-checked", String(b.dataset.turnChoice === choice));
  });
}
applyTurn();

// Tap zones.
function syncTapZones() {
  const v = pref("tapZones", "sides");
  document.querySelectorAll("#tapzone-picker button").forEach((b) => b.classList.toggle("active", b.dataset.zones === v));
}
syncTapZones();
document.querySelectorAll("#tapzone-picker button").forEach((b) =>
  b.addEventListener("click", () => {
    setPref("tapZones", b.dataset.zones);
    syncTapZones();
  }),
);

document.querySelectorAll("[data-turn-choice]").forEach((b) =>
  b.addEventListener("click", () => {
    setPref("turn", b.dataset.turnChoice);
    applyTurn();
  }),
);

document.querySelectorAll("[data-motion-choice]").forEach((b) =>
  b.addEventListener("click", () => {
    setPref("motion", b.dataset.motionChoice);
    applyMotion();
  }),
);

/// Slide `el` in from one side: +1 means the new page comes from the
/// right (turning forward in a left-to-right book), -1 from the left.
function playTurn(el, from) {
  if (!el || !from) return;
  el.classList.remove("turn-from-right", "turn-from-left");
  void el.offsetWidth; // restart the animation even on a quick double turn
  el.classList.add(from > 0 ? "turn-from-right" : "turn-from-left");
}

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

// ------------------------------------------------------------ error log
//
// Every error FicShelf shows is kept (on this device only) so that when
// something goes wrong there is a record of what and when: Settings → Error
// log, with a button to copy it.

const LOG_KEY = "ficshelf.errorlog";
const LOG_MAX = 200;
let appVersion = "";
getVersion()
  .then((v) => (appVersion = v))
  .catch(() => {});

function readLog() {
  try {
    const list = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/// Record an error: `what` is what FicShelf was doing (a command or a
/// short description), `message` what went wrong.
function logError(what, message) {
  const text = typeof message === "string" ? message : message?.message || String(message);
  const list = readLog();
  const last = list[0];
  // The same error twice in a row within a few seconds is one event.
  if (last && last.msg === text && last.what === what && Date.now() - last.t < 5000) {
    last.n = (last.n || 1) + 1;
  } else {
    list.unshift({
      t: Date.now(),
      what: what || "",
      msg: text,
      v: appVersion,
      where: window.__view || "",
    });
  }
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(0, LOG_MAX)));
  } catch {
    /* storage full or unavailable: nothing more to do */
  }
  if (document.getElementById("error-log")?.offsetParent) renderLog();
}

function logLine(e) {
  const when = new Date(e.t).toLocaleString();
  const times = e.n > 1 ? ` (×${e.n})` : "";
  const what = e.what ? `${e.what}: ` : "";
  return `${when}${e.v ? ` · v${e.v}` : ""}${e.where ? ` · ${e.where}` : ""}${times}\n${what}${e.msg}`;
}

function renderLog() {
  const box = document.getElementById("error-log");
  if (!box) return;
  const list = readLog();
  box.textContent = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No errors recorded.";
    box.appendChild(li);
    return;
  }
  for (const e of list) {
    const li = document.createElement("li");
    li.textContent = logLine(e);
    box.appendChild(li);
  }
}

window.addEventListener("error", (e) => logError("app error", e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => logError("app error", e.reason?.message || String(e.reason)));

function toast(message, bad = false, record = bad) {
  if (record) logError("", message);
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
    if (cmd.startsWith("ao3_")) refreshCooldown();
    const msg = typeof e === "string" ? e : String(e);
    logError(describeCall(cmd, args), msg);
    toast(msg, true, false);
    throw e;
  }
}

// ------------------------------------------------------------- cooldown
//
// When AO3 says "slow down" (429) or "overloaded" (503), the Rust side stops
// every AO3 request for a while. The AO3 screens show how long, and their
// buttons wait.

const AO3_VIEWS = ["search", "bookmarks", "updates"];
const cooldown = { until: 0, reason: 0, timer: null };

async function refreshCooldown() {
  let c = null;
  try {
    c = await invoke("ao3_cooldown");
  } catch {
    /* older build: no cooldown */
  }
  cooldown.until = c ? Date.now() + c.seconds * 1000 : 0;
  cooldown.reason = c ? c.reason : 0;
  renderCooldown();
}

function renderCooldown() {
  const left = Math.max(0, Math.ceil((cooldown.until - Date.now()) / 1000));
  const onAo3 = AO3_VIEWS.includes(window.__view);
  const banner = document.getElementById("ao3-cooldown");
  if (!banner) return;
  banner.hidden = !(left > 0 && onAo3);
  const m = Math.floor(left / 60);
  const sec = String(left % 60).padStart(2, "0");
  const limitOnly = cooldown.reason === 1;
  banner.querySelector("strong").textContent = limitOnly ? "Hourly limit reached" : "Giving AO3 a break";
  document.getElementById("ao3-cooldown-text").textContent =
    cooldown.reason === 503
      ? `AO3 is overloaded. Trying again is paused for ${m}:${sec}.`
      : limitOnly
        ? `FicShelf has saved 30 works this hour. Saving resumes in ${m}:${sec}; searching still works.`
        : `AO3 asked FicShelf to slow down. Searching and saving are paused for ${m}:${sec}.`;
  for (const id of ["btn-ao3-search", "btn-search-more"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = left > 0 && !limitOnly;
  }
  clearTimeout(cooldown.timer);
  if (left > 0) cooldown.timer = setTimeout(renderCooldown, 1000);
}

/// A short, readable note of what a command was trying to do, for the log.
function describeCall(cmd, args = {}) {
  const bits = [];
  for (const k of ["workId", "query", "page", "url", "id"]) {
    if (args && args[k] !== undefined && args[k] !== null) bits.push(`${k}=${String(args[k]).slice(0, 120)}`);
  }
  return bits.length ? `${cmd} (${bits.join(", ")})` : cmd;
}

/// Show or hide a progress bar. With a fraction it fills to that point;
/// without one it runs as a moving "working on it" stripe.
function busy(el, on, fraction) {
  if (!el) return;
  el.hidden = !on;
  const fill = el.querySelector(".busy-fill");
  const known = typeof fraction === "number" && Number.isFinite(fraction);
  el.classList.toggle("indeterminate", on && !known);
  if (fill) fill.style.width = known ? `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` : "";
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
  document.body.classList.toggle("reading", view === "reader");
  if (view === "bookmarks" && !shelfState.loadedOnce) loadShelf(true);
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  $$("#nav button[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  const current = document.querySelector(`#nav button[data-view="${view}"]`);
  if (current) $("#nav-current").textContent = current.firstChild?.textContent?.trim() || "";
  setNavMenu(false);
  window.__view = view; // for the error log: which screen she was on
  refreshCooldown();
  if (view === "settings") renderLog();
  window.__podficBar?.(); // the "now playing" bar shows everywhere but the player
}

$$("#nav button[data-view]").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

// On a phone the sections sit behind a ☰ menu rather than a row that has
// to be scrolled sideways.
function setNavMenu(open) {
  const nav = document.getElementById("nav");
  if (!nav) return;
  nav.classList.toggle("open", open);
  $("#nav-menu").setAttribute("aria-expanded", String(open));
  $("#nav-scrim").hidden = !open;
}
$("#nav-menu").addEventListener("click", () => setNavMenu(!$("#nav").classList.contains("open")));
$("#nav-scrim").addEventListener("click", () => setNavMenu(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#nav").classList.contains("open")) setNavMenu(false);
});

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

// Covers load only as their cards come near the screen, a few at a time.
// A big library (hundreds of manga volumes, each cover a multi-megabyte
// page) loaded all at once runs a phone's WebView out of memory, so each
// large cover is also shrunk to a thumbnail the first time it is shown and
// the thumbnail is saved in its place.
const COVER_MAX_W = 360;
const COVER_MAX_H = 540;
const COVER_SMALL = 120_000; // data-URL length under which a cover is left as is
const covers = { active: 0, waiting: [] };
const coverObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            coverObserver.unobserve(e.target);
            covers.waiting.push(e.target);
          }
          pumpCovers();
        },
        { rootMargin: "600px 0px" },
      )
    : null;

function coverInto(holder, bookId) {
  holder.dataset.coverId = bookId;
  if (coverObserver) coverObserver.observe(holder);
  else {
    covers.waiting.push(holder);
    pumpCovers();
  }
}

function pumpCovers() {
  while (covers.active < 3 && covers.waiting.length) {
    const holder = covers.waiting.shift();
    if (!holder.isConnected) continue;
    covers.active++;
    loadCover(holder)
      .catch(() => {})
      .finally(() => {
        covers.active--;
        pumpCovers();
      });
  }
}

async function loadCover(holder) {
  const id = Number(holder.dataset.coverId);
  let url = await invoke("book_cover", { id });
  if (!url || !holder.isConnected) return;
  if (url.length > COVER_SMALL) {
    const small = await shrinkCover(url).catch(() => null);
    url = null; // let the full-size copy go
    if (!small) return;
    url = small;
    invoke("set_cover_from_data_url", { id, dataUrl: small }).catch(() => {});
  }
  if (!holder.isConnected) return;
  const img = document.createElement("img");
  img.className = "cover";
  img.decoding = "async";
  img.alt = "";
  img.src = url;
  holder.replaceWith(img);
}

async function shrinkCover(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(1, COVER_MAX_W / img.naturalWidth, COVER_MAX_H / img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  img.src = "";
  const out = canvas.toDataURL("image/jpeg", 0.82);
  canvas.width = canvas.height = 0;
  return out;
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
  fmt.textContent = book.format === "audio" ? "🎧 podfic" : book.format;
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
    else if (book.format === "audio") openPodfic(book);
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

function syncLibLayout() {
  const list = pref("libLayout", "grid") === "list";
  $("#shelf").classList.toggle("list", list);
  $("#lib-layout").textContent = list ? "▦ Grid" : "☰ List";
}

function renderShelf() {
  const shelf = $("#shelf");
  shelf.textContent = "";
  syncLibLayout();
  $("#library-empty").hidden = state.books.length > 0;
  const visible = state.books.filter(matchesFilter);
  if (state.reversed) visible.reverse();

  const head = $("#series-head");
  head.hidden = !(state.libView === "series" && state.openSeries);

  if (state.libView === "all") {
    for (const book of visible) shelf.appendChild(bookCard(book));
    return;
  }

  // Series are listed A to Z (Z to A when reversed); books inside a series
  // always stay in reading order.
  const all = groups(visible);
  if (state.reversed) {
    all.reverse();
    // "Other books" stays at the end either way.
    const other = all.findIndex(([k]) => k === OTHER);
    if (other >= 0) all.push(...all.splice(other, 1));
  }
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

// Sorting: what to sort by, and which way round. Both are remembered.
// The "natural" direction of each is the one most people want first:
// newest added, most recently read, A to Z.
const SORT_LABELS = {
  added: ["Newest first", "Oldest first"],
  recent: ["Most recent first", "Least recent first"],
  title: ["A → Z", "Z → A"],
  author: ["A → Z", "Z → A"],
};

function syncSortButton() {
  const [natural, reversed] = SORT_LABELS[state.sort] || SORT_LABELS.added;
  $("#sort-dir").textContent = state.reversed ? reversed : natural;
  $("#sort-dir").title = `Showing ${state.reversed ? reversed : natural}. Tap to reverse.`;
}

state.sort = SORT_LABELS[pref("sort", "added")] ? pref("sort", "added") : "added";
state.reversed = pref("sortReversed", "no") === "yes";
$("#sort").value = state.sort;
syncSortButton();

$("#sort").addEventListener("change", async (e) => {
  state.sort = e.target.value;
  setPref("sort", state.sort);
  syncSortButton();
  await refreshLibrary();
});

$("#lib-layout").addEventListener("click", () => {
  setPref("libLayout", pref("libLayout", "grid") === "list" ? "grid" : "list");
  renderShelf();
});

$("#sort-dir").addEventListener("click", () => {
  state.reversed = !state.reversed;
  setPref("sortReversed", state.reversed ? "yes" : "no");
  syncSortButton();
  renderShelf();
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
      : [
          {
            name: "Books, comics and podfics",
            extensions: ["epub", "pdf", "cbz", "zip", ...AUDIO_EXTS],
          },
        ],
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
    toast("No books, comics or podfics in that folder.", true);
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
  // Closing a book is a good moment to share where she stopped.
  if (state.reader) syncSoon();
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
  $("#view-reader").classList.remove("show-chrome", "has-chapters");
  if (!notes.rendition) {
    notes.list = [];
    notes.book = null;
  }
  jumpBack = null;
  $("#panel-back").disabled = true;
  $("#panel-where").textContent = "";
  stopFooterClock();
  $("#epub-area").hidden = true;
  $("#epub-area").textContent = "";
  $("#pdf-canvas").hidden = true;
  $("#cbz-view").hidden = true;
  $("#view-reader").classList.remove("kind-cbz");
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
  // In a right-to-left comic, the left arrow goes forward.
  const rtl = Boolean(state.reader.rtl);
  if (e.key === "PageDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight")) state.reader.next?.();
  if (e.key === "PageUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft")) state.reader.prev?.();
  if (e.key === "Escape") leaveReader();
});

async function openBook(id) {
  const { book, pages, right_to_left: rtlHint } = await call("open_book", { id });
  if (book.missing) {
    toast(`That file is no longer at ${book.path}`, true);
    return;
  }

  closeReader();
  show("reader");
  startFooterClock();
  // On a phone the toolbar shows for a moment so she knows it is there, then
  // slides away; a tap in the middle brings it back. On a computer, with no
  // tap, it stays.
  const viewReader = $("#view-reader");
  viewReader.classList.add("show-chrome");
  clearTimeout(window.__chromeTimer);
  if (IS_ANDROID) {
    window.__chromeTimer = setTimeout(() => viewReader.classList.remove("show-chrome"), 2500);
  }
  setVolumePaging(true);
  if (!history.state?.reader) history.pushState({ reader: true }, "");
  $("#reader-title").textContent = book.title;
  $("#reader-author").textContent = book.author || "";
  syncDayNight();
  $("#reader-progress").textContent = "";

  try {
    if (book.format === "epub") await openEpub(book);
    else if (book.format === "pdf") await openPdf(book);
    else await openCbz(book, pages, rtlHint);
    // Comics and PDFs have bookmarks too (highlights need text).
    if (book.format !== "epub") {
      notes.book = book;
      try {
        notes.list = await invoke("list_annotations", { bookId: book.id });
      } catch {
        notes.list = [];
      }
      syncBookmarkButton();
    }
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

/// What a tap at (fx, fy), as fractions of the page, should do, under the
/// tap-zone scheme chosen in Settings. `rtl` swaps left and right for manga.
function tapAction(fx, fy, rtl = false) {
  const inMiddle = fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7;
  const scheme = pref("tapZones", "sides");
  if (scheme === "halves") {
    if (inMiddle) return "menu";
    return fy < 0.5 ? "prev" : "next";
  }
  const x = rtl ? 1 - fx : fx;
  if (scheme === "forward") {
    if (inMiddle) return "menu";
    return x < 0.15 ? "prev" : "next";
  }
  if (x < 0.3) return "prev";
  if (x > 0.7) return "next";
  return "menu";
}

function touchTurner(pageX, pageY = () => 0.5) {
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
        const act = tapAction(pageX(t), pageY(t));
        if (act === "prev") state.reader.prev?.();
        else if (act === "next") state.reader.next?.();
        else $("#view-reader").classList.toggle("show-chrome");
      }
    },
  };
}

// For the PDF and comic readers, which draw straight into the page.
const stageTouch = touchTurner(
  (t) => t.clientX / window.innerWidth,
  (t) => t.clientY / window.innerHeight,
);
$("#reader-stage").addEventListener("touchstart", (e) => stageTouch.start(e), { passive: true });
$("#reader-stage").addEventListener("touchend", (e) => {
  // EPUBs get touches through epub.js, comics through their own gesture
  // handling; this is for PDFs.
  if (state.reader && state.reader.kind === "pdf") stageTouch.end(e);
});

// A mouse wheel turns pages, as in FBReader on the desktop. One turn per
// flick, however many notches it sends. Ctrl+wheel is left for zooming
// comics, and a scrolling EPUB scrolls.
let wheelAt = 0;
function wheelTurn(e) {
  if (e.ctrlKey || !state.reader) return;
  if (state.reader.kind === "epub" && pref("flow", "pages") === "scroll") return;
  const now = Date.now();
  if (now - wheelAt < 350) return;
  if (Math.abs(e.deltaY) < 4 && Math.abs(e.deltaX) < 4) return;
  wheelAt = now;
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  d > 0 ? state.reader.next?.() : state.reader.prev?.();
}
$("#reader-stage").addEventListener("wheel", (e) => {
  // Comics zoomed in use the wheel to pan; the comic reader handles ctrl.
  if (state.reader?.kind === "cbz" && $("#cbz-zoom").style.transform) return;
  wheelTurn(e);
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
  paper: { bg: "#ece8d8", ink: "#2a2620", link: "#7c5a2e", force: true, grain: true },
};

// The same grain as the app's Paper background, for inside EPUB pages.
const GRAIN_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.35 0 0 0 0 0.3 0 0 0 0 0.2 0 0 0 0.11 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

/// The page colours for the current theme as CSS for inside an EPUB page.
/// They live in FicShelf's own style element, rewritten on every change,
/// rather than in epub.js themes: epub.js adds each theme's stylesheet on
/// first use and never takes it out again, so after Night mode its
/// "!important" colours kept overriding Day mode.
function pageThemeCss() {
  const t = PAGE_THEMES[effectiveTheme()] || PAGE_THEMES.light;
  const imp = t.force ? " !important" : "";
  const css = [
    `body { background: ${t.grain ? `${GRAIN_URL} ` : ""}${t.bg}${imp}; color: ${t.ink}${imp}; }`,
    `a { color: ${t.link}${imp}; }`,
  ];
  if (t.force) {
    css.push(
      "p, div, span, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, em, strong, i, b " +
        "{ color: inherit !important; background-color: transparent !important; }",
    );
  }
  return css.join("\n");
}

const FONT_SIZES = [70, 80, 90, 100, 110, 120, 135, 150, 170, 200];
const FACES = {
  book: "",
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

// "Even margins" (the default) removes a book's own side margins on the
// body and on paragraphs, divisions and sections, so text sits evenly
// inside FicShelf's page margin. Blockquotes keep their indent, and every
// paragraph keeps its first-line indent. "Book's own" leaves the
// publisher's layout alone.
const EVEN_MARGINS_CSS = `
  body { margin-left: 0 !important; margin-right: 0 !important; }
  body p, body div, body section, body article {
    margin-left: 0 !important; margin-right: 0 !important;
    padding-left: 0 !important; padding-right: 0 !important;
  }`;

/// The reader's text-layout choices as CSS for inside an EPUB page:
/// margins, line spacing, paragraph spacing, alignment and hyphenation.
/// Each "Book's" choice adds nothing, leaving the publisher's style.
function textLayoutCss() {
  const css = [];
  if (pref("margins", "even") === "even") css.push(EVEN_MARGINS_CSS);
  const lines = pref("lines", "book");
  if (lines !== "book") {
    css.push(`body, p, div, li, blockquote, span { line-height: ${Number(lines) || 1.5} !important; }`);
  }
  const paras = pref("paras", "book");
  if (paras !== "book") {
    css.push(`p { margin-top: 0 !important; margin-bottom: ${Number(paras) || 0}em !important; }`);
  }
  const align = pref("align", "book");
  if (align === "left" || align === "justify") {
    css.push(`p, div, li, blockquote { text-align: ${align} !important; }`);
  }
  if (pref("hyphens", "off") === "on") {
    css.push(`html, body, p { -webkit-hyphens: auto !important; hyphens: auto !important; }`);
  }
  return css.join("\n");
}

function applyMargins(contents) {
  const doc = contents?.document;
  if (!doc?.head) return;
  // Hyphenation needs to know the language; most books say, some do not.
  if (!doc.documentElement.getAttribute("lang")) doc.documentElement.setAttribute("lang", "en");
  let style = doc.getElementById("ficshelf-layout");
  if (!style) {
    style = doc.createElement("style");
    style.id = "ficshelf-layout";
    doc.head.appendChild(style);
  }
  style.textContent = `${pageThemeCss()}\n${textLayoutCss()}`;
}

function fontSize() {
  const n = Number(pref("fontSize", "100"));
  return FONT_SIZES.includes(n) ? n : 100;
}

function applyPageStyle(rendition) {
  rendition.themes.fontSize(`${fontSize()}%`);
  rendition.themes.font(FACES[pref("fontFace", "book")] ?? "");
  for (const c of rendition.getContents()) applyMargins(c);
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
  if (!r || a.color === "bookmark") return;
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
$("#select-lookup").addEventListener("click", () => {
  const word = (notes.selection?.text || "").trim().split(/\s+/).slice(0, 4).join(" ");
  clearSelection();
  if (word) call("look_up", { word }).catch(() => {});
});

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

function notesOrderKey(a) {
  if (a.cfi.startsWith("page:")) return Number(a.cfi.slice(5)) || 0;
  return null; // EPUB positions are compared as CFIs
}

function renderNotesList() {
  const list = $("#notes-list");
  list.textContent = "";
  const items = [...notes.list];
  const byDate = pref("notesOrder", "page") === "date";
  document.querySelectorAll("#notes-order button").forEach((b) =>
    b.classList.toggle("active", b.dataset.order === (byDate ? "date" : "page")),
  );
  if (byDate) {
    items.sort((a, b) => b.created_at - a.created_at);
  } else {
    const cmp = new ePub.CFI();
    items.sort((a, b) => {
      const ka = notesOrderKey(a);
      const kb = notesOrderKey(b);
      if (ka != null && kb != null) return ka - kb;
      try {
        return cmp.compare(a.cfi, b.cfi);
      } catch {
        return a.created_at - b.created_at;
      }
    });
  }
  $("#notes-empty").hidden = items.length > 0;
  for (const a of items) {
    const li = document.createElement("li");
    const bm = a.color === "bookmark";
    li.classList.toggle("bm", bm);
    if (!bm) li.style.setProperty("--c", HIGHLIGHT[a.color] || HIGHLIGHT.yellow);
    const ex = document.createElement("div");
    ex.className = "ex";
    const text = a.excerpt.length > 220 ? `${a.excerpt.slice(0, 220)}…` : a.excerpt;
    ex.textContent = bm ? `🔖 ${text}` : text;
    li.appendChild(ex);
    if (a.note) {
      const nt = document.createElement("div");
      nt.className = "nt";
      nt.textContent = a.note;
      li.appendChild(nt);
    }
    li.addEventListener("click", () => {
      $("#notes-sheet").close();
      const target = a.cfi.startsWith("page:") ? Number(a.cfi.slice(5)) : a.cfi;
      jumpFrom(() => state.reader?.restore?.(target));
    });
    list.appendChild(li);
  }
}

$("#reader-notes").addEventListener("click", () => {
  renderNotesList();
  $("#notes-sheet").showModal();
});
document.querySelectorAll("#notes-order button").forEach((b) =>
  b.addEventListener("click", () => {
    setPref("notesOrder", b.dataset.order);
    renderNotesList();
  }),
);

// ------------------------------------------------------------- bookmarks

/// The position a bookmark records: an EPUB CFI, or "page:N".
function bookmarkKey() {
  const m = state.reader?.mark?.();
  if (m == null) return null;
  return typeof m === "number" ? `page:${m}` : m;
}

/// The bookmark on the page being read, if any. An EPUB bookmark counts
/// when it falls anywhere on the visible page.
function bookmarkHere() {
  const r = state.reader;
  if (!r) return null;
  const marks = notes.list.filter((a) => a.color === "bookmark");
  if (r.kind === "epub") {
    const range = notes.range;
    if (!range) return null;
    const cmp = new ePub.CFI();
    return (
      marks.find((a) => {
        try {
          return cmp.compare(a.cfi, range.start) >= 0 && cmp.compare(a.cfi, range.end) <= 0;
        } catch {
          return a.cfi === range.start;
        }
      }) || null
    );
  }
  const key = bookmarkKey();
  return marks.find((a) => a.cfi === key) || null;
}

function syncBookmarkButton() {
  const on = Boolean(bookmarkHere());
  $("#reader-bookmark").style.opacity = on ? "1" : "0.55";
  $("#reader-bookmark").title = on ? "Remove this bookmark" : "Bookmark this page";
}

$("#reader-bookmark").addEventListener("click", async () => {
  const r = state.reader;
  if (!r) return;
  const existing = bookmarkHere();
  try {
    if (existing) {
      await call("delete_annotation", { id: existing.id });
      notes.list = notes.list.filter((a) => a.id !== existing.id);
      toast("Bookmark removed.");
    } else {
      const key = bookmarkKey();
      if (!key) return;
      const chapter = r.chapterLabel?.() || "";
      const excerpt = [`Page ${r.current?.() ?? ""}`, chapter].filter(Boolean).join(" · ");
      const a = await call("add_annotation", {
        bookId: r.book.id,
        cfi: key,
        excerpt,
        note: null,
        color: "bookmark",
      });
      notes.list.push(a);
      toast("Bookmarked.");
    }
  } catch {
    /* the toast from call() says why */
  }
  syncBookmarkButton();
});

$("#notes-done").addEventListener("click", () => $("#notes-sheet").close());

// ---------------------------------------------------------------- chapters

/// The book's table of contents, flattened with each entry's depth.
function flattenToc(items, depth = 0, out = []) {
  for (const item of items || []) {
    out.push({ label: (item.label || "").trim() || "Untitled", href: item.href, depth });
    flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

/// Whether `href` (from the table of contents) is the chapter being read.
/// Entries may carry a #fragment; the current location's href does not.
function sameChapter(href, current) {
  if (!href || !current) return false;
  const file = (h) => h.split("#")[0].split("/").pop();
  return file(href) === file(current);
}

$("#reader-toc").addEventListener("click", async () => {
  const epub = notes.epub;
  if (!epub) return;
  let toc = [];
  try {
    const nav = await epub.loaded.navigation;
    toc = flattenToc(nav?.toc);
  } catch {
    /* a book without a table of contents */
  }
  const list = $("#toc-list");
  list.textContent = "";
  // One entry is the whole book, not a chapter list.
  $("#toc-empty").hidden = toc.length > 1;
  let currentEl = null;
  if (toc.length > 1) {
    // Several entries can share the current file (one file per book, as in
    // works FicShelf packages itself); mark the last one at or before the
    // reading position by order instead, when the file alone cannot tell.
    const sameFile = toc.filter((t) => sameChapter(t.href, notes.href));
    const currentHref = state.reader?.currentChapterHref?.();
    for (const t of toc) {
      const li = document.createElement("li");
      li.textContent = t.label;
      li.style.setProperty("--depth", String(Math.min(t.depth, 4)));
      if (currentHref ? t.href === currentHref : sameFile.length === 1 && sameFile[0] === t) {
        li.classList.add("current");
        currentEl = li;
      }
      li.addEventListener("click", () => {
        $("#toc-sheet").close();
        jumpFrom(() => notes.rendition?.display(t.href));
      });
      list.appendChild(li);
    }
  }
  $("#toc-sheet").showModal();
  currentEl?.scrollIntoView({ block: "center" });
});
$("#toc-done").addEventListener("click", () => $("#toc-sheet").close());

// The Aa sheet.
function syncFontSheet() {
  $("#font-size-label").textContent = `${fontSize()}%`;
  const face = pref("fontFace", "book");
  document.querySelectorAll("#font-face button").forEach((b) =>
    b.classList.toggle("active", b.dataset.face === face),
  );
  const margins = pref("margins", "even");
  document.querySelectorAll("#font-margins button").forEach((b) =>
    b.classList.toggle("active", b.dataset.margins === margins),
  );
  const pick = (sel, key, attr, fallback) => {
    const v = pref(key, fallback);
    document.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle("active", b.dataset[attr] === v));
  };
  pick("#font-lines", "lines", "lines", "book");
  pick("#font-paras", "paras", "paras", "book");
  pick("#font-align", "align", "align", "book");
  pick("#font-flow", "flow", "flow", "pages");
  $("#font-hyphens").checked = pref("hyphens", "off") === "on";
}

for (const [sel, key, attr] of [
  ["#font-lines", "lines", "lines"],
  ["#font-paras", "paras", "paras"],
  ["#font-align", "align", "align"],
]) {
  document.querySelectorAll(`${sel} button`).forEach((b) =>
    b.addEventListener("click", () => {
      setPref(key, b.dataset[attr]);
      syncFontSheet();
      readerRestyle?.();
    }),
  );
}
$("#font-hyphens").addEventListener("change", (e) => {
  setPref("hyphens", e.target.checked ? "on" : "off");
  readerRestyle?.();
});
// Pages or one continuous scroll. epub.js lays these out differently, so
// the book is reopened (at the same place) to switch.
document.querySelectorAll("#font-flow button").forEach((b) =>
  b.addEventListener("click", () => {
    if (pref("flow", "pages") === b.dataset.flow) return;
    setPref("flow", b.dataset.flow);
    syncFontSheet();
    const id = state.reader?.book?.id;
    if (id != null) {
      $("#font-sheet").close();
      openBook(id);
    }
  }),
);

document.querySelectorAll("#font-margins button").forEach((b) =>
  b.addEventListener("click", () => {
    setPref("margins", b.dataset.margins);
    syncFontSheet();
    readerRestyle?.();
  }),
);

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

/// The reading area's size, with the width chosen so that it lands exactly
/// on whole device pixels.
///
/// epub.js turns a page by sliding the text one page-width sideways. On a
/// screen whose scale is a fraction (2.625 on the S24 Ultra, so 411.43 CSS
/// pixels across), a width that is not a whole number of device pixels gets
/// rounded slightly differently on every page, and the error builds up: by
/// the middle of a chapter the text sits visibly off to one side. An even
/// width that is a whole number of device pixels keeps every page aligned.
/// FicShelf's own margin each side of the page, in CSS pixels: a little on
/// a phone, more where there is room.
function pageInset(w) {
  return w < 600 ? 16 : w < 1000 ? 28 : 40;
}

function areaSize(el) {
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  let width = Math.floor(r.width - 2 * pageInset(r.width));
  for (let w = width; w > width - 32 && w > 0; w--) {
    const device = w * dpr;
    if (w % 2 === 0 && Math.abs(device - Math.round(device)) < 0.001) {
      width = w;
      break;
    }
  }
  return { width, height: Math.floor(r.height) };
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

  // Read the whole file through the backend and hand epub.js the bytes.
  // Each step is timed in the console, so a slow book shows where the time
  // goes (chrome://inspect over USB on Android).
  const t0 = performance.now();
  const since = () => `${Math.round(performance.now() - t0)} ms`;
  $("#reader-progress").textContent = "Opening…";
  $("#panel-where").textContent = "Opening…";
  const slowNote = setTimeout(() => {
    $("#reader-progress").textContent = "Still opening…";
    toast("Still opening; a large book can take a moment the first time.");
  }, 15_000);

  let bytes;
  try {
    bytes = await invoke("book_bytes", { id: book.id });
  } catch (e) {
    clearTimeout(slowNote);
    throw e;
  }
  console.info(`[epub] read ${bytes.byteLength} bytes in ${since()}`);
  const epub = ePub(bytes, { openAs: "binary" });
  epub.opened.then(() => console.info(`[epub] unpacked in ${since()}`)).catch(() => {});
  const scrolling = pref("flow", "pages") === "scroll";
  const rendition = epub.renderTo(area, {
    width,
    height,
    // Pages, or one continuous scroll through the whole book.
    flow: scrolling ? "scrolled" : "paginated",
    manager: scrolling ? "continuous" : "default",
    // Two pages side by side only when there is room for them, such as the
    // Fold's inner screen in landscape; one page on a phone.
    spread: !scrolling && width >= 800 ? "auto" : "none",
    minSpreadWidth: 800,
    // Without this, epub.js sandboxes each page so strictly that recent
    // Chromium (Android's webview included) runs none of its own layout or
    // touch handling inside it, and the page comes out blank. The book's own
    // scripts still cannot run: the app's Content-Security-Policy, which
    // these pages inherit, only allows the app's own script files.
    allowScriptedContent: true,
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

  $("#view-reader").classList.add("kind-epub");
  rendition.hooks.content.register((contents) => {
    applyMargins(contents);
    contents.window?.addEventListener("wheel", wheelTurn, { passive: true });
    contents.document?.addEventListener("click", (e) => webLinkClicked(e, book), true);
    // A podfic's player inside a work: on a phone, hand it to the native
    // player so it keeps going with the screen off.
    if (nativeAudio) {
      contents.document?.addEventListener(
        "play",
        (e) => {
          const el = e.target;
          if (!(el instanceof contents.window.HTMLMediaElement)) return;
          const src = el.currentSrc || el.src || el.querySelector("source")?.src || "";
          if (!/^https?:\/\//i.test(src)) return;
          el.pause();
          streamPodfic(src, book);
        },
        true,
      );
    }
  });

  // Hiding the toolbar, folding or unfolding, and rotating all change the
  // reading area's size; keep the book matched to it. The watcher starts
  // only once the first page is showing (see below): a ResizeObserver always
  // reports once as it starts, and a resize in the middle of the first
  // display clears the page before epub.js knows where to redraw it.
  let resizeTimer = null;
  let lastSize = { width, height };
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const size = areaSize(area);
      if (!size.width || !size.height) return;
      if (size.width === lastSize.width && size.height === lastSize.height) return;
      lastSize = size;
      const where = rendition.currentLocation()?.start?.cfi;
      rendition.resize(size.width, size.height);
      // epub.js redraws after a resize only if it already knew where it
      // was; make sure the page never stays empty.
      setTimeout(() => {
        if (where && !area.querySelector("iframe")) rendition.display(where);
      }, 300);
    }, 150);
  });

  // A book that never finishes loading would otherwise leave a blank page
  // with no explanation.
  try {
    await withTimeout(
      rendition.display(book.position || undefined).catch(async (e) => {
        // A saved position from an older copy of the file can fail to
        // resolve; fall back to the start rather than not opening at all.
        if (book.position) return rendition.display();
        throw e;
      }),
      120_000,
      "the book did not finish loading after two minutes",
    );
  } finally {
    clearTimeout(slowNote);
    $("#reader-progress").textContent = "";
  }
  console.info(`[epub] first page shown in ${since()}`);
  observer.observe(area);

  // Page colours and fonts go on after the book is showing, so that if one
  // of them misbehaves the book is still readable.
  try {
    applyPageStyle(rendition);
    readerRestyle = () => {
      try {
        applyPageStyle(rendition);
      } catch (e) {
        toast(`Could not apply that style: ${e?.message || e}`, true);
      }
    };
  } catch (e) {
    toast(`The book opened, but its colours and font could not be set: ${e?.message || e}`, true);
  }

  // The book lives in an iframe, so its touches arrive through epub.js
  // rather than the page. screenX is used because the iframe's own
  // coordinates span every page of the chapter, not just the visible one.
  const turner = touchTurner(
    (t) => t.screenX / window.screen.width,
    (t) => t.screenY / window.screen.height,
  );
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
  notes.epub = epub;
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

  // Chapters, resolved to exact positions. A table-of-contents entry points
  // at a file and maybe an anchor in it; turning each into a CFI lets every
  // book (including AO3 works packaged as a single file) know which chapter
  // is being read, jump to the next or previous one, and mark chapters on
  // the progress line. Worked out in the background after opening.
  const cfiCompare = new ePub.CFI();
  let chapters = []; // { label, href, cfi }
  const chapterIndex = () => {
    if (!here || !chapters.length) return -1;
    let found = -1;
    for (let i = 0; i < chapters.length; i++) {
      try {
        if (cfiCompare.compare(chapters[i].cfi, here) <= 0) found = i;
      } catch {
        /* an entry whose position could not be compared */
      }
    }
    return found;
  };
  const resolveChapters = async () => {
    const nav = await epub.loaded.navigation;
    const toc = flattenToc(nav?.toc);
    const out = [];
    for (const t of toc) {
      try {
        const [file, frag] = (t.href || "").split("#");
        const section = epub.spine.get(t.href) || epub.spine.get(file);
        if (!section) continue;
        await section.load(epub.load.bind(epub));
        const doc = section.document;
        const el = (frag && doc?.getElementById(frag)) || doc?.querySelector("body");
        if (!el) continue;
        out.push({ label: t.label, href: t.href, cfi: section.cfiFromElement(el) });
      } catch {
        /* skip an entry that does not resolve */
      }
    }
    out.sort((a, b) => {
      try {
        return cfiCompare.compare(a.cfi, b.cfi);
      } catch {
        return 0;
      }
    });
    return out;
  };
  const markChapters = () => {
    if (chapters.length < 2 || !epub.locations?.length?.()) return;
    setFooterTicks(chapters.map((c) => epub.locations.percentageFromCfi(c.cfi)));
  };
  resolveChapters()
    .then((list) => {
      if (state.reader?.book?.id !== book.id) return;
      chapters = list;
      $("#view-reader").classList.toggle("has-chapters", chapters.length > 1);
      markChapters();
      renderPanelWhere();
    })
    .catch(() => {});

  // Page numbers. An EPUB has no fixed pages: its text reflows to fit the
  // screen and the font size. epub.js "locations" divide the book into
  // page-sized pieces once, so page 123 stays page 123 whatever the text
  // size. Until they are ready the readout is a percentage.
  let here = null;
  const locTotal = () => epub.locations?.length?.() || 0;
  const locOf = (cfi) => {
    const n = epub.locations?.locationFromCfi?.(cfi);
    return typeof n === "number" && n >= 0 ? n + 1 : null;
  };
  const showEpubPage = () => {
    if (!here) return;
    const total = locTotal();
    const n = total ? locOf(here) : null;
    if (n) {
      showPageNumber(Math.min(n, total), total);
      $("#reader-progress").textContent = `${Math.round((n / total) * 100)}%`;
    } else {
      const pct = epub.locations?.percentageFromCfi?.(here);
      const text = typeof pct === "number" && !Number.isNaN(pct) ? `${Math.round(pct * 100)}%` : "";
      $("#reader-progress").textContent = text;
      footer.page = text;
      renderFooter();
      renderPanelWhere();
    }
  };

  let pendingTurn = 0;
  rendition.on("relocated", (location) => {
    clearSelection();
    if (pendingTurn) {
      playTurn(area, pendingTurn);
      pendingTurn = 0;
    }
    here = location.start.cfi;
    notes.href = location.start.href;
    notes.range = { start: location.start.cfi, end: location.end?.cfi || location.start.cfi };
    syncBookmarkButton();
    saveWhere(book, here);
    showEpubPage();
  });

  state.reader = {
    book,
    kind: "epub",
    next: () => {
      pendingTurn = 1;
      return rendition.next();
    },
    prev: () => {
      pendingTurn = -1;
      return rendition.prev();
    },
    total: () => locTotal(),
    current: () => (here && locOf(here)) || 1,
    mark: () => here,
    restore: (cfi) => cfi && rendition.display(cfi),
    chapterLabel: () => chapters[chapterIndex()]?.label || "",
    chapterAt: (href) => chapters.findIndex((c) => c.href === href),
    currentChapterHref: () => chapters[chapterIndex()]?.href || null,
    chapter: (step) => {
      if (!chapters.length) return;
      const i = chapterIndex();
      const j = Math.min(Math.max(i + step, 0), chapters.length - 1);
      // "Previous" from part-way into a chapter goes to its start first.
      const target = step < 0 && i >= 0 && chapters[i].cfi !== here ? i : j;
      return rendition.display(chapters[target].cfi);
    },
    search: async (q) => {
      const found = [];
      for (const item of epub.spine.spineItems) {
        if (found.length >= 200) break;
        try {
          await item.load(epub.load.bind(epub));
          for (const r of item.find(q)) {
            found.push(r);
            if (found.length >= 200) break;
          }
        } catch {
          /* a section that cannot be searched */
        }
      }
      return found;
    },
    goTo: (n) => {
      const cfi = epub.locations?.cfiFromLocation?.(Math.max(0, Math.round(n) - 1));
      if (cfi) rendition.display(cfi);
    },
    // The ResizeObserver above already follows every size change.
    resize: () => {},
    cleanup: () => {
      observer.disconnect();
      clearTimeout(resizeTimer);
      readerRestyle = null;
      clearSelection();
      notes.rendition = null;
      notes.book = null;
      notes.epub = null;
      notes.href = null;
      notes.range = null;
      notes.list = [];
      $("#view-reader").classList.remove("kind-epub");
      rendition.destroy();
      epub.destroy();
    },
  };

  // Locations cost a pass over the whole book, so they are generated in the
  // background and never awaited; page numbers appear when they are ready.
  epub.ready
    .then(() => epub.locations.generate(1600))
    .then(() => {
      if (state.reader?.book?.id !== book.id) return;
      showEpubPage();
      markChapters();
    })
    .catch(() => {});
}

/// The page pill at the bottom. `label` overrides the plain "n / total",
/// for a two-page spread ("12–13 / 689").
// ------------------------------------------------------------ status line
//
// Like FBReader's: a thin progress line (with a mark at each chapter, for
// EPUBs), then the page, the time and the battery.

const footer = { page: "", battery: null, clock: null, batteryHooked: false };

/// The time for the status line, 12- or 24-hour as chosen in Settings.
function clockText(now) {
  const h24 = pref("clock", "12") === "24";
  return now.toLocaleTimeString([], {
    hour: h24 ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: h24 ? "h23" : "h12",
  });
}

function applyClockChoice() {
  const choice = pref("clock", "12");
  document.querySelectorAll("[data-clock-choice]").forEach((b) => {
    b.classList.toggle("active", b.dataset.clockChoice === choice);
    b.setAttribute("aria-checked", String(b.dataset.clockChoice === choice));
  });
}
applyClockChoice();
document.querySelectorAll("[data-clock-choice]").forEach((b) =>
  b.addEventListener("click", () => {
    setPref("clock", b.dataset.clockChoice);
    applyClockChoice();
  }),
);

function renderFooter() {
  const now = new Date();
  const time = clockText(now);
  const bits = [footer.page, time];
  if (footer.battery != null) bits.push(`${footer.battery}%`);
  $("#foot-text").textContent = bits.filter(Boolean).join("   ");
}

function startFooterClock() {
  $("#reader-footer").hidden = false;
  if (!footer.batteryHooked && navigator.getBattery) {
    footer.batteryHooked = true;
    navigator
      .getBattery()
      .then((b) => {
        const update = () => {
          footer.battery = Math.round(b.level * 100);
          renderFooter();
        };
        update();
        b.addEventListener("levelchange", update);
      })
      .catch(() => {});
  }
  clearInterval(footer.clock);
  footer.clock = setInterval(renderFooter, 20_000);
  renderFooter();
}

function stopFooterClock() {
  clearInterval(footer.clock);
  footer.clock = null;
  footer.page = "";
  $("#reader-footer").hidden = true;
  $("#foot-fill").style.width = "0";
  $("#foot-ticks").textContent = "";
}

/// Chapter marks on the progress line, as fractions of the book (0–1).
function setFooterTicks(fractions) {
  const box = $("#foot-ticks");
  box.textContent = "";
  for (const f of fractions) {
    if (!(f > 0 && f < 1)) continue;
    const i = document.createElement("i");
    i.style.left = `${(f * 100).toFixed(2)}%`;
    box.appendChild(i);
  }
}

/// `label` overrides the plain "n/total", for a two-page spread.
function showPageNumber(n, total, label) {
  queueMicrotask(syncBookmarkButton);
  footer.page = label || `${n}/${total}`;
  $("#foot-fill").style.width = `${total ? Math.min(100, (n / total) * 100) : 0}%`;
  renderFooter();
  const range = $("#page-range");
  range.max = String(Math.max(total, 1));
  if (document.activeElement !== range) range.value = String(n);
  renderPanelWhere();
}

/// The middle of the tap menu's bottom panel: "3/249  Chapter title".
function renderPanelWhere(previewPage) {
  const chapter = state.reader?.chapterLabel?.() || "";
  const page = previewPage ? `${previewPage}/${$("#page-range").max}` : footer.page;
  $("#panel-where").textContent = [page, chapter].filter(Boolean).join("  ");
}

// The footer, like the middle of the page, opens the tap menu.
$("#reader-footer").addEventListener("click", () => $("#view-reader").classList.toggle("show-chrome"));

$("#page-range").addEventListener("input", (e) => renderPanelWhere(e.target.value));

// ------------------------------------------------------------- jump back
//
// Any jump (slider, chapter list, ‹ ›, search) remembers where she was, and
// ↶ returns there, as in FBReader.

let jumpBack = null;

function jumpFrom(go) {
  const mark = state.reader?.mark?.();
  if (mark != null) {
    jumpBack = mark;
    $("#panel-back").disabled = false;
  }
  return go();
}

$("#panel-back").addEventListener("click", () => {
  if (jumpBack == null || !state.reader?.restore) return;
  const back = jumpBack;
  jumpFrom(() => state.reader.restore(back));
});

$("#page-range").addEventListener("change", (e) => {
  const n = Number(e.target.value);
  jumpFrom(() => state.reader?.goTo?.(n));
});

// ‹ › in the panel: previous and next chapter.
$("#chap-prev").addEventListener("click", () => jumpFrom(() => state.reader?.chapter?.(-1)));
$("#chap-next").addEventListener("click", () => jumpFrom(() => state.reader?.chapter?.(1)));

// ------------------------------------------------------------- day/night

$("#reader-daynight").addEventListener("click", () => {
  if (effectiveTheme() === "dark") {
    setPref("theme", pref("dayTheme", "paper"));
  } else {
    setPref("dayTheme", effectiveTheme());
    setPref("theme", "dark");
  }
  applyTheme();
  syncDayNight();
});

function syncDayNight() {
  $("#reader-daynight").textContent = effectiveTheme() === "dark" ? "☀" : "🌙";
}

// ------------------------------------------------------------ ⋮ menu

$("#reader-more").addEventListener("click", () => {
  const kind = state.reader?.kind;
  $("#reader-aa").hidden = kind !== "epub";
  $("#reader-notes").hidden = !kind;
  $("#reader-comic").hidden = kind !== "cbz";
  $("#more-sheet").showModal();
});
for (const id of ["#reader-aa", "#reader-notes", "#reader-comic"]) {
  $(id).addEventListener("click", () => $("#more-sheet").close());
}
$("#more-settings").addEventListener("click", () => {
  $("#more-sheet").close();
  leaveReader();
  setTimeout(() => show("settings"), 0);
});
$("#more-close").addEventListener("click", () => $("#more-sheet").close());

// --------------------------------------------------------------- search

$("#reader-search").addEventListener("click", () => {
  $("#search-sheet").showModal();
  $("#book-search").focus();
});
$("#search-done").addEventListener("click", () => $("#search-sheet").close());
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#book-search").value.trim();
  const list = $("#search-results");
  list.textContent = "";
  if (!q || !state.reader?.search) return;
  $("#search-status").textContent = "Searching…";
  let results = [];
  try {
    results = await state.reader.search(q);
  } catch (err) {
    $("#search-status").textContent = `Search failed: ${err?.message || err}`;
    return;
  }
  $("#search-status").textContent = results.length
    ? `${results.length}${results.length >= 200 ? "+" : ""} found.`
    : "Not found in this book.";
  const needle = q.toLowerCase();
  for (const r of results) {
    const li = document.createElement("li");
    // Show the excerpt with the match marked, built from text nodes only.
    const text = r.excerpt || "";
    const at = text.toLowerCase().indexOf(needle);
    if (at >= 0) {
      li.append(text.slice(0, at));
      const m = document.createElement("mark");
      m.textContent = text.slice(at, at + q.length);
      li.append(m, text.slice(at + q.length));
    } else {
      li.textContent = text;
    }
    li.addEventListener("click", () => {
      $("#search-sheet").close();
      jumpFrom(() => state.reader?.restore?.(r.cfi));
    });
    list.appendChild(li);
  }
});

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
    showPageNumber(page, doc.numPages);
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
        render().then(() => playTurn(canvas, 1));
      }
    },
    prev: () => {
      if (page > 1) {
        page -= 1;
        render().then(() => playTurn(canvas, -1));
      }
    },
    resize: () => render(),
    total: () => doc.numPages,
    current: () => page,
    mark: () => page,
    restore: (p) => {
      page = Math.min(Math.max(Number(p) || 1, 1), doc.numPages);
      render();
    },
    goTo: (n) => {
      page = Math.min(Math.max(Math.round(n), 1), doc.numPages);
      render();
    },
    cleanup: () => doc.destroy(),
  };
}

// ----------------------------------------------------------------- comics
//
// One page, or two side by side when the screen is wide; right to left for
// manga; pinch, double-tap and drag to zoom and pan. Pages are fetched ahead
// so turning is instant.

const COMIC_LAYOUTS = ["auto", "single", "double"];

function comicDirection(book, hint) {
  return pref(`dir.${book.id}`, hint ? "rtl" : "ltr");
}

async function openCbz(book, pages, rtlHint) {
  if (!pages.length) throw new Error("no images in this archive");
  const view = $("#cbz-view");
  const zoomLayer = $("#cbz-zoom");
  const [imgA, imgB] = zoomLayer.querySelectorAll(".pg");
  view.hidden = false;
  $("#view-reader").classList.add("kind-cbz");

  let index = Math.min(Math.max(parseInt(book.position || "0", 10) || 0, 0), pages.length - 1);
  let shown = [index];
  let rtl = comicDirection(book, rtlHint) === "rtl";
  let generation = 0;

  // -- fetching, with a small cache around the current page
  const urls = new Map();
  const dims = new Map();
  const url = (i) => {
    if (!urls.has(i)) {
      const p = invoke("cbz_page", { id: book.id, name: pages[i] });
      p.catch(() => urls.delete(i));
      urls.set(i, p);
    }
    return urls.get(i);
  };
  const trim = () => {
    for (const i of [...urls.keys()]) if (i < index - 6 || i > index + 10) urls.delete(i);
  };
  const dimsOf = async (i) => {
    if (dims.has(i)) return dims.get(i);
    const src = await url(i);
    const d = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res({ w: 2, h: 3 });
      im.src = src;
    });
    dims.set(i, d);
    return d;
  };
  // A page that is already a two-page spread is shown on its own.
  const isWide = (d) => d.w > d.h * 1.1;

  const twoUp = () => {
    const mode = pref("comicLayout", "auto");
    if (mode === "single") return false;
    if (mode === "double") return true;
    const r = view.getBoundingClientRect();
    return r.width > r.height * 1.05;
  };

  // The pages shown when `i` is the first: the cover and wide pages alone,
  // otherwise a pair.
  const groupAt = async (i) => {
    if (!twoUp() || i === 0 || i >= pages.length - 1) return [i];
    if (isWide(await dimsOf(i)) || isWide(await dimsOf(i + 1))) return [i];
    return [i, i + 1];
  };
  const prevStart = async (i) => {
    if (i <= 0) return 0;
    if (!twoUp()) return i - 1;
    const j = i - 1;
    if (j === 0 || isWide(await dimsOf(j))) return j;
    if (j - 1 >= 1 && !isWide(await dimsOf(j - 1))) return j - 1;
    return j;
  };

  // -- zoom and pan
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const applyZoom = (animate = false) => {
    zoomLayer.classList.toggle("animate", animate);
    zoomLayer.style.transform = scale === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const clampPan = () => {
    const r = view.getBoundingClientRect();
    tx = Math.min(0, Math.max(r.width - r.width * scale, tx));
    ty = Math.min(0, Math.max(r.height - r.height * scale, ty));
  };
  const resetZoom = (animate = false) => {
    scale = 1;
    tx = 0;
    ty = 0;
    applyZoom(animate);
  };
  const zoomAt = (px, py, s, animate = true) => {
    const r = view.getBoundingClientRect();
    const x = px - r.left;
    const y = py - r.top;
    // Keep the point under the finger where it is.
    const cx = (x - tx) / scale;
    const cy = (y - ty) / scale;
    scale = s;
    tx = x - cx * scale;
    ty = y - cy * scale;
    if (scale <= 1.01) return resetZoom(animate);
    clampPan();
    applyZoom(animate);
  };

  // -- drawing. `turn` is +1 or -1 for a page turn (it decides which side
  // the new page slides in from), 0 for anything else.
  const render = async (turn = 0) => {
    const gen = ++generation;
    const group = await groupAt(index);
    const srcs = await Promise.all(group.map(url));
    if (gen !== generation) return; // a newer turn overtook this one
    shown = group;
    const order = rtl ? [...srcs].reverse() : srcs;
    resetZoom();
    zoomLayer.classList.toggle("two", order.length === 2);
    imgA.src = order[0];
    imgB.hidden = order.length < 2;
    imgB.src = order[1] || "";
    // Forward in a right-to-left comic brings the next page from the left.
    if (turn) playTurn(zoomLayer, rtl ? -turn : turn);
    const first = group[0] + 1;
    const last = group[group.length - 1] + 1;
    const label = first === last ? `${first} / ${pages.length}` : `${first}–${last} / ${pages.length}`;
    $("#reader-progress").textContent = label;
    showPageNumber(first, pages.length, label);
    saveWhere(book, index);
    trim();
    for (let k = 1; k <= 4; k++) {
      const n = last - 1 + k;
      if (n < pages.length) url(n).catch(() => {});
    }
    if (index > 0) url(index - 1).catch(() => {});
  };

  const next = async () => {
    const after = shown[shown.length - 1] + 1;
    if (after >= pages.length) return;
    index = after;
    await render(1);
  };
  const prev = async () => {
    if (index <= 0) return;
    index = await prevStart(index);
    await render(-1);
  };

  // -- gestures: pinch, drag, double-tap, swipe and tap
  const pointers = new Map();
  let pinch = null;
  let gesture = null;
  let lastTap = null;
  let tapTimer = null;
  let lastTouchAt = 0;

  const onDown = (e) => {
    if (e.pointerType === "touch") lastTouchAt = Date.now();
    view.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        tx,
        ty,
      };
      gesture = null;
    } else if (pointers.size === 1) {
      gesture = { x: e.clientX, y: e.clientY, at: Date.now(), lx: e.clientX, ly: e.clientY, moved: false };
    }
  };

  const onMove = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const s = Math.min(5, Math.max(1, (pinch.scale * dist) / (pinch.dist || 1)));
      const r = view.getBoundingClientRect();
      const cx = (pinch.cx - r.left - pinch.tx) / pinch.scale;
      const cy = (pinch.cy - r.top - pinch.ty) / pinch.scale;
      const mx = (a.x + b.x) / 2 - r.left;
      const my = (a.y + b.y) / 2 - r.top;
      scale = s;
      tx = mx - cx * scale;
      ty = my - cy * scale;
      clampPan();
      applyZoom();
      return;
    }
    if (gesture) {
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 10) gesture.moved = true;
      if (scale > 1) {
        tx += e.clientX - gesture.lx;
        ty += e.clientY - gesture.ly;
        clampPan();
        applyZoom();
      }
      gesture.lx = e.clientX;
      gesture.ly = e.clientY;
    }
  };

  const onUp = (e) => {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        if (scale < 1.05) resetZoom(true);
      }
      gesture = null;
      return;
    }
    const g = gesture;
    gesture = null;
    if (!g || pointers.size) return;

    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const quick = Date.now() - g.at < 350;
    const r = view.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;

    // A swipe turns the page, but only when not zoomed in.
    if (scale === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const forward = rtl ? dx > 0 : dx < 0;
      forward ? next() : prev();
      return;
    }
    if (!quick || g.moved) return;

    // Double-tap zooms in on that spot, or back out.
    if (lastTap && Date.now() - lastTap.at < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(tapTimer);
      lastTap = null;
      if (scale > 1) resetZoom(true);
      else zoomAt(e.clientX, e.clientY, 2.5);
      return;
    }

    // Edge taps turn at once; a middle tap waits a moment in case it is the
    // first of a double-tap, then shows or hides the toolbar.
    const fy = (e.clientY - r.top) / r.height;
    const act = tapAction(fx, fy, rtl);
    if (scale === 1 && act !== "menu") {
      act === "next" ? next() : prev();
      lastTap = null;
      return;
    }
    lastTap = { at: Date.now(), x: e.clientX, y: e.clientY };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      lastTap = null;
      $("#view-reader").classList.toggle("show-chrome");
    }, 300);
  };

  view.addEventListener("pointerdown", onDown);
  view.addEventListener("pointermove", onMove);
  view.addEventListener("pointerup", onUp);
  view.addEventListener("pointercancel", onUp);
  // Desktop: double-click to zoom, ctrl+wheel to zoom smoothly.
  const onDblClick = (e) => {
    // Android can report a double-tap as a double-click too; the touch
    // handling above has already dealt with it.
    if (Date.now() - lastTouchAt < 1000) return;
    if (scale > 1) resetZoom(true);
    else zoomAt(e.clientX, e.clientY, 2.5);
  };
  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.min(5, Math.max(1, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))), false);
  };
  view.addEventListener("dblclick", onDblClick);
  view.addEventListener("wheel", onWheel, { passive: false });

  // Turning the phone or unfolding the Fold can switch between one and two
  // pages.
  let wasTwo = twoUp();
  let resizeTimer = null;
  const observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resetZoom();
      if (twoUp() !== wasTwo) {
        wasTwo = twoUp();
        render();
      }
    }, 150);
  });
  observer.observe(view);

  await render();

  state.reader = {
    book,
    kind: "cbz",
    get rtl() {
      return rtl;
    },
    next,
    prev,
    total: () => pages.length,
    current: () => index + 1,
    mark: () => index + 1,
    restore: (n) => {
      index = Math.min(Math.max(Math.round(Number(n)) - 1, 0), pages.length - 1);
      render();
    },
    goTo: (n) => {
      index = Math.min(Math.max(Math.round(n) - 1, 0), pages.length - 1);
      render();
    },
    setDirection: (dir) => {
      rtl = dir === "rtl";
      setPref(`dir.${book.id}`, dir);
      render();
    },
    relayout: () => {
      wasTwo = twoUp();
      render();
    },
    cleanup: () => {
      generation++;
      observer.disconnect();
      clearTimeout(resizeTimer);
      clearTimeout(tapTimer);
      view.removeEventListener("pointerdown", onDown);
      view.removeEventListener("pointermove", onMove);
      view.removeEventListener("pointerup", onUp);
      view.removeEventListener("pointercancel", onUp);
      view.removeEventListener("dblclick", onDblClick);
      view.removeEventListener("wheel", onWheel);
      resetZoom();
      imgA.src = "";
      imgB.src = "";
      urls.clear();
    },
  };
}

// The comic settings sheet.
function syncComicSheet() {
  const r = state.reader;
  const dir = r?.rtl ? "rtl" : "ltr";
  document.querySelectorAll("#comic-dir button").forEach((b) => b.classList.toggle("active", b.dataset.dir === dir));
  const layout = pref("comicLayout", "auto");
  document.querySelectorAll("#comic-layout button").forEach((b) =>
    b.classList.toggle("active", b.dataset.layout === layout),
  );
}
$("#reader-comic").addEventListener("click", () => {
  syncComicSheet();
  $("#comic-sheet").showModal();
});
document.querySelectorAll("#comic-dir button").forEach((b) =>
  b.addEventListener("click", () => {
    state.reader?.setDirection?.(b.dataset.dir);
    syncComicSheet();
  }),
);
document.querySelectorAll("#comic-layout button").forEach((b) =>
  b.addEventListener("click", () => {
    if (!COMIC_LAYOUTS.includes(b.dataset.layout)) return;
    setPref("comicLayout", b.dataset.layout);
    syncComicSheet();
    state.reader?.relayout?.();
  }),
);
$("#comic-done").addEventListener("click", () => $("#comic-sheet").close());

// ------------------------------------------------------------ AO3 search

const AO3_WORK_RE = /archiveofourown\.org\/works\/(\d+)|^\s*(\d{3,})\s*$/i;

$("#btn-ao3-search").addEventListener("click", runSearch);
$("#ao3-query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});

// AO3 shows 20 works a page. More are fetched only when asked for, one
// paced request per page.
const AO3_PAGE_SIZE = 20;
const searchState = { query: "", page: 0, count: 0, loading: false };

$("#btn-search-more").addEventListener("click", loadMoreResults);

async function loadMoreResults() {
  if (searchState.loading || !searchState.query) return;
  searchState.loading = true;
  $("#btn-search-more").hidden = true;
  busy($("#search-more-busy"), true);
  $("#ao3-status").textContent = `${searchState.count} works. Asking AO3 for more…`;
  try {
    const hits = await call("ao3_search", { query: searchState.query, page: searchState.page + 1 });
    searchState.page += 1;
    searchState.count += hits.length;
    renderHits(hits, true);
    $("#ao3-status").textContent = `${searchState.count} works.`;
    $("#btn-search-more").hidden = hits.length < AO3_PAGE_SIZE;
  } catch {
    $("#ao3-status").textContent = `${searchState.count} works. Loading more failed — see Settings → Error log.`;
    $("#btn-search-more").hidden = false;
  } finally {
    searchState.loading = false;
    busy($("#search-more-busy"), false);
  }
}

async function runSearch() {
  const query = $("#ao3-query").value.trim();
  if (!query) return;

  const direct = query.match(AO3_WORK_RE);
  $("#ao3-status").textContent = direct ? "Saving that work from AO3…" : "Searching AO3…";
  busy($("#search-busy"), true);
  $("#ao3-results").textContent = "";
  $("#btn-search-more").hidden = true;
  Object.assign(searchState, { query: "", page: 0, count: 0 });

  try {
    if (direct) {
      const id = Number(direct[1] || direct[2]);
      const book = await call("ao3_save_work", { workId: id });
      $("#ao3-status").textContent = `Saved “${book.title}”.`;
      await refreshLibrary();
      return;
    }
    const hits = await call("ao3_search", { query, page: 1 });
    Object.assign(searchState, { query, page: 1, count: hits.length });
    renderHits(hits);
    $("#ao3-status").textContent = hits.length
      ? `${hits.length} works.`
      : "Nothing found. AO3's own search page may word it differently.";
    // A full page means AO3 probably has more.
    $("#btn-search-more").hidden = hits.length < AO3_PAGE_SIZE;
  } catch {
    $("#ao3-status").textContent = "That didn't work — the reason is in Settings → Error log.";
  } finally {
    busy($("#search-busy"), false);
  }
}

function renderHits(hits, append = false) {
  const box = $("#ao3-results");
  if (!append) box.textContent = "";

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
        if (/slow down|overloaded|paused|hourly|limit|429|signed us out|sign in/i.test(item.error)) {
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

// ------------------------------------------------------------------ sync
//
// Google Drive sync of positions, bookmarks, notes and edited details. It
// runs by itself when the app starts, a moment after closing a book, and
// when the app goes to the background; "Sync now" runs it by hand.

const syncUi = { status: null, running: false, lastError: "", timer: null };

function describeSync() {
  const st = syncUi.status;
  if (!st) return "";
  if (!st.configured) return "Sync isn't set up in this build of FicShelf.";
  if (!st.signed_in) return "Not connected.";
  if (syncUi.running) return "Syncing…";
  const when = st.last_sync_at
    ? new Date(st.last_sync_at * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "not yet";
  return `Connected to Google Drive. Last synced: ${when}.${syncUi.lastError ? ` Last attempt failed: ${syncUi.lastError}` : ""}`;
}

async function refreshSyncStatus() {
  try {
    syncUi.status = await invoke("sync_status");
  } catch {
    syncUi.status = { configured: false, signed_in: false };
  }
  const st = syncUi.status;
  $("#sync-state").textContent = describeSync();
  $("#sync-connect").hidden = !st.configured || st.signed_in;
  $("#sync-run").hidden = !st.signed_in;
  $("#sync-disconnect").hidden = !st.signed_in;
}

/// Run a sync. `quiet` syncs (automatic ones) report problems only in
/// Settings, not as a message over whatever she is doing.
async function runSync(quiet = true) {
  if (syncUi.running || !syncUi.status?.signed_in) return;
  syncUi.running = true;
  $("#sync-state").textContent = describeSync();
  try {
    const s = await invoke("sync_now");
    syncUi.lastError = "";
    const changed = s.positions + s.details + s.annotations + s.removed;
    if (changed && !state.reader) await refreshLibrary();
    if (!quiet) {
      toast(
        changed
          ? `Synced: ${s.positions} position${s.positions === 1 ? "" : "s"}, ${s.annotations} new note${s.annotations === 1 ? "" : "s"} or bookmark${s.annotations === 1 ? "" : "s"}, ${s.details} edit${s.details === 1 ? "" : "s"} from other devices.`
          : "Synced. Everything was already up to date.",
      );
    }
  } catch (e) {
    syncUi.lastError = typeof e === "string" ? e : e?.message || String(e);
    if (!quiet) toast(`Sync failed: ${syncUi.lastError}`, true);
  } finally {
    syncUi.running = false;
    await refreshSyncStatus();
  }
}

/// Sync a little later, so a burst of changes becomes one sync.
function syncSoon(delay = 2500) {
  clearTimeout(syncUi.timer);
  syncUi.timer = setTimeout(() => runSync(true), delay);
}

$("#sync-run").addEventListener("click", () => runSync(false));

$("#sync-connect").addEventListener("click", async () => {
  let code;
  try {
    code = await invoke("sync_begin_sign_in");
  } catch (e) {
    toast(typeof e === "string" ? e : String(e), true);
    return;
  }
  $("#sync-code").textContent = code.user_code;
  $("#sync-url").textContent = (code.verification_url || "https://www.google.com/device").replace(/^https?:\/\//, "");
  $("#sync-open").dataset.url = code.verification_url || "https://www.google.com/device";
  $("#sync-signin").hidden = false;
  $("#sync-buttons").hidden = true;
  try {
    await invoke("sync_finish_sign_in");
    toast("Connected to Google Drive. Syncing now.");
    await refreshSyncStatus();
    runSync(false);
  } catch (e) {
    const msg = typeof e === "string" ? e : String(e);
    if (!/cancelled/i.test(msg)) toast(msg, true);
  } finally {
    $("#sync-signin").hidden = true;
    $("#sync-buttons").hidden = false;
    refreshSyncStatus();
  }
});

$("#sync-open").addEventListener("click", (e) => {
  invoke("sync_open_page", { url: e.currentTarget.dataset.url || "https://www.google.com/device" }).catch(() => {});
});
$("#sync-cancel").addEventListener("click", () => invoke("sync_cancel_sign_in").catch(() => {}));

$("#sync-disconnect").addEventListener("click", async () => {
  if (!(await confirmAsk("Disconnect Google Drive on this device? Your other devices keep syncing."))) return;
  await call("sync_sign_out");
  await refreshSyncStatus();
});

// Sync when the app goes to the background (switching apps, locking the
// phone), so the other devices see where she stopped.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") runSync(true);
});

// ------------------------------------------------------------- settings

document.querySelectorAll("[data-storage]").forEach((b) =>
  b.addEventListener("click", async () => {
    try {
      await invoke("set_phone_storage", { choice: b.dataset.storage });
      await refreshSettings();
      toast(
        b.dataset.storage === "app"
          ? "New downloads will be kept inside FicShelf."
          : `New downloads will go to ${b.textContent}/FicShelf.`,
      );
    } catch (e) {
      toast(String(e), true);
    }
  }),
);

// ------------------------------------------------------- backup/restore

function ficshelfPrefs() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("ficshelf.") && k !== LOG_KEY) out[k] = localStorage.getItem(k);
  }
  return out;
}

function showBackupProgress(title) {
  $("#task-title").textContent = title;
  $("#task-amount").textContent = "";
  busy($("#task-panel"), true);
}

onEvent("backup-progress", ({ payload }) => {
  const { done = 0, total = 0 } = payload || {};
  if ($("#task-panel").hidden) return;
  $("#task-amount").textContent = total ? `${megabytes(done)} of ${megabytes(total)}` : "";
  busy($("#task-panel"), true, total ? done / total : undefined);
}).catch(() => {});

async function makeBackup(withBooks) {
  let dest = null;
  if (!IS_ANDROID) {
    const day = new Date().toISOString().slice(0, 10);
    dest = await saveDialog({
      defaultPath: `FicShelf backup ${day}.zip`,
      filters: [{ name: "FicShelf backup", extensions: ["zip"] }],
    });
    if (!dest) return;
  }
  const status = $("#backup-status");
  status.textContent = "";
  showBackupProgress(withBooks ? "Backing up everything…" : "Backing up reading data…");
  try {
    const made = await invoke("backup_make", { withBooks, prefs: ficshelfPrefs(), dest });
    const books = withBooks ? `, with ${made.books} book file${made.books === 1 ? "" : "s"}` : "";
    status.textContent = `Saved ${megabytes(made.bytes)}${books} to ${made.path}`;
    toast("Backup saved.");
  } catch (e) {
    logError(`backup (${withBooks ? "everything" : "reading data"})`, e);
    toast(`Backup failed: ${e}`, true, false);
  } finally {
    busy($("#task-panel"), false);
  }
}

/// The weekly automatic backup of reading data: checked a little after the
/// app starts (so it never slows the start), and shown in Settings.
async function autoBackup() {
  try {
    const r = await invoke("backup_auto", { prefs: ficshelfPrefs() });
    const when = r.last ? new Date(r.last * 1000).toLocaleDateString() : "not yet";
    $("#backup-auto").textContent = `Automatic weekly backup of reading data: last ${when}, kept in ${r.dir} (newest four).`;
  } catch (e) {
    logError("automatic backup", e);
    $("#backup-auto").textContent = `The automatic weekly backup failed: ${e}`;
  }
}
setTimeout(autoBackup, 20_000);

$("#btn-backup-data").addEventListener("click", () => makeBackup(false));
$("#btn-backup-all").addEventListener("click", () => makeBackup(true));

$("#btn-restore").addEventListener("click", async () => {
  const src = await openDialog({
    multiple: false,
    filters: IS_ANDROID ? undefined : [{ name: "FicShelf backup", extensions: ["zip"] }],
  });
  if (!src) return;
  const ok = await confirmAsk(
    "Restore this backup?\n\nYour current library list, positions, highlights, notes and settings on this device are replaced by the backup's. (The current library is kept aside as library.sqlite3.before-restore, just in case.)",
  );
  if (!ok) return;
  showBackupProgress("Restoring…");
  try {
    const r = await invoke("backup_restore", { src: String(src) });
    // The front end's own settings come back too; then start fresh.
    for (const [k, v] of Object.entries(r.prefs || {})) {
      if (k.startsWith("ficshelf.") && typeof v === "string") localStorage.setItem(k, v);
    }
    const made = new Date((r.created || 0) * 1000).toLocaleString();
    sessionStorage.setItem(
      "ficshelf.restored",
      `Restored the backup from ${made}: ${r.books} books${r.files ? `, ${r.files} files put back` : ""}.`,
    );
    location.reload();
  } catch (e) {
    busy($("#task-panel"), false);
    logError("restore", e);
    toast(`Restore failed: ${e}`, true, false);
  }
});

{
  const msg = sessionStorage.getItem("ficshelf.restored");
  if (msg) {
    sessionStorage.removeItem("ficshelf.restored");
    setTimeout(() => toast(msg), 600);
  }
}

$("#btn-log-copy").addEventListener("click", async () => {
  const list = readLog();
  const text = list.length
    ? `FicShelf error log (${list.length})\n\n${list.map(logLine).join("\n\n")}`
    : "FicShelf error log: no errors recorded.";
  try {
    await navigator.clipboard.writeText(text);
    toast("Error log copied.");
  } catch {
    // Clipboard refused (some WebViews): select the text so it can be copied by hand.
    const range = document.createRange();
    range.selectNodeContents($("#error-log"));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast("Select-all done — use Copy from the menu.");
  }
});
$("#btn-log-clear").addEventListener("click", () => {
  localStorage.removeItem(LOG_KEY);
  renderLog();
});

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
  const where = /\/Documents\/FicShelf\/?$/.test(s.library_dir)
    ? "documents"
    : /\/Download\/FicShelf\/?$/.test(s.library_dir)
      ? "download"
      : "app";
  document.querySelectorAll("[data-storage]").forEach((b) => {
    b.classList.toggle("active", b.dataset.storage === where);
    b.setAttribute("aria-checked", String(b.dataset.storage === where));
  });
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

// ------------------------------------------------------ links in a book

const AUDIO_LINK = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav)(\?|#|$)/i;

/// A tap on a web link inside a book. A link straight to an audio file (a
/// podfic's "download here") can be saved into the library; any other web
/// link opens in the browser. Links within the book are left to epub.js.
function webLinkClicked(e, book) {
  const a = e.target.closest?.("a[href]");
  if (!a) return;
  const href = a.getAttribute("href") || "";
  if (!/^https?:\/\//i.test(href)) return;
  e.preventDefault();
  e.stopPropagation();
  // Links on FicShelf's own podfic page are audio whatever they end in.
  if (AUDIO_LINK.test(new URL(href).pathname) || a.closest(".ficshelf-podfic")) offerPodficSave(href, book);
  else invoke("open_link", { url: href }).catch((err) => toast(String(err), true));
}

function megabytes(n) {
  return n >= 10 * 1024 * 1024 ? `${Math.round(n / 1048576)} MB` : `${(n / 1048576).toFixed(1)} MB`;
}

onEvent("podfic-progress", ({ payload }) => {
  const { got = 0, total = null } = payload || {};
  const panel = $("#task-panel");
  if (panel.hidden) return;
  $("#task-amount").textContent = total ? `${megabytes(got)} of ${megabytes(total)}` : megabytes(got);
  busy(panel, true, total ? got / total : undefined);
}).catch(() => {});

async function offerPodficSave(url, book) {
  const host = new URL(url).host;
  const ok = await ask(
    `Save this podfic to your library?\n\nIt will be downloaded from ${host} so it plays offline, with its place remembered.`,
    { title: "Save podfic", okLabel: "Save", cancelLabel: "Open in browser" },
  );
  if (!ok) {
    invoke("open_link", { url }).catch((err) => toast(String(err), true));
    return;
  }
  const panel = $("#task-panel");
  $("#task-title").textContent = `Saving podfic from ${host}…`;
  $("#task-amount").textContent = "connecting";
  busy(panel, true);
  try {
    const saved = await invoke("save_podfic_url", {
      url,
      title: book?.title || null,
      author: book?.author || null,
    });
    toast(`Saved “${saved.title}” — it's in your library under Podfics.`);
    refreshLibrary();
  } catch (err) {
    logError(`save podfic (${url})`, err);
    toast(`Could not save the podfic: ${err}`, true, false);
  } finally {
    busy(panel, false);
  }
}

// --------------------------------------------------------------- podfic
//
// Podfics are audio files in the library. One plays at a time; it keeps
// playing while she browses, with a small bar above the bottom of the
// screen, and its place is saved (and synced) as seconds.

const AUDIO_EXTS = ["mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "flac", "wav"];
const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
const SLEEP_STEPS = [0, 15, 30, 45, 60, -1]; // minutes; -1 = end of file

/// On Android, podfics play through the phone's own media player (see
/// scripts/patch-android.py), which keeps going with the screen off and has
/// lock-screen and notification controls. This stands in for the <audio>
/// element: the same properties and events, driven by polling the native
/// player's state.
class NativeAudio extends EventTarget {
  constructor(bridge) {
    super();
    this.bridge = bridge;
    this.s = { loaded: false, pos: 0, dur: NaN, playing: false, ended: false };
    this.rate = 1;
    this.error = null;
    this.timer = null;
  }
  get currentTime() {
    return this.s.pos;
  }
  set currentTime(v) {
    this.s.pos = v;
    this.bridge.audioSeek(Number(v) || 0);
  }
  get duration() {
    return this.s.dur;
  }
  get paused() {
    return !this.s.playing;
  }
  get ended() {
    return this.s.ended;
  }
  get playbackRate() {
    return this.rate;
  }
  set playbackRate(r) {
    this.rate = r;
    this.bridge.audioRate(r);
    this.dispatchEvent(new Event("ratechange"));
  }
  /// Load a file by its path on the phone.
  open(path, title, artist) {
    this.error = null;
    const problem = this.bridge.audioLoad(path, title || "", artist || "");
    if (problem) {
      this.error = { code: 4, message: problem };
      setTimeout(() => this.dispatchEvent(new Event("error")), 0);
      return;
    }
    this.metaSent = false;
    this.poll(true);
    this.startPolling();
    this.poll();
  }
  /// Stream from the web; ready (or failed) a moment later.
  openUrl(url, title, artist) {
    this.error = null;
    this.metaSent = false;
    this.s = { loaded: false, pos: 0, dur: NaN, playing: false, ended: false, preparing: true };
    this.bridge.audioLoadUrl(url, title || "", artist || "");
    this.startPolling();
  }
  play() {
    this.bridge.audioPlay();
    setTimeout(() => this.poll(), 150);
    return Promise.resolve();
  }
  pause() {
    this.bridge.audioPause();
    setTimeout(() => this.poll(), 150);
  }
  startPolling() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.poll(), 500);
  }
  poll(quiet = false) {
    let next;
    try {
      next = JSON.parse(this.bridge.audioState());
    } catch {
      return;
    }
    const was = this.s;
    this.s = { ...next, dur: next.dur == null ? NaN : next.dur };
    if (quiet) return;
    if (next.error && !this.error) {
      this.error = { code: 2, message: next.error };
      this.dispatchEvent(new Event("error"));
      return;
    }
    if (!this.metaSent && next.loaded && !next.preparing) {
      this.metaSent = true;
      this.dispatchEvent(new Event("loadedmetadata"));
    }
    if (next.playing && !was.playing) this.dispatchEvent(new Event("play"));
    if (!next.playing && was.playing) this.dispatchEvent(new Event(next.ended ? "ended" : "pause"));
    if (next.playing || next.pos !== was.pos) this.dispatchEvent(new Event("timeupdate"));
  }
}

const nativeAudio =
  IS_ANDROID && window.FicShelfAndroid && window.FicShelfAndroid.audioLoad
    ? new NativeAudio(window.FicShelfAndroid)
    : null;

const listen = {
  book: null,
  audio: nativeAudio || $("#listen-audio"),
  seeking: false,
  lastSaved: 0,
  sleepIndex: 0,
  sleepTimer: null,
  sleepAt: 0,
  blobUrl: null,
};

function clock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

async function openPodfic(book) {
  if (book.missing) {
    toast(`That file is no longer at ${book.path}`, true);
    return;
  }
  if (listen.book?.id === book.id) {
    showListen();
    return;
  }
  // open_book lets the file through the asset protocol (computers).
  const { book: fresh } = await call("open_book", { id: book.id });
  savePodficPlace(true);
  listen.audio.pause();
  listen.book = fresh;
  const a = listen.audio;
  $("#listen-error").hidden = true;
  $("#listen-title").textContent = fresh.title;
  $("#listen-author").textContent = fresh.author || "";
  $("#mini-title").textContent = fresh.title;
  const art = $("#listen-art");
  art.innerHTML = "<span>🎧</span>";
  if (fresh.has_cover) {
    invoke("book_cover", { id: fresh.id })
      .then((url) => {
        if (url && listen.book?.id === fresh.id) {
          const img = document.createElement("img");
          img.src = url;
          img.alt = "";
          art.replaceChildren(img);
        }
      })
      .catch(() => {});
  }
  setMediaSession(fresh);
  showListen();

  let start = parseFloat(fresh.position || "0") || 0;
  // The phone's player keeps its own note of the place on pause and when
  // the app is swiped away, which is newer if the page could not save it.
  if (nativeAudio) {
    try {
      const saved = JSON.parse(window.FicShelfAndroid.audioSaved());
      if (saved.path === fresh.path && saved.at > (fresh.last_opened_at || 0) * 1000) start = saved.pos;
    } catch {
      /* nothing saved */
    }
  }
  a.addEventListener(
    "loadedmetadata",
    () => {
      if (listen.book?.id !== fresh.id) return; // another podfic was opened meanwhile
      // Start a few seconds back, so she hears where she left off.
      if (start > 0 && start < a.duration - 1) a.currentTime = Math.max(0, start - 3);
      a.playbackRate = Number(pref("podficSpeed", "1")) || 1;
      renderPodfic();
    },
    { once: true },
  );
  try {
    await loadPodficSource(fresh);
  } catch (e) {
    $("#listen-error").hidden = false;
    $("#listen-error").textContent = `Could not load this file: ${typeof e === "string" ? e : e?.message || e}`;
  }
}

const AUDIO_MIME = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
};

/// Point the player at a podfic. On a computer the file streams through the
/// asset protocol. Android's WebView never delivers audio that way (the
/// request just hangs), so there the file is read in over IPC, like EPUBs,
/// and played from memory.
async function loadPodficSource(book) {
  const a = listen.audio;
  if (listen.blobUrl) {
    URL.revokeObjectURL(listen.blobUrl);
    listen.blobUrl = null;
  }
  if (!IS_ANDROID) {
    a.src = convertFileSrc(book.path);
    return;
  }
  if (nativeAudio) {
    nativeAudio.open(book.path, book.title, book.author);
    return;
  }
  $("#listen-title").textContent = book.title;
  $("#listen-now").textContent = "Loading…";
  a.removeAttribute("src");
  listen.loading = true;
  let bytes;
  try {
    bytes = await invoke("book_bytes", { id: book.id });
  } finally {
    listen.loading = false;
  }
  if (listen.book?.id !== book.id) return; // she picked another meanwhile
  const ext = book.path.split(".").pop().toLowerCase();
  const blob = new Blob([bytes], { type: AUDIO_MIME[ext] || "audio/mpeg" });
  listen.blobUrl = URL.createObjectURL(blob);
  a.src = listen.blobUrl;
  a.load();
}

/// Play a podfic straight from the web on the podfic screen, through the
/// phone's own player (background, notification, lock screen).
function streamPodfic(url, book) {
  if (listen.book?.path === url) {
    showListen();
    togglePlay();
    return;
  }
  savePodficPlace(true);
  listen.audio.pause();
  const saved = parseFloat(localStorage.getItem(`ficshelf.stream.${url}`) || "0") || 0;
  listen.book = {
    id: null,
    stream: true,
    path: url,
    title: book?.title || "Podfic",
    author: book?.author || "",
    position: String(saved),
  };
  $("#listen-error").hidden = true;
  $("#listen-title").textContent = listen.book.title;
  $("#listen-author").textContent = listen.book.author;
  $("#mini-title").textContent = listen.book.title;
  $("#listen-art").innerHTML = "<span>🎧</span>";
  if (book?.id && book.has_cover) {
    invoke("book_cover", { id: book.id })
      .then((u) => {
        if (u && listen.book?.path === url) {
          const img = document.createElement("img");
          img.src = u;
          img.alt = "";
          $("#listen-art").replaceChildren(img);
        }
      })
      .catch(() => {});
  }
  const a = listen.audio;
  a.addEventListener(
    "loadedmetadata",
    () => {
      if (listen.book?.path !== url) return; // another podfic was opened meanwhile
      if (saved > 0 && saved < a.duration - 1) a.currentTime = Math.max(0, saved - 3);
      a.playbackRate = Number(pref("podficSpeed", "1")) || 1;
      a.play();
      renderPodfic();
    },
    { once: true },
  );
  $("#listen-now").textContent = "Connecting…";
  nativeAudio.openUrl(url, listen.book.title, listen.book.author);
  showListen();
}

function showListen() {
  show("listen");
  if (!history.state?.listen) history.pushState({ listen: true }, "");
  renderPodfic();
}

function leaveListen() {
  if (history.state?.listen) history.back();
  else show("library");
}

window.addEventListener("popstate", () => {
  if ($("#view-listen").classList.contains("active")) show("library");
});

function renderPodfic() {
  const a = listen.audio;
  const dur = a.duration;
  const playing = !a.paused && !a.ended;
  $("#listen-play").textContent = playing ? "⏸" : "▶";
  $("#listen-play").title = playing ? "Pause" : "Play";
  $("#mini-play").textContent = playing ? "⏸" : "▶";
  $("#listen-speed").textContent = `${a.playbackRate}×`;
  if (!listen.seeking && Number.isFinite(dur) && dur > 0) {
    $("#listen-seek").value = String(Math.round((a.currentTime / dur) * 1000));
  }
  $("#listen-now").textContent = clock(a.currentTime);
  $("#listen-left").textContent = Number.isFinite(dur) ? `−${clock(dur - a.currentTime)}` : "";
  $("#mini-time").textContent = Number.isFinite(dur) ? `${clock(a.currentTime)} / ${clock(dur)}` : "";
  const away = !$("#view-listen").classList.contains("active");
  $("#mini-player").hidden = !(listen.book && away && !document.body.classList.contains("reading"));
}

function savePodficPlace(force = false) {
  const a = listen.audio;
  if (!listen.book || !Number.isFinite(a.currentTime)) return;
  const now = Date.now();
  if (!force && now - listen.lastSaved < 5000) return;
  listen.lastSaved = now;
  let pos = a.currentTime;
  if (a.ended) pos = 0; // finished: next time starts from the top
  listen.book.position = pos.toFixed(1);
  if (listen.book.stream) {
    // Not a library item: its place is kept by its address.
    try {
      localStorage.setItem(`ficshelf.stream.${listen.book.path}`, listen.book.position);
    } catch {
      /* storage full */
    }
    return;
  }
  saveWhere(listen.book, listen.book.position);
}

function togglePlay() {
  const a = listen.audio;
  if (!listen.book || listen.loading) return;
  if (a.paused) {
    a.play().catch((e) => {
      $("#listen-error").hidden = false;
      $("#listen-error").textContent = `Could not play this file: ${e?.message || e}`;
    });
  } else {
    a.pause();
  }
}

function skip(sec) {
  const a = listen.audio;
  if (!Number.isFinite(a.duration)) return;
  a.currentTime = Math.min(Math.max(0, a.currentTime + sec), a.duration);
  renderPodfic();
}

{
  const a = listen.audio;
  a.addEventListener("timeupdate", () => {
    renderPodfic();
    savePodficPlace();
  });
  a.addEventListener("play", renderPodfic);
  a.addEventListener("pause", () => {
    renderPodfic();
    savePodficPlace(true);
    syncSoon();
  });
  a.addEventListener("ended", () => {
    renderPodfic();
    savePodficPlace(true);
    if (SLEEP_STEPS[listen.sleepIndex] === -1) setSleep(0);
  });
  a.addEventListener("ratechange", renderPodfic);
  a.addEventListener("error", () => {
    if (!listen.book) return;
    $("#listen-error").hidden = false;
    const code = a.error?.code;
    const why =
      code === 4
        ? "it could not be loaded, or is in a format this device does not support"
        : code === 3
          ? "the file seems to be damaged"
          : code === 2
            ? "it could not be read"
            : "something went wrong";
    $("#listen-error").textContent = `This file could not be played: ${why} (error ${code ?? "?"}${
      a.error?.message ? `, ${a.error.message}` : ""
    }).`;
  });

  $("#listen-play").addEventListener("click", togglePlay);
  $("#mini-play").addEventListener("click", togglePlay);
  $("#mini-open").addEventListener("click", () => listen.book && showListen());
  $("#listen-back").addEventListener("click", leaveListen);
  $("#listen-back15").addEventListener("click", () => skip(-15));
  $("#listen-fwd30").addEventListener("click", () => skip(30));

  const seek = $("#listen-seek");
  seek.addEventListener("input", () => {
    listen.seeking = true;
    if (Number.isFinite(a.duration)) {
      $("#listen-now").textContent = clock((Number(seek.value) / 1000) * a.duration);
    }
  });
  seek.addEventListener("change", () => {
    listen.seeking = false;
    if (Number.isFinite(a.duration)) a.currentTime = (Number(seek.value) / 1000) * a.duration;
    savePodficPlace(true);
  });

  $("#listen-speed").addEventListener("click", () => {
    const i = SPEEDS.indexOf(a.playbackRate);
    const next = SPEEDS[(i + 1) % SPEEDS.length] ?? 1;
    a.playbackRate = next;
    setPref("podficSpeed", String(next));
  });
  $("#listen-sleep").addEventListener("click", () => setSleep((listen.sleepIndex + 1) % SLEEP_STEPS.length));

  // Space bar on a computer.
  document.addEventListener("keydown", (e) => {
    if (!$("#view-listen").classList.contains("active")) return;
    if (e.key === " " && e.target === document.body) {
      e.preventDefault();
      togglePlay();
    }
    if (e.key === "ArrowLeft") skip(-15);
    if (e.key === "ArrowRight") skip(30);
    if (e.key === "Escape") leaveListen();
  });

  // Leaving the app is a good moment to keep her place.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") savePodficPlace(true);
  });
}

window.__podficBar = renderPodfic;

function setSleep(index) {
  listen.sleepIndex = index;
  clearInterval(listen.sleepTimer);
  listen.sleepTimer = null;
  const step = SLEEP_STEPS[index];
  const btn = $("#listen-sleep");
  if (step === 0) {
    btn.textContent = "Sleep: off";
    return;
  }
  if (step === -1) {
    btn.textContent = "Sleep: end of file";
    return;
  }
  listen.sleepAt = Date.now() + step * 60_000;
  const tick = () => {
    const left = listen.sleepAt - Date.now();
    if (left <= 0) {
      listen.audio.pause();
      setSleep(0);
      return;
    }
    btn.textContent = `Sleep: ${Math.ceil(left / 60_000)} min`;
  };
  tick();
  listen.sleepTimer = setInterval(tick, 15_000);
}

/// Lock-screen and headphone controls, where the platform offers them.
function setMediaSession(book) {
  const ms = navigator.mediaSession;
  if (!ms || typeof MediaMetadata === "undefined") return;
  try {
    ms.metadata = new MediaMetadata({ title: book.title, artist: book.author || "", album: "FicShelf" });
    ms.setActionHandler("play", () => listen.audio.play());
    ms.setActionHandler("pause", () => listen.audio.pause());
    ms.setActionHandler("seekbackward", () => skip(-15));
    ms.setActionHandler("seekforward", () => skip(30));
  } catch {
    /* optional */
  }
}

// ----------------------------------------------------------------- boot

(async function boot() {
  await refreshLibrary();
  await refreshSavedSearches();
  await refreshSettings();
  renderUpdates(await call("list_updates"));
  // Pick up what was read on other devices.
  await refreshSyncStatus();
  runSync(true);
})().catch((e) => toast(`Could not start: ${e}`, true));
