import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen as onEvent } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { parseQuery, matchesQuery, readStatus } from "./query.js";
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
const TAP_ACTIONS = [
  ["next", "Next page"],
  ["prev", "Previous page"],
  ["menu", "Show the menu"],
  ["bookmark", "Bookmark"],
  ["tts", "Read aloud"],
  ["toc", "Chapters"],
  ["search", "Search"],
  ["daynight", "Day / night"],
  ["none", "Nothing"],
];
const DEFAULT_TAPMAP = ["prev", "menu", "next", "prev", "menu", "next", "prev", "menu", "next"];

function tapMap() {
  try {
    const m = JSON.parse(pref("tapMap", ""));
    if (Array.isArray(m) && m.length === 9) return m;
  } catch {
    /* default */
  }
  return [...DEFAULT_TAPMAP];
}

function actionSelect(value, onChange) {
  const sel = document.createElement("select");
  for (const [v, label] of TAP_ACTIONS) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function syncTapZones() {
  const v = pref("tapZones", "sides");
  document.querySelectorAll("#tapzone-picker button").forEach((b) => b.classList.toggle("active", b.dataset.zones === v));
  $("#tapmap").hidden = v !== "custom";
  if (v !== "custom") return;
  const grid = $("#tapmap-grid");
  grid.textContent = "";
  const map = tapMap();
  map.forEach((act, i) =>
    grid.appendChild(
      actionSelect(act, (val) => {
        const m = tapMap();
        m[i] = val;
        setPref("tapMap", JSON.stringify(m));
      }),
    ),
  );
  for (const [id, key] of [["#swipe-up", "swipeUp"], ["#swipe-down", "swipeDown"]]) {
    const old = $(id);
    const fresh = actionSelect(pref(key, "none"), (val) => setPref(key, val));
    fresh.id = old.id;
    old.replaceWith(fresh);
  }
}

/// Everything a tap or swipe can be set to do.
function runTapAction(act) {
  const r = state.reader;
  if (!r || !act || act === "none") return;
  if (act === "next") return r.next?.();
  if (act === "prev") return r.prev?.();
  if (act === "menu") return $("#view-reader").classList.toggle("show-chrome");
  if (act === "tts") return tts.on ? ttsPause() : ttsStart();
  const button = { bookmark: "#reader-bookmark", toc: "#reader-toc", search: "#reader-search", daynight: "#reader-daynight" }[act];
  if (button) $(button)?.click();
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
  // Kept between visits: Android may restart the page when the app has
  // been in the background, which used to drop her back to All books.
  libView: pref("libView", "all") === "series" ? "series" : "all", // "all" or "series"
  openSeries: pref("openSeries", "") || null, // the group key being looked at in the Series view
  shelf: pref("shelf", "") || null, // a pinned tag shown as its own tab
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
  if (view === "history") renderHistoryView();
  if (view === "servers" && $("#servers-browse").hidden) renderServers();
  refreshCooldown();
  if (view === "settings") {
    renderLog();
    if (!settingsGroupWanted) openSettingsGroup(null);
    settingsGroupWanted = false;
  }
  window.__podficBar?.(); // the "now playing" bar shows everywhere but the player
}

$$("#nav button[data-view]").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

// Settings opens on a short list of groups; each group is its own screen.
var settingsGroupWanted = false;
function openSettingsGroup(group) {
  const view = $("#view-settings");
  view.dataset.group = group || "";
  $("#settings-groups").hidden = !!group;
  $("#settings-back").hidden = !group;
  const btn = group && document.querySelector(`[data-open-group="${group}"] strong`);
  $("#settings-title").textContent = btn ? btn.textContent : "Settings";
  $$("#view-settings .setting").forEach((el) => el.classList.toggle("in-group", el.dataset.group === group));
  view.scrollTop = 0;
  window.scrollTo(0, 0);
}
$$("[data-open-group]").forEach((b) => b.addEventListener("click", () => openSettingsGroup(b.dataset.openGroup)));
$("#settings-back").addEventListener("click", () => openSettingsGroup(null));

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
  checkTracking();
}

let filterTerms = { text: null, terms: [] };
/// Selecting several books (Library ⋯ → Select books).
const selection = { on: false, ids: new Set() };

/// The library filter understands Calibre-style fields (see query.js).
function matchesFilter(book) {
  if (!state.filter) return true;
  if (filterTerms.text !== state.filter) filterTerms = { text: state.filter, terms: parseQuery(state.filter) };
  return matchesQuery(book, filterTerms.terms);
}

const STARS = ["", "★", "★★", "★★★", "★★★★", "★★★★★"];

/// The line under a cover: author, then stars if rated.
function cardSubtitle(book) {
  const bits = [];
  if (book.author) bits.push(book.author);
  if (book.rating) bits.push(STARS[book.rating]);
  return bits.join(" · ");
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
  b.classList.toggle("active", !state.shelf && b.dataset.libview === state.libView),
);
$$(".tabs button[data-libview]").forEach((b) =>
  b.addEventListener("click", () => {
    state.libView = b.dataset.libview;
    state.openSeries = null;
    state.shelf = null;
    setPref("shelf", "");
    $$(".tabs button[data-libview]").forEach((x) => x.classList.toggle("active", x === b));
    renderShelfTabs();
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
  const card = cardShell(book.title, cardSubtitle(book), book);
  card.title = book.missing ? `Missing: ${book.path}` : book.path;
  card.dataset.id = book.id;
  if (readStatus(book) === "finished") {
    const done = document.createElement("span");
    done.className = "done-mark";
    done.textContent = "✓";
    done.title = "Finished";
    card.appendChild(done);
  }
  if (selection.on) {
    card.classList.add("selectable");
    card.classList.toggle("selected", selection.ids.has(book.id));
  }

  const fmt = document.createElement("span");
  fmt.className = "fmt";
  fmt.textContent = formatLabel(book);
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
    if (selection.on) {
      toggleSelected(book.id, card);
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
  let pressedLong = false;
  card.addEventListener("click", () => {
    if (pressedLong) {
      pressedLong = false;
      return;
    }
    state.openSeries = name;
    renderShelf();
    $("#view-library").scrollTop = 0;
  });
  if (IS_ANDROID) {
    onLongPress(card, () => {
      pressedLong = true;
      openSeriesRename(name);
    });
  } else {
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openSeriesRename(name);
    });
  }
  return card;
}

function syncLibLayout() {
  const list = pref("libLayout", "grid") === "list";
  $("#shelf").classList.toggle("list", list);
  $("#lib-layout").textContent = list ? "▦ Grid" : "☰ List";
}

function renderShelf() {
  setPref("libView", state.libView);
  setPref("openSeries", state.openSeries || "");
  const shelf = $("#shelf");
  shelf.textContent = "";
  syncLibLayout();
  $("#library-empty").hidden = state.books.length > 0;
  if (state.shelf && !pinnedShelves().includes(state.shelf)) state.shelf = null;
  const onShelf = (b) => !state.shelf || (b.tags || []).some((t) => t.toLowerCase() === state.shelf.toLowerCase());
  const visible = state.books.filter((b) => matchesFilter(b) && onShelf(b));
  if (state.reversed) visible.reverse();
  renderContinue(visible.length);

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

const ZIP_COMIC = /\.(cbz|zip)$/i;

/// What the little label on a cover says: the file's own kind.
function formatLabel(book) {
  if (book.format === "audio") return "🎧 podfic";
  if (book.format === "cbz") {
    const ext = (book.path.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
    if (!ext || !["cbz", "zip", "cbr", "rar", "cb7", "7z"].includes(ext)) return "pages";
    return ext === "zip" ? "cbz" : ext === "rar" ? "cbr" : ext === "7z" ? "cb7" : ext;
  }
  if (book.format === "mobi") return (book.path.match(/\.(azw3?|prc)$/i) || [])[1]?.toLowerCase() || "mobi";
  return book.format;
}

function openBookMenu(book) {
  menuBook = book;
  $("#book-menu-title").textContent = book.title;
  const convertible = book.format === "mobi" || (book.format === "cbz" && !ZIP_COMIC.test(book.path));
  $("#book-menu-convert").hidden = !convertible || Boolean(book.drm);
  $("#book-menu-convert").textContent = book.format === "mobi" ? "Convert to EPUB" : "Convert to CBZ";
  $("#book-menu-finished").textContent = readStatus(book) === "finished" ? "Mark as unread" : "Mark as finished";
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
  if (!(await confirmAsk(`Remove "${book.title}" from the library?`))) return;
  const deleteFile = await askDeleteFiles(1, book.path);
  let r;
  try {
    r = await call("forget_book", { id: book.id, deleteFile });
  } catch {
    return;
  }
  await refreshLibrary();
  reportRemoved(r, deleteFile);
});

/// The second question after removing books: delete the files as well?
async function askDeleteFiles(n, path) {
  const what = n === 1 ? "its file" : `their ${n} files`;
  const where = n === 1 && path ? `\n\n${path}` : "";
  const msg = `Also delete ${what} from this device?${where}\n\nThis cannot be undone. Choose Keep to leave the file${n === 1 ? "" : "s"} where ${n === 1 ? "it is" : "they are"}.`;
  try {
    return await ask(msg, { title: "Delete from disk?", kind: "warning", okLabel: "Delete", cancelLabel: "Keep" });
  } catch {
    return window.confirm(msg);
  }
}

function reportRemoved(r, deleteFile) {
  const n = r?.removed ?? 0;
  let msg = `Removed ${n} book${n === 1 ? "" : "s"} from the library`;
  if (deleteFile) msg += ` and deleted ${r.deleted} file${r.deleted === 1 ? "" : "s"}`;
  msg += ".";
  if (r?.problems?.length) {
    for (const p of r.problems) logError("delete file", p);
    toast(`${msg} ${r.problems.length} file${r.problems.length === 1 ? "" : "s"} could not be deleted (see the error log).`, true, false);
  } else toast(msg);
}

$("#book-menu-edit").addEventListener("click", () => {
  $("#book-menu").close();
  const book = menuBook;
  if (!book) return;
  $("#edit-title").value = book.title;
  $("#edit-author").value = book.author || "";
  $("#edit-series").value = book.series || "";
  $("#edit-index").value = book.series_index ?? "";
  $("#edit-tags").value = (book.tags || []).join(", ");
  $("#edit-rating").value = book.rating ? String(book.rating) : "";
  $("#edit-status").value = book.status || "";
  renderTagPicks();
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
    await call("set_marks", {
      id: book.id,
      tags: splitTags($("#edit-tags").value),
      rating: $("#edit-rating").value ? Number($("#edit-rating").value) : null,
      status: $("#edit-status").value || null,
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

function splitTags(text) {
  return (text || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/// Her most used tags as chips under the Tags box; tapping one adds it.
let tagCache = [];
async function renderTagPicks() {
  try {
    tagCache = await invoke("list_tags");
  } catch {
    tagCache = [];
  }
  const box = $("#edit-tag-picks");
  box.textContent = "";
  const have = new Set(splitTags($("#edit-tags").value).map((t) => t.toLowerCase()));
  for (const [tag] of tagCache.slice(0, 16)) {
    if (have.has(tag.toLowerCase())) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = tag;
    b.addEventListener("click", () => {
      const now = splitTags($("#edit-tags").value);
      now.push(tag);
      $("#edit-tags").value = now.join(", ");
      b.remove();
    });
    box.appendChild(b);
  }
}

// Quick finish / unread from the book menu.
$("#book-menu-finished").addEventListener("click", async () => {
  $("#book-menu").close();
  const book = menuBook;
  if (!book) return;
  const done = readStatus(book) === "finished";
  await call("set_marks", { id: book.id, tags: book.tags || [], rating: book.rating ?? null, status: done ? "unread" : "finished" });
  await refreshLibrary();
  toast(done ? "Marked as unread." : "Marked as finished.");
});

$("#book-menu-convert").addEventListener("click", async () => {
  $("#book-menu").close();
  const book = menuBook;
  if (!book) return;
  $("#task-title").textContent = `Converting ${book.title}…`;
  $("#task-amount").textContent = "";
  busy($("#task-panel"), true);
  try {
    const done = await invoke("convert_book", { id: book.id });
    await refreshLibrary();
    toast(`Converted. It's now ${done.format.toUpperCase()}, kept in Converted in your downloads folder; the original is untouched.`);
  } catch (e) {
    logError(`convert (${book.path})`, e);
    toast(`Could not convert it: ${e}`, true, false);
  } finally {
    busy($("#task-panel"), false);
  }
});

// -------------------------------------------------------- library menu

$("#btn-lib-more").addEventListener("click", () => $("#lib-menu").showModal());
$("#lib-menu-cancel").addEventListener("click", () => $("#lib-menu").close());
$("#lib-menu").addEventListener("click", (e) => {
  if (e.target === $("#lib-menu")) $("#lib-menu").close();
});
$("#lib-select").addEventListener("click", () => {
  $("#lib-menu").close();
  startSelecting();
});
$("#lib-search-help").addEventListener("click", () => {
  $("#lib-menu").close();
  $("#search-help").showModal();
});
$("#search-help-close").addEventListener("click", () => $("#search-help").close());
$("#lib-app-update").addEventListener("click", async () => {
  $("#lib-menu").close();
  toast("Checking for a new version…");
  try {
    const u = await invoke("check_app_update");
    if (!u.newer) {
      toast(`You have the newest version (${u.current}).`);
      return;
    }
    // Show the usual banner, even if "Later" was chosen for this version.
    setPref("updateDismissed", "");
    await checkForNewVersion({ quiet: true });
    toast(`FicShelf ${u.latest} is available — see the banner at the top.`);
  } catch (e) {
    toast(`Could not check: ${e}`, true);
  }
});

// ----------------------------------------------------------- selecting

function startSelecting(firstId) {
  selection.on = true;
  selection.ids = new Set(firstId != null ? [firstId] : []);
  document.body.classList.add("selecting");
  $("#select-bar").hidden = false;
  renderShelf();
  updateSelectBar();
}

function stopSelecting() {
  selection.on = false;
  selection.ids.clear();
  document.body.classList.remove("selecting");
  $("#select-bar").hidden = true;
  renderShelf();
}

function toggleSelected(id, card) {
  if (selection.ids.has(id)) selection.ids.delete(id);
  else selection.ids.add(id);
  card?.classList.toggle("selected", selection.ids.has(id));
  updateSelectBar();
}

function updateSelectBar() {
  const n = selection.ids.size;
  $("#select-count").textContent = `${n} selected`;
  $("#select-edit").disabled = n === 0;
  $("#select-remove").disabled = n === 0;
}

/// The selected books in the order they are shown, for numbering a series.
function selectedInOrder() {
  return [...document.querySelectorAll("#shelf .card[data-id]")]
    .map((c) => Number(c.dataset.id))
    .filter((id) => selection.ids.has(id));
}

$("#book-menu-select").addEventListener("click", () => {
  $("#book-menu").close();
  if (menuBook) startSelecting(menuBook.id);
});
$("#select-done").addEventListener("click", stopSelecting);
$("#select-all").addEventListener("click", () => {
  document.querySelectorAll("#shelf .card[data-id]").forEach((c) => selection.ids.add(Number(c.dataset.id)));
  renderShelf();
  updateSelectBar();
});
$("#select-remove").addEventListener("click", async () => {
  const ids = [...selection.ids];
  if (!ids.length) return;
  if (!(await confirmAsk(`Remove ${ids.length} book${ids.length === 1 ? "" : "s"} from the library?`))) return;
  const one = ids.length === 1 ? state.books.find((b) => b.id === ids[0]) : null;
  const deleteFiles = await askDeleteFiles(ids.length, one?.path);
  let r;
  try {
    r = await call("forget_books", { ids, deleteFiles });
  } catch {
    return; // the toast and the error log say why
  }
  stopSelecting();
  await refreshLibrary();
  reportRemoved(r, deleteFiles);
});
$("#select-edit").addEventListener("click", () => {
  const n = selection.ids.size;
  if (!n) return;
  $("#bulk-title").textContent = `Edit ${n} book${n === 1 ? "" : "s"}`;
  for (const id of ["bulk-author", "bulk-series", "bulk-add-tags", "bulk-remove-tags"]) $(`#${id}`).value = "";
  $("#bulk-number").checked = false;
  $("#bulk-clear-series").checked = false;
  $("#bulk-rating").value = "keep";
  $("#bulk-status").value = "keep";
  $("#bulk-dialog").showModal();
});
$("#bulk-cancel").addEventListener("click", () => $("#bulk-dialog").close());
$("#bulk-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const rating = $("#bulk-rating").value;
  const status = $("#bulk-status").value;
  const change = {
    author: $("#bulk-author").value || null,
    series: $("#bulk-series").value || null,
    clearSeries: $("#bulk-clear-series").checked,
    numberFrom: $("#bulk-number").checked ? Number($("#bulk-number-from").value) || 1 : null,
    addTags: splitTags($("#bulk-add-tags").value),
    removeTags: splitTags($("#bulk-remove-tags").value),
    rating: /^[1-5]$/.test(rating) ? Number(rating) : null,
    clearRating: rating === "none",
    status: status === "keep" ? null : status,
  };
  try {
    const n = await call("bulk_edit", { ids: selectedInOrder(), change });
    $("#bulk-dialog").close();
    stopSelecting();
    await refreshLibrary();
    toast(`${n} book${n === 1 ? "" : "s"} updated.`);
  } catch {
    /* the toast says why */
  }
});

// ------------------------------------------------------ online lookup

let lookupBook = null;

$("#book-menu-online").addEventListener("click", () => {
  $("#book-menu").close();
  if (!menuBook) return;
  lookupBook = menuBook;
  // A file name often carries volume numbers and brackets; the series
  // and title together are usually the better search.
  $("#lookup-title").value = lookupBook.title;
  $("#lookup-author").value = lookupBook.author || "";
  $("#lookup-results").textContent = "";
  $("#lookup-status").textContent = "";
  $("#lookup-dialog").showModal();
  runLookup();
});
$("#lookup-close").addEventListener("click", () => $("#lookup-dialog").close());
$("#lookup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runLookup();
});

async function runLookup() {
  const title = $("#lookup-title").value.trim();
  const author = $("#lookup-author").value.trim();
  if (!title) return;
  $("#lookup-status").textContent = "Searching…";
  $("#lookup-results").textContent = "";
  let found = [];
  try {
    found = await invoke("lookup_book", { title, author: author || null });
  } catch (e) {
    $("#lookup-status").textContent = String(e);
    logError("find details online", e);
    return;
  }
  $("#lookup-status").textContent = found.length ? `${found.length} results.` : "Nothing found. Try fewer words, or leave out the author.";
  for (const c of found) $("#lookup-results").appendChild(lookupCard(c));
}

function lookupCard(c) {
  const el = document.createElement("article");
  el.className = "lookup-card";
  if (c.cover_url) {
    const img = document.createElement("img");
    img.src = c.cover_url;
    img.alt = "";
    img.loading = "lazy";
    el.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "lookup-nocover";
    ph.textContent = "No cover";
    el.appendChild(ph);
  }
  const info = document.createElement("div");
  const t = document.createElement("strong");
  t.textContent = c.title;
  const by = document.createElement("div");
  by.className = "muted small";
  by.textContent = [c.authors.join(", "), c.year, c.publisher, c.source].filter(Boolean).join(" · ");
  info.append(t, by);
  if (c.description) {
    const d = document.createElement("p");
    d.className = "small";
    d.textContent = c.description.length > 220 ? `${c.description.slice(0, 220)}…` : c.description;
    info.appendChild(d);
  }
  const row = document.createElement("div");
  row.className = "row";
  const useAll = document.createElement("button");
  useAll.className = "primary";
  useAll.textContent = "Use this";
  useAll.addEventListener("click", () => applyLookup(c, { details: true, cover: true }));
  row.appendChild(useAll);
  if (c.cover_url) {
    const coverOnly = document.createElement("button");
    coverOnly.textContent = "Cover only";
    coverOnly.addEventListener("click", () => applyLookup(c, { details: false, cover: true }));
    row.appendChild(coverOnly);
  }
  info.appendChild(row);
  el.appendChild(info);
  return el;
}

async function applyLookup(c, { details, cover }) {
  if (!lookupBook) return;
  try {
    await call("apply_lookup", {
      id: lookupBook.id,
      title: details ? c.title : null,
      author: details ? c.authors.join(", ") || null : null,
      coverUrl: cover ? c.cover_url || null : null,
    });
    $("#lookup-dialog").close();
    await refreshLibrary();
    toast(details ? "Details updated." : "Cover updated.");
  } catch {
    /* the toast says why */
  }
}

// -------------------------------------------------------- rename series

let renamingSeries = null;

function openSeriesRename(name) {
  const books = state.books.filter((b) => groupOf(b) === name);
  if (!books.length) return;
  renamingSeries = { name, ids: books.map((b) => b.id) };
  $("#series-dialog-count").textContent = `“${name}” · ${books.length} book${books.length === 1 ? "" : "s"}`;
  $("#series-new-name").value = name === OTHER ? "" : name;
  $("#series-dialog").showModal();
  $("#series-new-name").select();
}

$("#btn-series-rename").addEventListener("click", () => state.openSeries && openSeriesRename(state.openSeries));
$("#series-cancel").addEventListener("click", () => $("#series-dialog").close());
$("#series-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = renamingSeries;
  const name = $("#series-new-name").value.trim();
  if (!r || !name) return;
  try {
    await call("bulk_edit", { ids: r.ids, change: { series: name } });
  } catch {
    return; // the toast says why
  }
  $("#series-dialog").close();
  if (state.openSeries === r.name) state.openSeries = name;
  await refreshLibrary();
  toast(`Renamed to “${name}”.`);
});

// ----------------------------------------------------------- duplicates

$("#lib-duplicates").addEventListener("click", () => {
  $("#lib-menu").close();
  $("#dupes-dialog").showModal();
  scanDupes();
});
$("#dupes-refresh").addEventListener("click", scanDupes);

async function scanDupes() {
  $("#dupes-list").textContent = "";
  $("#dupes-status").textContent = "Looking…";
  $("#dupes-refresh").disabled = true;
  let groups = [];
  try {
    groups = await invoke("find_duplicates");
  } catch (e) {
    $("#dupes-status").textContent = `Could not look: ${e}`;
    logError("find duplicates", e);
    return;
  } finally {
    $("#dupes-refresh").disabled = false;
  }
  renderDupes(groups);
}
$("#dupes-close").addEventListener("click", () => $("#dupes-dialog").close());

function renderDupes(groups) {
  const box = $("#dupes-list");
  box.textContent = "";
  $("#dupes-status").textContent = groups.length
    ? `${groups.length} book${groups.length === 1 ? " is" : "s are"} in the library more than once. Pick the copy to keep; the others' highlights, notes and tags move to it, and they leave the library (no file is deleted).`
    : "No duplicates found.";
  for (const g of groups) {
    const sec = document.createElement("section");
    sec.className = "dupe-group";
    const h = document.createElement("h4");
    h.textContent = `${g.books[0].title}${g.reason === "same file" ? " — identical files" : " — same title and author"}`;
    sec.appendChild(h);
    for (const b of g.books) {
      const row = document.createElement("div");
      row.className = "dupe-row";
      const where = document.createElement("span");
      where.className = "muted small";
      where.textContent = `${b.format.toUpperCase()} · ${b.path}`;
      const keep = document.createElement("button");
      keep.textContent = "Keep this one";
      keep.addEventListener("click", async () => {
        const others = g.books.filter((o) => o.id !== b.id).map((o) => o.id);
        try {
          await call("merge_books", { keep: b.id, others });
          sec.remove();
          await refreshLibrary();
          toast("Merged.");
        } catch {
          /* the toast says why */
        }
      });
      row.append(where, keep);
      sec.appendChild(row);
    }
    box.appendChild(sec);
  }
}

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
            extensions: ["epub", "pdf", "cbz", "zip", "cbr", "rar", "cb7", "7z", "mobi", "azw3", "azw", "prc", ...AUDIO_EXTS],
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
  busy($("#task-panel"), true, 0);
  for (const [i, item] of items.entries()) {
    $("#task-title").textContent = `Copying ${item.name}`;
    $("#task-amount").textContent = `${i + 1} of ${items.length}`;
    busy($("#task-panel"), true, i / items.length);
    try {
      report.added.push(await invoke("import_uri", { uri: item.uri, folder: item.folder }));
    } catch (e) {
      report.failed.push([item.name, typeof e === "string" ? e : e?.message || String(e)]);
    }
  }
  busy($("#task-panel"), false);
  for (const [file, why] of report.failed) logError(`add folder (${file})`, why);
  await refreshLibrary();
  reportImport(report);
}

// A big folder comes in in the background, with a progress panel.
onEvent("import-progress", ({ payload }) => {
  const { done = 0, total = 0, name = "" } = payload || {};
  if ($("#task-panel").hidden) return;
  $("#task-amount").textContent = total ? `${done} of ${total}` : "";
  if (name) $("#task-title").textContent = `Adding ${name}`;
  busy($("#task-panel"), true, total ? done / total : undefined);
}).catch(() => {});

async function importFolderInPlace(path) {
  $("#task-title").textContent = "Looking through the folder…";
  $("#task-amount").textContent = "";
  busy($("#task-panel"), true);
  try {
    const report = await invoke("import_folder", { path });
    await refreshLibrary();
    refreshWatched();
    reportImport(report);
    for (const [file, why] of report.failed) logError(`add folder (${file})`, why);
  } catch (e) {
    logError("add folder", e);
    toast(`Could not add the folder: ${e}`, true, false);
  } finally {
    busy($("#task-panel"), false);
  }
}

// ------------------------------------------------------ share over Wi-Fi

function showShare(st) {
  $("#share-info").hidden = !st;
  $("#btn-share").textContent = st ? "Stop sharing" : "Start sharing";
  if (st) {
    $("#share-url").textContent = st.url;
    $("#share-pin").textContent = st.pin;
  }
}

$("#btn-share").addEventListener("click", async () => {
  const on = !$("#share-info").hidden;
  try {
    if (on) {
      await invoke("share_stop");
      showShare(null);
    } else {
      showShare(await invoke("share_start"));
    }
  } catch (e) {
    logError("share over Wi-Fi", e);
    toast(`Could not start sharing: ${e}`, true, false);
  }
});
invoke("share_status").then(showShare).catch(() => {});

// ------------------------------------------------------ watched folders

async function refreshWatched() {
  let folders = [];
  try {
    folders = await invoke("watched_folders");
  } catch {
    /* older library: none */
  }
  $("#btn-check-folders").hidden = folders.length === 0;
  $("#watched-setting").hidden = folders.length === 0;
  const list = $("#watched-list");
  list.textContent = "";
  for (const path of folders) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = path;
    const stop = document.createElement("button");
    stop.textContent = "Stop watching";
    stop.addEventListener("click", async () => {
      await call("unwatch_folder", { path });
      toast("FicShelf will no longer check that folder. Its books stay in the library.");
      refreshWatched();
    });
    li.append(name, stop);
    list.appendChild(li);
  }
  return folders;
}

/// Look for new books in the watched folders. Quiet at startup (a note
/// only if something was found); with feedback when tapped.
async function checkFolders(quiet) {
  const btn = $("#btn-check-folders");
  btn.disabled = true;
  if (!quiet) toast("Checking your folders…");
  try {
    const r = await invoke("check_folders");
    for (const [file, why] of r.failed) logError(`check folders (${file})`, why);
    if (r.added.length) {
      await refreshLibrary();
      toast(`${r.added.length} new book${r.added.length === 1 ? "" : "s"} found in your folders.`);
    } else if (!quiet) {
      toast(r.unreachable.length ? "A watched folder could not be opened (moved, or All files access is off)." : "No new books.");
    }
    if (r.unreachable.length) logError("check folders", `could not open: ${r.unreachable.join(", ")}`);
  } catch (e) {
    if (!quiet) toast(`Could not check the folders: ${e}`, true);
    else logError("check folders", e);
  } finally {
    btn.disabled = false;
  }
}

$("#btn-check-folders").addEventListener("click", () => {
  $("#lib-menu").close();
  checkFolders(false);
});

// At startup, a few seconds in, so opening the app is never slowed.
setTimeout(async () => {
  const folders = await refreshWatched();
  if (folders.length) checkFolders(true);
}, 5_000);

let folderPathPicked = null;
window.__ficshelfFolderPath = (path) => {
  const resolve = folderPathPicked;
  folderPathPicked = null;
  resolve?.(path);
};

/// On a phone: read the folder in place (All files access, nothing copied),
/// or copy it in as before.
async function addAndroidFolderChoice() {
  const bridge = window.FicShelfAndroid;
  const canInPlace = bridge?.pickFolderPath && bridge?.hasAllFilesAccess;
  const inPlace =
    canInPlace &&
    (await ask(
      "Read the books from where they are, or copy them into FicShelf?\n\nReading in place uses no extra space (best for big folders), but needs FicShelf to have All files access, and moving the folder later means adding it again.\n\nCopying works without that permission but takes up the folder's size again.",
      { title: "Add folder", okLabel: "Read in place", cancelLabel: "Copy into FicShelf" },
    ));
  if (!inPlace) return addAndroidFolder();
  if (!bridge.hasAllFilesAccess()) {
    const go = await ask(
      "To read books where they are, Android needs you to switch on All files access for FicShelf.\n\nOn the next screen, turn on \"Allow access to manage all files\", come back, and tap Add folder again.",
      { title: "One permission", okLabel: "Open settings", cancelLabel: "Not now" },
    );
    if (go) bridge.requestAllFilesAccess();
    return;
  }
  const path = await new Promise((resolve) => {
    folderPathPicked = resolve;
    bridge.pickFolderPath();
  });
  if (path === null) return; // cancelled
  if (!path) {
    toast("That location can't be read in place. Pick a folder on the phone's storage or SD card, or choose Copy.", true);
    return;
  }
  await importFolderInPlace(path);
}

$("#btn-add-folder").addEventListener("click", async () => {
  if (IS_ANDROID) {
    try {
      await addAndroidFolderChoice();
    } catch (e) {
      toast(`Could not add the folder: ${e?.message || e}`, true);
    }
    return;
  }
  const dir = await openDialog({ directory: true });
  if (!dir) return;
  await importFolderInPlace(dir);
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
  ttsStop();
  closeSide();
  stopReading();
  stopAuto();
  keepAwake(false);
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
  applyRuler();
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
  startReading(book);
  if (pref("keepAwake", "1") === "1") keepAwake(true);
  $("#reader-title").textContent = book.title;
  $("#reader-author").textContent = book.author || "";
  syncDayNight();
  $("#reader-progress").textContent = "";

  try {
    // Kindle books arrive converted to EPUB (see book_bytes).
    if (book.format === "epub" || book.format === "mobi") await openEpub(book);
    else if (book.format === "pdf") await openPdf(book);
    else await openCbz(book, pages, rtlHint);
    // Comics and PDFs have bookmarks too (highlights need text).
    if (book.format !== "epub" && book.format !== "mobi") {
      notes.book = book;
      try {
        notes.list = await invoke("list_annotations", { bookId: book.id });
      } catch {
        notes.list = [];
      }
      syncBookmarkButton();
    }
    applyRuler();
  } catch (e) {
    $("#reader-error").hidden = false;
    $("#reader-error").textContent = `Could not open this file: ${e}`;
  }
}

function saveWhere(book, position) {
  invoke("save_position", { id: book.id, position: String(position) }).catch(() => {});
  readingTick(true);
}

// ------------------------------------------------------- side by side
//
// A second EPUB (or Kindle book) in the right half of the reader, with its
// own pages and place. The main book keeps the left half.

const side = { book: null, epub: null, rendition: null, observer: null };

function closeSide() {
  try {
    side.observer?.disconnect();
    side.rendition?.destroy();
    side.epub?.destroy();
  } catch {
    /* closing anyway */
  }
  Object.assign(side, { book: null, epub: null, rendition: null, observer: null });
  $("#side-area").textContent = "";
  $("#side-pane").hidden = true;
  $("#reader-stage").classList.remove("split");
}

function renderSidePicker() {
  const q = $("#side-filter").value.trim().toLowerCase();
  const list = $("#side-list");
  list.textContent = "";
  const books = state.books
    .filter((b) => (b.format === "epub" || b.format === "mobi") && !b.drm && b.id !== state.reader?.book?.id)
    .filter((b) => !q || `${b.title} ${b.author || ""}`.toLowerCase().includes(q))
    .slice(0, 80);
  for (const b of books) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = b.author ? `${b.title} — ${b.author}` : b.title;
    btn.addEventListener("click", () => {
      $("#side-picker").close();
      openSide(b);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  if (!books.length) list.innerHTML = "<li class='muted small'>No EPUB or Kindle books match.</li>";
}

$("#reader-side").addEventListener("click", () => {
  $("#more-sheet").close();
  if (side.book) return closeSide();
  $("#side-filter").value = "";
  renderSidePicker();
  $("#side-picker").showModal();
});
$("#side-filter").addEventListener("input", renderSidePicker);
$("#side-cancel").addEventListener("click", () => $("#side-picker").close());
$("#side-close").addEventListener("click", closeSide);
$("#side-prev").addEventListener("click", () => side.rendition?.prev());
$("#side-next").addEventListener("click", () => side.rendition?.next());

async function openSide(book) {
  closeSide();
  $("#reader-stage").classList.add("split");
  $("#side-pane").hidden = false;
  $("#side-title").textContent = book.title;
  $("#side-where").textContent = "Opening…";
  const area = $("#side-area");
  try {
    const bytes = await invoke("book_bytes", { id: book.id });
    if (!$("#reader-stage").classList.contains("split")) return;
    const epub = ePub(bytes, { openAs: "binary" });
    const size = () => {
      const r = area.getBoundingClientRect();
      return { width: Math.max(200, Math.floor(r.width - 16)) & ~1, height: Math.max(200, Math.floor(r.height)) };
    };
    const rendition = epub.renderTo(area, {
      ...size(),
      flow: "paginated",
      manager: "default",
      spread: "none",
      allowScriptedContent: true,
    });
    rendition.themes.default({ "img, svg, image": { "max-width": "100% !important", "max-height": "92vh !important" } });
    rendition.hooks.content.register((contents) => {
      applyMargins(contents);
      contents.window?.addEventListener("wheel", (e) => {
        if (Math.abs(e.deltaY) > 3) (e.deltaY > 0 ? rendition.next() : rendition.prev());
      }, { passive: true });
    });
    Object.assign(side, { book, epub, rendition });
    await rendition.display(book.position || undefined).catch(() => rendition.display());
    applyPageStyle(rendition);
    // Taps: left half back, right half forward.
    let start = null;
    rendition.on("touchstart", (e) => {
      const t = e.changedTouches?.[0];
      if (t) start = { x: t.screenX, y: t.screenY, at: Date.now() };
    });
    rendition.on("touchend", (e) => {
      const t = e.changedTouches?.[0];
      if (!t || !start) return;
      const dx = t.screenX - start.x;
      const quick = Date.now() - start.at < 350;
      start = null;
      if (Math.abs(dx) > 50) return dx < 0 ? rendition.next() : rendition.prev();
      if (!quick || Math.abs(dx) > 12) return;
      const r = area.getBoundingClientRect();
      const fx = (t.screenX - window.screenX - r.left) / r.width;
      fx < 0.5 ? rendition.prev() : rendition.next();
    });
    rendition.on("relocated", (loc) => {
      const pct = epub.locations?.percentageFromCfi?.(loc.start.cfi);
      $("#side-where").textContent = typeof pct === "number" && !Number.isNaN(pct) ? `${Math.round(pct * 100)}%` : "";
      invoke("save_position", { id: book.id, position: loc.start.cfi }).catch(() => {});
    });
    epub.ready.then(() => epub.locations.generate(1600)).catch(() => {});
    let t = 0;
    side.observer = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => side.rendition && side.rendition.resize(size().width, size().height), 150);
    });
    side.observer.observe(area);
  } catch (e) {
    logError("side by side", e);
    toast(`Could not open ${book.title}: ${e}`, true);
    closeSide();
  }
}

// -------------------------------------------------------- reading ruler

function applyRuler() {
  const on = pref("ruler", "") === "1" && Boolean(state.reader) && state.reader.kind !== "cbz";
  const r = $("#reader-ruler");
  r.hidden = !on;
  $("#disp-ruler").checked = pref("ruler", "") === "1";
  if (!on) return;
  // About two lines of text at the current size.
  const px = Math.round(16 * (fontSize() / 100) * 1.6 * 1.35);
  r.style.setProperty("--ruler-h", `${px}px`);
  r.style.setProperty("--ruler-y", `${Number(pref("rulerY", "0.3")) * 100}%`);
}
$("#disp-ruler").addEventListener("change", (e) => {
  setPref("ruler", e.target.checked ? "1" : "");
  applyRuler();
});
{
  const grip = $("#reader-ruler .ruler-grip");
  let dragging = false;
  grip.addEventListener("pointerdown", (e) => {
    dragging = true;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const stage = $("#reader-stage").getBoundingClientRect();
    const y = Math.min(0.92, Math.max(0, (e.clientY - stage.top) / stage.height - 0.02));
    setPref("rulerY", y.toFixed(3));
    $("#reader-ruler").style.setProperty("--ruler-y", `${y * 100}%`);
  });
  const end = () => (dragging = false);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

// ---------------------------------------------------------- read aloud
//
// Reads an EPUB aloud paragraph by paragraph, highlighting the one being
// read and turning pages to follow it. The voice is the system's own: the
// phone's text-to-speech engine (through FicShelfAndroid), the web view's
// speechSynthesis (Windows), or speech-dispatcher on Linux.

const TTS_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
const TTS_SLEEP = [0, 15, 30, 45, 60, -1]; // minutes; -1 = end of chapter
const tts = {
  on: false,
  paused: false,
  engine: null, // "android" | "web" | "spd"
  chunks: [], // { id, text, el }
  pos: 0, // the chunk being read
  queued: 0, // chunks handed to the engine (android/web)
  seq: 0, // bumps on every restart, so stale events are ignored
  sleepUntil: 0,
  sleepChapter: false,
  sectionIndex: -1,
};

function ttsEngine() {
  if (window.FicShelfAndroid?.ttsSpeak) return "android";
  if ("speechSynthesis" in window && speechSynthesis.getVoices().length) return "web";
  return null;
}

async function ttsPickEngine() {
  if (window.FicShelfAndroid?.ttsSpeak) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      tts.onReady = (ok) => {
        clearTimeout(t);
        resolve(ok ? "android" : null);
      };
      window.FicShelfAndroid.ttsInit();
    });
  }
  if ("speechSynthesis" in window) {
    // Voices load asynchronously the first time.
    if (!speechSynthesis.getVoices().length) {
      await new Promise((r) => {
        speechSynthesis.addEventListener("voiceschanged", r, { once: true });
        setTimeout(r, 1500);
      });
    }
    if (speechSynthesis.getVoices().length) return "web";
  }
  try {
    if (await invoke("tts_system_available")) return "spd";
  } catch {
    /* not available */
  }
  return null;
}

window.__ficshelfTts = (kind, id) => {
  if (kind === "ready") return tts.onReady?.(true);
  if (kind === "failed") return tts.onReady?.(false);
  ttsEvent(kind, id);
};

/// Block elements worth reading, in order, without reading nested ones twice.
function ttsBlocks(doc) {
  const sel = "p, h1, h2, h3, h4, h5, h6, li, blockquote, dt, dd, pre, figcaption, td, th, div";
  const out = [];
  for (const el of doc.body?.querySelectorAll(sel) || []) {
    if (el.querySelector(sel.replace(/, div$/, ""))) continue; // has block children: read those
    if (el.tagName === "DIV" && el.querySelector("div")) continue;
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 1) continue;
    out.push({ el, text });
  }
  return out;
}

/// Long paragraphs are split into sentences (engines have length limits).
function ttsSplit(text, max = 900) {
  if (text.length <= max) return [text];
  const parts = text.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) || [text];
  const out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += p;
    while (cur.length > max) {
      out.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function ttsContents() {
  const r = notes.rendition;
  if (!r) return null;
  const loc = r.currentLocation();
  const idx = loc?.start?.index;
  const all = r.getContents();
  return all.find((c) => c.sectionIndex === idx) || all[0] || null;
}

/// Chunks for the section on screen, from the first paragraph on the page.
function ttsLoadSection(fromStart) {
  const contents = ttsContents();
  if (!contents?.document) return false;
  tts.sectionIndex = contents.sectionIndex;
  const doc = contents.document;
  if (!doc.getElementById("ficshelf-tts-style")) {
    const st = doc.createElement("style");
    st.id = "ficshelf-tts-style";
    st.textContent = ".ficshelf-tts { background: rgba(255, 196, 0, 0.28) !important; border-radius: 3px; }";
    doc.head?.appendChild(st);
  }
  const blocks = ttsBlocks(doc);
  let startEl = null;
  if (!fromStart) {
    try {
      const cfi = notes.rendition.currentLocation()?.start?.cfi;
      const range = cfi && contents.range(cfi);
      let node = range?.startContainer;
      while (node && node.nodeType !== 1) node = node.parentNode;
      startEl = node;
    } catch {
      /* start of the section then */
    }
  }
  tts.chunks = [];
  let started = !startEl;
  for (const b of blocks) {
    if (!started && (b.el === startEl || b.el.contains(startEl) || startEl.contains?.(b.el) ||
        (b.el.compareDocumentPosition(startEl) & Node.DOCUMENT_POSITION_PRECEDING))) {
      started = true;
    }
    if (!started) continue;
    for (const t of ttsSplit(b.text)) tts.chunks.push({ text: t, el: b.el, contents });
  }
  if (!tts.chunks.length) for (const b of blocks) for (const t of ttsSplit(b.text)) tts.chunks.push({ text: t, el: b.el, contents });
  tts.chunks.forEach((c, i) => (c.id = `${tts.seq}:${i}`));
  tts.pos = 0;
  tts.queued = 0;
  return true;
}

function ttsMark(chunk) {
  for (const old of chunk?.el?.ownerDocument?.querySelectorAll(".ficshelf-tts") || []) old.classList.remove("ficshelf-tts");
  if (!chunk?.el) return;
  chunk.el.classList.add("ficshelf-tts");
  // Turn the page if the paragraph has moved off it.
  try {
    const r = notes.rendition;
    const cfi = chunk.contents.cfiFromNode(chunk.el);
    const loc = r.currentLocation();
    const cmp = new ePub.CFI();
    const end = loc?.end?.cfi;
    const start = loc?.start?.cfi;
    if ((end && cmp.compare(cfi, end) > 0) || (start && cmp.compare(cfi, start) < 0)) r.display(cfi);
  } catch {
    /* following the page is a nicety */
  }
}

function ttsRate() {
  return Number(pref("ttsRate", "1")) || 1;
}

function ttsSpeakChunk(c, flush) {
  if (tts.engine === "android") {
    window.FicShelfAndroid.ttsSpeak(c.id, c.text, ttsRate(), pref("ttsVoice", ""), flush);
  } else if (tts.engine === "web") {
    const u = new SpeechSynthesisUtterance(c.text);
    u.rate = ttsRate();
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === pref("ttsVoice", ""));
    if (v) u.voice = v;
    u.lang = v?.lang || c.el?.ownerDocument?.documentElement?.lang || "en";
    u.onstart = () => ttsEvent("start", c.id);
    u.onend = () => ttsEvent("done", c.id);
    u.onerror = (e) => ttsEvent(e.error === "interrupted" || e.error === "canceled" ? "cancel" : "error", c.id);
    if (flush) speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } else if (tts.engine === "spd") {
    const seq = tts.seq;
    ttsEvent("start", c.id);
    invoke("tts_say", { text: c.text, rate: ttsRate() })
      .then(() => seq === tts.seq && ttsEvent("done", c.id))
      .catch((e) => {
        logError("read aloud", e);
        ttsEvent("error", c.id);
      });
  }
}

/// Keep a few chunks queued ahead (one at a time for spd).
function ttsFill(flush = false) {
  if (!tts.on || tts.paused) return;
  // Well ahead on a phone: with the screen off the app may not hear
  // about each paragraph ending until it is woken.
  const ahead = tts.engine === "spd" ? 1 : tts.engine === "android" ? 12 : 4;
  let first = flush;
  while (tts.queued < tts.chunks.length && tts.queued < tts.pos + ahead) {
    ttsSpeakChunk(tts.chunks[tts.queued], first);
    first = false;
    tts.queued += 1;
  }
}

function ttsEvent(kind, id) {
  if (!tts.on) return;
  const [seq, n] = String(id).split(":").map(Number);
  if (seq !== tts.seq) return;
  if (kind === "start") {
    tts.pos = n;
    ttsMark(tts.chunks[n]);
    return;
  }
  if (kind === "cancel") return;
  if (kind === "error") {
    // Skip what could not be said rather than stopping.
  }
  if (n !== tts.pos && kind !== "error") tts.pos = n;
  tts.pos = n + 1;
  if (tts.sleepUntil && Date.now() >= tts.sleepUntil) return ttsStop("Sleep timer: stopped reading.");
  if (tts.pos >= tts.chunks.length) {
    if (tts.sleepChapter) return ttsStop("End of the chapter: stopped reading.");
    return ttsNextSection();
  }
  ttsFill();
}

async function ttsNextSection() {
  const r = notes.rendition;
  const next = notes.epub?.spine?.get(tts.sectionIndex + 1);
  if (!r || !next) return ttsStop("Finished reading the book.");
  tts.seq += 1;
  try {
    await r.display(next.href);
  } catch {
    return ttsStop("Could not go on to the next chapter.");
  }
  if (!ttsLoadSection(true)) return ttsStop();
  ttsFill(true);
}

function ttsCancelEngine() {
  if (tts.engine === "android") window.FicShelfAndroid.ttsStop();
  else if (tts.engine === "web") speechSynthesis.cancel();
  else if (tts.engine === "spd") invoke("tts_stop").catch(() => {});
}

/// Start again from chunk `i` of the current list.
function ttsRestartAt(i) {
  tts.seq += 1;
  tts.chunks.forEach((c, k) => (c.id = `${tts.seq}:${k}`));
  ttsCancelEngine();
  tts.pos = Math.max(0, Math.min(i, tts.chunks.length - 1));
  tts.queued = tts.pos;
  ttsMark(tts.chunks[tts.pos]);
  setTimeout(() => ttsFill(true), tts.engine === "spd" ? 150 : 0);
}

async function ttsStart() {
  if (state.reader?.kind !== "epub" || !notes.rendition) {
    toast("Read aloud works in EPUB books.", true);
    return;
  }
  if (!tts.engine) tts.engine = await ttsPickEngine();
  if (!tts.engine) {
    toast(
      window.FicShelfAndroid
        ? "This phone has no text-to-speech voice. Install one (Speech Services by Google) from the Play Store."
        : "No voice found. On Linux, install speech-dispatcher (spd-say); on Windows, add a voice in Settings → Time & language → Speech.",
      true,
      false,
    );
    return;
  }
  tts.on = true;
  tts.paused = false;
  tts.seq += 1;
  if (!ttsLoadSection(false)) {
    tts.on = false;
    toast("Nothing to read on this page.", true);
    return;
  }
  $("#tts-bar").hidden = false;
  $("#view-reader").classList.remove("show-chrome");
  ttsBarSync();
  ttsFill(true);
}

function ttsStop(message) {
  if (!tts.on) return;
  tts.on = false;
  tts.seq += 1;
  ttsCancelEngine();
  ttsMark({ el: null });
  for (const c of tts.chunks) c.el?.classList?.remove("ficshelf-tts");
  tts.chunks = [];
  tts.sleepUntil = 0;
  tts.sleepChapter = false;
  setPref("ttsSleep", "0");
  $("#tts-bar").hidden = true;
  if (message) toast(message);
}

function ttsPause() {
  if (!tts.on) return;
  if (tts.paused) {
    tts.paused = false;
    ttsRestartAt(tts.pos);
  } else {
    tts.paused = true;
    tts.seq += 1;
    ttsCancelEngine();
  }
  ttsBarSync();
}

function ttsBarSync() {
  $("#tts-play").textContent = tts.paused ? "▶" : "⏸";
  $("#tts-speed").textContent = `${ttsRate()}×`;
  const left = tts.sleepUntil ? Math.max(0, Math.ceil((tts.sleepUntil - Date.now()) / 60000)) : 0;
  $("#tts-sleep").textContent = tts.sleepChapter ? "⏾ Chapter" : left ? `⏾ ${left} min` : "⏾ Off";
}
setInterval(() => tts.on && tts.sleepUntil && ttsBarSync(), 30000);

$("#reader-tts").addEventListener("click", () => {
  $("#more-sheet").close();
  tts.on ? ttsStop() : ttsStart();
});
$("#tts-close").addEventListener("click", () => ttsStop());
$("#tts-play").addEventListener("click", ttsPause);
$("#tts-back").addEventListener("click", () => {
  if (!tts.on) return;
  // Back to the start of the previous paragraph (not just sentence).
  let i = tts.pos;
  const el = tts.chunks[i]?.el;
  while (i > 0 && tts.chunks[i - 1].el === el) i--;
  if (i > 0) {
    const prevEl = tts.chunks[i - 1].el;
    i -= 1;
    while (i > 0 && tts.chunks[i - 1].el === prevEl) i--;
  }
  tts.paused = false;
  ttsRestartAt(i);
  ttsBarSync();
});
$("#tts-fwd").addEventListener("click", () => {
  if (!tts.on) return;
  let i = tts.pos;
  const el = tts.chunks[i]?.el;
  while (i < tts.chunks.length && tts.chunks[i].el === el) i++;
  tts.paused = false;
  if (i >= tts.chunks.length) {
    ttsNextSection();
  } else ttsRestartAt(i);
  ttsBarSync();
});
$("#tts-speed").addEventListener("click", () => {
  const i = TTS_SPEEDS.indexOf(ttsRate());
  setPref("ttsRate", String(TTS_SPEEDS[(i + 1) % TTS_SPEEDS.length]));
  ttsBarSync();
  if (tts.on && !tts.paused) ttsRestartAt(tts.pos);
});
$("#tts-sleep").addEventListener("click", () => {
  const cur = tts.sleepChapter ? -1 : Number(pref("ttsSleep", "0"));
  const next = TTS_SLEEP[(TTS_SLEEP.indexOf(cur) + 1) % TTS_SLEEP.length];
  setPref("ttsSleep", String(next));
  tts.sleepChapter = next === -1;
  tts.sleepUntil = next > 0 ? Date.now() + next * 60000 : 0;
  ttsBarSync();
});
$("#tts-voice-btn").addEventListener("click", () => {
  const list = $("#tts-voices");
  list.textContent = "";
  let voices = [];
  if (tts.engine === "android") {
    try {
      voices = JSON.parse(window.FicShelfAndroid.ttsVoices() || "[]");
    } catch {
      voices = [];
    }
  } else if (tts.engine === "web") {
    voices = speechSynthesis.getVoices().map((v) => ({ id: v.voiceURI, name: `${v.name} (${v.lang})` }));
  }
  const cur = pref("ttsVoice", "");
  for (const v of [{ id: "", name: "System default" }, ...voices]) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = v.name;
    b.classList.toggle("active", v.id === cur);
    b.addEventListener("click", () => {
      setPref("ttsVoice", v.id);
      $("#tts-voice-sheet").close();
      if (tts.on && !tts.paused) ttsRestartAt(tts.pos);
    });
    li.appendChild(b);
    list.appendChild(li);
  }
  $("#tts-voice-note").hidden = tts.engine === "spd" ? false : voices.length > 0;
  if (tts.engine === "spd") {
    const li = document.createElement("li");
    li.className = "muted small";
    li.textContent = "Voices come from speech-dispatcher's settings (spd-conf).";
    list.appendChild(li);
  }
  $("#tts-voice-sheet").showModal();
});
$("#tts-voice-done").addEventListener("click", () => $("#tts-voice-sheet").close());

// ------------------------------------------------------------ display
//
// Brightness (a dimming layer over the page), warmth and black-and-white
// (a filter on the page), for every kind of book.

function applyDisplay() {
  const bright = Number(pref("dispBright", "100"));
  const warm = Number(pref("dispWarm", "0"));
  const gray = pref("dispGray", "") === "1";
  $("#reader-dim").style.opacity = String(Math.max(0, Math.min(0.75, 1 - bright / 100)));
  const f = [];
  if (warm > 0) f.push(`sepia(${warm}%)`);
  if (gray) f.push("grayscale(1)");
  $("#reader-stage").style.filter = f.join(" ");
}
applyDisplay();

function speedLabel() {
  return `Speed ${pref("autoSpeed", "4")}`;
}

$("#reader-display").addEventListener("click", () => {
  $("#more-sheet").close();
  $("#disp-bright").value = pref("dispBright", "100");
  $("#disp-warm").value = pref("dispWarm", "0");
  $("#disp-gray").checked = pref("dispGray", "") === "1";
  $("#disp-crop").checked = pref("cropBorders", "") === "1";
  $("#disp-awake").checked = pref("keepAwake", "1") === "1";
  $("#disp-speed").value = pref("autoSpeed", "4");
  $("#disp-speed-label").textContent = speedLabel();
  $("#disp-auto").textContent = auto.on ? "Stop auto-scroll" : "Start auto-scroll";
  $("#display-sheet").showModal();
});
$("#disp-bright").addEventListener("input", (e) => {
  setPref("dispBright", e.target.value);
  applyDisplay();
});
$("#disp-warm").addEventListener("input", (e) => {
  setPref("dispWarm", e.target.value);
  applyDisplay();
});
$("#disp-gray").addEventListener("change", (e) => {
  setPref("dispGray", e.target.checked ? "1" : "");
  applyDisplay();
});
$("#disp-crop").addEventListener("change", (e) => {
  setPref("cropBorders", e.target.checked ? "1" : "");
  document.querySelectorAll("#cbz-zoom .pg, #cbz-strip img").forEach(applyCrop);
});
$("#disp-awake").addEventListener("change", (e) => {
  setPref("keepAwake", e.target.checked ? "1" : "");
  keepAwake(Boolean(state.reader) && e.target.checked);
});
$("#disp-speed").addEventListener("input", (e) => {
  setPref("autoSpeed", e.target.value);
  $("#disp-speed-label").textContent = speedLabel();
  if (auto.on) startAuto(false);
});
$("#disp-auto").addEventListener("click", () => {
  $("#display-sheet").close();
  if (auto.on) stopAuto();
  else startAuto(true);
});
$("#disp-done").addEventListener("click", () => $("#display-sheet").close());

// -- keep the screen on while a book is open
let wakeLock = null;
async function keepAwake(on) {
  const bridge = window.FicShelfAndroid;
  if (bridge?.keepScreenOn) {
    bridge.keepScreenOn(Boolean(on));
    return;
  }
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  // A wake lock is dropped when the app is hidden; take it again on return.
  if (document.visibilityState === "visible" && state.reader && pref("keepAwake", "1") === "1") {
    wakeLock = null;
    keepAwake(true);
  }
});

// -- auto-scroll: long strips glide, everything else turns pages by itself
const auto = { on: false, raf: 0, timer: 0 };
function startAuto(announce) {
  if (!state.reader) return;
  stopAuto();
  auto.on = true;
  const speed = Number(pref("autoSpeed", "4"));
  const r = state.reader;
  if (r.scrollBy) {
    let last = performance.now();
    let carry = 0;
    const step = (t) => {
      if (!auto.on) return;
      carry += ((t - last) / 1000) * speed * 28; // 28 to 280 pixels a second
      last = t;
      const whole = Math.floor(carry);
      if (whole) {
        carry -= whole;
        r.scrollBy(whole);
      }
      auto.raf = requestAnimationFrame(step);
    };
    auto.raf = requestAnimationFrame(step);
  } else {
    // Speed 1 turns every 30 seconds, 10 every 3.
    auto.timer = setInterval(() => state.reader?.next?.(), Math.round(30000 / speed));
  }
  if (announce) toast("Auto-scroll is on. Tap the page to stop.");
}
function stopAuto() {
  auto.on = false;
  cancelAnimationFrame(auto.raf);
  clearInterval(auto.timer);
}
$("#reader-stage").addEventListener("pointerdown", () => auto.on && stopAuto(), true);

// -- crop white borders on comic pages (object-view-box shows only the
// part with content; the image itself is untouched)
const cropCache = new Map();
function cropInset(img) {
  const key = `${img.src.length}:${img.src.slice(-80)}`;
  if (cropCache.has(key)) return cropCache.get(key);
  const W = 140;
  const H = Math.max(1, Math.round((W * img.naturalHeight) / Math.max(1, img.naturalWidth)));
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const ink = (x, y) => {
    const k = (y * W + x) * 4;
    return 0.3 * d[k] + 0.59 * d[k + 1] + 0.11 * d[k + 2] < 232;
  };
  const rowHas = (y) => {
    let n = 0;
    for (let x = 0; x < W; x++) if (ink(x, y)) n++;
    return n > W * 0.012;
  };
  const colHas = (x) => {
    let n = 0;
    for (let y = 0; y < H; y++) if (ink(x, y)) n++;
    return n > H * 0.012;
  };
  let top = 0, bottom = H - 1, left = 0, right = W - 1;
  while (top < H / 3 && !rowHas(top)) top++;
  while (bottom > (H * 2) / 3 && !rowHas(bottom)) bottom--;
  while (left < W / 3 && !colHas(left)) left++;
  while (right > (W * 2) / 3 && !colHas(right)) right--;
  const pct = (n, of) => Math.max(0, ((n - 1) / of) * 100).toFixed(2);
  const inset = `inset(${pct(top, H)}% ${pct(W - 1 - right, W)}% ${pct(H - 1 - bottom, H)}% ${pct(left, W)}%)`;
  cropCache.set(key, inset);
  if (cropCache.size > 400) cropCache.delete(cropCache.keys().next().value);
  return inset;
}
function applyCrop(img) {
  if (!img) return;
  if (pref("cropBorders", "") !== "1" || !img.src) {
    img.style.objectViewBox = "";
    return;
  }
  if (!img.complete || !img.naturalWidth) {
    img.addEventListener("load", () => applyCrop(img), { once: true });
    return;
  }
  try {
    img.style.objectViewBox = cropInset(img);
  } catch {
    img.style.objectViewBox = "";
  }
}

// ------------------------------------------------------ reading sessions
//
// Time with a book open and in use is added up for History and Statistics.
// It stops counting after a few idle minutes or with the app in the
// background, and not at all in incognito.

const IDLE_AFTER = 4 * 60 * 1000;
const reading = { book: null, since: 0, last: 0, counted: 0, pages: 0, started: 0, timer: null };

function startReading(book) {
  stopReading();
  if (incognito()) return;
  const now = Date.now();
  Object.assign(reading, { book, since: now, last: now, counted: 0, pages: 0, started: now });
  reading.timer = setInterval(() => readingTick(false), 30_000);
}

/// Called on every page turn (turned = true) and every half minute.
function readingTick(turned) {
  if (!reading.book) return;
  const now = Date.now();
  const away = document.visibilityState === "hidden";
  if (!away && now - reading.last < IDLE_AFTER) reading.counted += now - reading.since;
  reading.since = now;
  if (turned) {
    reading.pages += 1;
    reading.last = now;
  }
  if (reading.counted >= 120_000 || reading.pages >= 20) flushReading();
}

function flushReading() {
  if (!reading.book) return;
  const seconds = Math.round(reading.counted / 1000);
  const pages = reading.pages;
  if (seconds <= 0 && pages <= 0) return;
  const started = Math.round(reading.started / 1000);
  reading.counted = 0;
  reading.pages = 0;
  reading.started = Date.now();
  invoke("record_session", {
    bookId: reading.book.id,
    started,
    ended: Math.round(Date.now() / 1000),
    seconds,
    pages,
  }).catch(() => {});
}

function stopReading() {
  if (!reading.book) return;
  readingTick(false);
  flushReading();
  clearInterval(reading.timer);
  reading.book = null;
}

["pointerdown", "keydown", "wheel"].forEach((ev) =>
  document.addEventListener(ev, () => reading.book && (reading.last = Date.now()), { passive: true, capture: true }),
);
document.addEventListener("visibilitychange", () => {
  if (!reading.book) return;
  readingTick(false); // count up to now, then stop counting while away
  if (document.visibilityState === "hidden") flushReading();
  else reading.last = Date.now();
});

// ------------------------------------------------ AniList / MyAnimeList

const SERVICE_NAME = { anilist: "AniList", mal: "MyAnimeList" };
const tracking = { services: [], links: [] };

async function loadTracking() {
  try {
    const [services, links] = await invoke("trackers_status");
    tracking.services = services;
    tracking.links = links;
  } catch (e) {
    logError("tracking", e);
  }
  return tracking;
}

function renderTrackerAccounts() {
  const box = $("#tracker-accounts");
  box.textContent = "";
  for (const s of tracking.services) {
    const row = document.createElement("div");
    row.className = "server-row";
    const label = document.createElement("div");
    label.className = "server-open";
    const n = document.createElement("strong");
    n.textContent = SERVICE_NAME[s.service];
    const sub = document.createElement("span");
    sub.className = "muted small";
    sub.textContent = !s.available
      ? "Not set up in this build of FicShelf."
      : s.account
        ? `Signed in as ${s.account}`
        : "Not signed in";
    label.append(n, sub);
    row.appendChild(label);
    if (s.available) {
      const b = document.createElement("button");
      b.textContent = s.account ? "Sign out" : "Sign in";
      b.addEventListener("click", async () => {
        if (s.account) {
          await call("tracker_signout", { service: s.service });
          await loadTracking();
          renderTrackerAccounts();
        } else startSignin(s.service);
      });
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}

let signinService = null;
async function startSignin(service) {
  try {
    const url = await invoke("tracker_signin_url", { service });
    signinService = service;
    $("#signin-title").textContent = `Sign in to ${SERVICE_NAME[service]}`;
    $("#signin-help").textContent =
      service === "anilist"
        ? "Your browser is opening AniList. Approve FicShelf there, then copy the long token it shows and paste it below."
        : "Your browser is opening MyAnimeList. Approve FicShelf there; you will land on FicShelf's GitHub page. Copy that page's whole address from the address bar and paste it below.";
    $("#signin-paste").value = "";
    $("#signin-status").textContent = "";
    $("#signin-dialog").showModal();
    await invoke("open_link", { url });
  } catch (e) {
    toast(String(e), true);
  }
}
$("#signin-cancel").addEventListener("click", () => $("#signin-dialog").close());
$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#signin-status").textContent = "Signing in…";
  try {
    const name = await invoke("tracker_finish_signin", { service: signinService, pasted: $("#signin-paste").value });
    $("#signin-dialog").close();
    toast(`Signed in to ${SERVICE_NAME[signinService]} as ${name}.`);
    await loadTracking();
    renderTrackerAccounts();
  } catch (err) {
    $("#signin-status").textContent = String(err);
    logError("tracker sign-in", err);
  }
});

/// What the library says about a series: volumes finished, all finished,
/// average stars.
function seriesProgress(name) {
  const books = state.books.filter((b) => groupOf(b) === name);
  const finished = books.filter((b) => readStatus(b) === "finished");
  const rated = books.filter((b) => b.rating);
  return {
    volumes: finished.length,
    completed: books.length > 0 && finished.length === books.length,
    stars: rated.length ? rated.reduce((n, b) => n + b.rating, 0) / rated.length : null,
  };
}

let trackService = "anilist";
async function openTrackDialog() {
  const series = state.openSeries;
  if (!series) return;
  await loadTracking();
  const usable = tracking.services.filter((s) => s.available);
  if (!usable.length) {
    toast("Tracking is not set up in this build of FicShelf.", true);
    return;
  }
  if (!usable.some((s) => s.service === trackService)) trackService = usable[0].service;
  $("#track-series").textContent = series;
  $("#track-query").value = series.replace(/\s*\(.*?\)\s*/g, " ").trim();
  const tabs = $("#track-service");
  tabs.textContent = "";
  for (const s of usable) {
    const b = document.createElement("button");
    b.textContent = SERVICE_NAME[s.service];
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(s.service === trackService));
    b.addEventListener("click", () => {
      trackService = s.service;
      openTrackDialog();
    });
    tabs.appendChild(b);
  }
  renderTrackLinked();
  $("#track-results").textContent = "";
  $("#track-status").textContent = "";
  if (!$("#track-dialog").open) $("#track-dialog").showModal();
  searchTrack();
}

function renderTrackLinked() {
  const box = $("#track-linked");
  box.textContent = "";
  const service = tracking.services.find((s) => s.service === trackService);
  const link = tracking.links.find((l) => l.series === state.openSeries && l.service === trackService);
  if (!service?.account) {
    box.textContent = `Sign in to ${SERVICE_NAME[trackService]} in Settings to update your list. You can still link the series now.`;
  }
  if (link) {
    const p = document.createElement("p");
    p.textContent = `Linked to “${link.title}”${link.pushed_at ? `, last updated ${new Date(link.pushed_at * 1000).toLocaleDateString()}` : ""}.`;
    const now = document.createElement("button");
    now.textContent = "Update now";
    now.addEventListener("click", () => pushTracking(link.series, true));
    const un = document.createElement("button");
    un.textContent = "Unlink";
    un.addEventListener("click", async () => {
      await call("tracker_unlink", { series: link.series, service: link.service });
      await loadTracking();
      renderTrackLinked();
    });
    const row = document.createElement("div");
    row.className = "row";
    row.append(now, un);
    box.append(p, row);
  }
}

async function searchTrack() {
  const q = $("#track-query").value.trim();
  if (!q) return;
  $("#track-status").textContent = "Searching…";
  try {
    const found = await invoke("tracker_search", { service: trackService, query: q });
    $("#track-status").textContent = found.length ? "" : "Nothing found; try a shorter name.";
    const box = $("#track-results");
    box.textContent = "";
    for (const m of found) {
      const card = document.createElement("article");
      card.className = "lookup-card";
      if (m.cover) {
        const img = document.createElement("img");
        img.src = m.cover;
        img.alt = "";
        img.loading = "lazy";
        card.appendChild(img);
      } else {
        const d = document.createElement("div");
        d.className = "lookup-nocover";
        card.appendChild(d);
      }
      const info = document.createElement("div");
      const t = document.createElement("strong");
      t.textContent = m.title;
      const sub = document.createElement("div");
      sub.className = "muted small";
      sub.textContent = [m.kind, m.year, m.volumes ? `${m.volumes} volumes` : null].filter(Boolean).join(" · ");
      const link = document.createElement("button");
      link.className = "primary";
      link.textContent = "Link this";
      link.addEventListener("click", async () => {
        await call("tracker_link", {
          series: state.openSeries,
          service: trackService,
          mediaId: m.id,
          title: m.title,
          volumes: m.volumes ?? null,
        });
        await loadTracking();
        renderTrackLinked();
        // Nothing is sent yet, so her existing progress there is not
        // overwritten; the list is updated when she next finishes a volume
        // (or taps Update now).
        const all = pushedProgress();
        const p = seriesProgress(state.openSeries);
        all[state.openSeries] = `${p.volumes}|${p.completed}|${p.stars}`;
        setPref("trackPushed", JSON.stringify(all));
        toast(`Linked to ${m.title} on ${SERVICE_NAME[trackService]}.`);
      });
      info.append(t, sub, link);
      card.appendChild(info);
      box.appendChild(card);
    }
  } catch (e) {
    $("#track-status").textContent = String(e);
  }
}

$("#btn-series-track").addEventListener("click", openTrackDialog);
$("#track-search").addEventListener("submit", (e) => {
  e.preventDefault();
  searchTrack();
});
$("#track-close").addEventListener("click", () => $("#track-dialog").close());

/// Last progress sent per series, so lists are only updated on a change.
function pushedProgress() {
  try {
    return JSON.parse(pref("trackPushed", "{}")) || {};
  } catch {
    return {};
  }
}

async function pushTracking(series, loud = false) {
  const p = seriesProgress(series);
  try {
    const done = await invoke("tracker_push", { series, ...p });
    const all = pushedProgress();
    all[series] = `${p.volumes}|${p.completed}|${p.stars}`;
    setPref("trackPushed", JSON.stringify(all));
    if (done.length) {
      const names = done.map((s) => SERVICE_NAME[s]).join(" and ");
      if (loud || p.volumes) toast(`Updated ${series} on ${names}: ${p.volumes} read${p.completed ? ", completed" : ""}.`);
      await loadTracking();
      if ($("#track-dialog").open) renderTrackLinked();
    }
  } catch (e) {
    logError(`tracking (${series})`, e);
    if (loud) toast(`Could not update the list: ${e}`, true, false);
  }
}

let trackingTimer = 0;
/// After the library changes, update the lists for tracked series whose
/// progress moved (not in incognito mode).
function checkTracking() {
  clearTimeout(trackingTimer);
  trackingTimer = setTimeout(async () => {
    if (incognito()) return;
    await loadTracking();
    if (!tracking.links.length) return;
    const signedIn = new Set(tracking.services.filter((s) => s.account).map((s) => s.service));
    const pushed = pushedProgress();
    const series = new Set(tracking.links.filter((l) => signedIn.has(l.service)).map((l) => l.series));
    for (const name of series) {
      const p = seriesProgress(name);
      const key = `${p.volumes}|${p.completed}|${p.stars}`;
      if (pushed[name] === undefined) {
        // First look since linking was recorded elsewhere: remember, don't push.
        pushed[name] = key;
        setPref("trackPushed", JSON.stringify(pushed));
      } else if (pushed[name] !== key) {
        await pushTracking(name);
      }
    }
  }, 1500);
}

loadTracking().then(renderTrackerAccounts);

// -------------------------------------------------------- book servers

const opds = { server: null, stack: [], feed: null };

async function renderServers() {
  let list = [];
  try {
    list = await invoke("opds_servers");
  } catch (e) {
    logError("servers", e);
  }
  const box = $("#servers-list");
  box.textContent = "";
  if (!list.length) {
    box.innerHTML = "<p class='muted'>No servers yet.</p>";
    $("#server-add").open = true;
  }
  for (const srv of list) {
    const row = document.createElement("div");
    row.className = "server-row";
    const open = document.createElement("button");
    open.className = "server-open";
    const n = document.createElement("strong");
    n.textContent = srv.name;
    const u = document.createElement("span");
    u.className = "muted small";
    u.textContent = srv.url;
    open.append(n, u);
    open.addEventListener("click", () => browseServer(srv));
    const del = document.createElement("button");
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      if (!(await confirmAsk(`Remove the server “${srv.name}”? Books already downloaded stay in the library.`))) return;
      await call("opds_remove", { id: srv.id });
      renderServers();
    });
    row.append(open, del);
    box.appendChild(row);
  }
}

$("#server-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#srv-status").textContent = "Checking the server…";
  try {
    const srv = await invoke("opds_add", {
      name: $("#srv-name").value,
      url: $("#srv-url").value,
      username: $("#srv-user").value || null,
      password: $("#srv-pass").value || null,
    });
    $("#srv-status").textContent = "";
    for (const id of ["srv-name", "srv-url", "srv-user", "srv-pass"]) $(`#${id}`).value = "";
    $("#server-add").open = false;
    toast(`Added ${srv.name}.`);
    renderServers();
  } catch (err) {
    $("#srv-status").textContent = String(err);
    logError("add server", err);
  }
});

async function browseServer(srv) {
  opds.server = srv;
  opds.stack = [];
  $("#servers-home").hidden = true;
  $("#servers-browse").hidden = false;
  await loadFeed(null);
}

async function loadFeed(url, { query = null, append = false } = {}) {
  busy($("#opds-busy"), true);
  $("#opds-status").textContent = "";
  try {
    const feed = await invoke("opds_browse", {
      id: opds.server.id,
      url,
      search: query ? opds.feed?.search || null : null,
      query,
    });
    if (append && opds.feed) {
      opds.feed.entries.push(...feed.entries);
      opds.feed.next = feed.next;
    } else {
      if (opds.feed && !query) opds.stack.push(opds.feed);
      if (query && opds.feed) opds.stack.push(opds.feed);
      opds.feed = feed;
      // Search stays available inside a server even where a page lacks it.
      if (!feed.search && opds.stack.length) feed.search = opds.stack.find((f) => f.search)?.search || null;
    }
    renderFeed();
  } catch (e) {
    $("#opds-status").textContent = String(e);
    logError("browse server", e);
  } finally {
    busy($("#opds-busy"), false);
  }
}

function renderFeed() {
  const f = opds.feed;
  $("#opds-title").textContent = query_title(f);
  $("#opds-search").hidden = !f.search;
  $("#opds-more").hidden = !f.next;
  const box = $("#opds-entries");
  box.textContent = "";
  if (!f.entries.length) $("#opds-status").textContent = "Nothing here.";
  for (const e of f.entries) box.appendChild(opdsCard(e));
}

function query_title(f) {
  return f.title || opds.server?.name || "Server";
}

function opdsCard(e) {
  const el = document.createElement("article");
  el.className = "lookup-card";
  const art = document.createElement("div");
  art.className = "lookup-nocover";
  art.textContent = e.feed ? "📁" : "📘";
  el.appendChild(art);
  if (e.cover) {
    invoke("opds_image", { id: opds.server.id, url: e.cover })
      .then((src) => {
        if (!src) return;
        const img = document.createElement("img");
        img.src = src;
        img.alt = "";
        art.replaceWith(img);
      })
      .catch(() => {});
  }
  const info = document.createElement("div");
  const t = document.createElement("strong");
  t.textContent = e.title;
  info.appendChild(t);
  if (e.author) {
    const a = document.createElement("div");
    a.className = "muted small";
    a.textContent = e.author;
    info.appendChild(a);
  }
  if (e.summary) {
    const d = document.createElement("p");
    d.className = "small";
    d.textContent = e.summary.length > 200 ? `${e.summary.slice(0, 200)}…` : e.summary;
    info.appendChild(d);
  }
  const row = document.createElement("div");
  row.className = "row";
  if (e.feed) {
    const open = document.createElement("button");
    open.textContent = "Open";
    open.addEventListener("click", () => loadFeed(e.feed));
    row.appendChild(open);
    el.addEventListener("click", (ev) => ev.target === el && loadFeed(e.feed));
  }
  if (e.downloads.length) {
    const [href, kind] = e.downloads[0];
    const get = document.createElement("button");
    get.className = "primary";
    const fmt = (kind.match(/(epub|pdf|cbz|cbr|cb7|mobi|zip)/i) || [])[1] || "file";
    get.textContent = `Download ${fmt.toUpperCase()}`;
    get.addEventListener("click", async () => {
      get.disabled = true;
      get.textContent = "Downloading…";
      try {
        const book = await invoke("opds_download", { id: opds.server.id, url: href, title: e.title });
        get.textContent = "In your library ✓";
        refreshLibrary();
        toast(`Added “${book.title}” to your library.`);
      } catch (err) {
        get.disabled = false;
        get.textContent = `Download ${fmt.toUpperCase()}`;
        logError(`server download (${e.title})`, err);
        toast(`Could not download it: ${err}`, true, false);
      }
    });
    row.appendChild(get);
  }
  info.appendChild(row);
  el.appendChild(info);
  return el;
}

$("#opds-back").addEventListener("click", () => {
  const prev = opds.stack.pop();
  if (prev) {
    opds.feed = prev;
    $("#opds-status").textContent = "";
    renderFeed();
  } else {
    opds.feed = null;
    $("#servers-browse").hidden = true;
    $("#servers-home").hidden = false;
    renderServers();
  }
});
$("#opds-more").addEventListener("click", () => opds.feed?.next && loadFeed(opds.feed.next, { append: true }));
$("#opds-search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#opds-query").value.trim();
  if (q) loadFeed(null, { query: q });
});

// ------------------------------------------------------ history and stats

let histView = "history";
$$("[data-histview]").forEach((b) =>
  b.addEventListener("click", () => {
    histView = b.dataset.histview;
    $$("[data-histview]").forEach((x) => x.classList.toggle("active", x === b));
    renderHistoryView();
  }),
);

function renderHistoryView() {
  $("#history-pane").hidden = histView !== "history";
  $("#stats-pane").hidden = histView !== "stats";
  if (histView === "history") renderHistory();
  else renderStats();
}

function minutes(seconds) {
  if (seconds < 60) return seconds > 0 ? "under a minute" : "0 min";
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

function dayLabel(date) {
  const today = new Date();
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((d0 - d) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

async function renderHistory() {
  let entries = [];
  try {
    entries = await invoke("reading_history", { limit: 400 });
  } catch (e) {
    logError("history", e);
  }
  const box = $("#history-list");
  box.textContent = "";
  $("#history-empty").hidden = entries.length > 0;
  let lastDay = "";
  for (const h of entries) {
    const when = new Date(h.ended_at * 1000);
    const day = dayLabel(when);
    if (day !== lastDay) {
      const hd = document.createElement("h4");
      hd.textContent = day;
      box.appendChild(hd);
      lastDay = day;
    }
    const row = document.createElement("div");
    row.className = "history-row";
    const info = document.createElement("button");
    info.className = "history-open";
    const t = document.createElement("strong");
    t.textContent = h.title;
    const meta = document.createElement("span");
    meta.className = "muted small";
    meta.textContent = [
      when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hourCycle: pref("clock", "12") === "24" ? "h23" : "h12" }),
      minutes(h.seconds),
      h.pages ? `${h.pages} page${h.pages === 1 ? "" : "s"}` : "",
      h.present ? "" : "no longer in the library",
    ]
      .filter(Boolean)
      .join(" · ");
    info.append(t, meta);
    info.disabled = !h.present;
    info.addEventListener("click", async () => {
      const book = state.books.find((b) => b.id === h.book_id);
      if (!book) return;
      if (book.format === "audio") openPodfic(book);
      else openBook(book.id);
    });
    const del = document.createElement("button");
    del.className = "icon";
    del.textContent = "✕";
    del.title = "Remove from history";
    del.addEventListener("click", async () => {
      await call("forget_history", { entry: h.id });
      row.remove();
    });
    row.append(info, del);
    box.appendChild(row);
  }
}

$("#history-clear").addEventListener("click", async () => {
  if (!(await confirmAsk("Clear all of your reading history? Statistics start again from nothing too."))) return;
  await call("forget_history", { entry: null });
  renderHistoryView();
});

async function renderStats() {
  let data = { sessions: [], finished: [] };
  try {
    data = await invoke("reading_stats");
  } catch (e) {
    logError("statistics", e);
  }
  const now = new Date();
  const dayKey = (t) => {
    const d = new Date(t * 1000);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  const today0 = startOf(now);
  const week0 = today0 - ((now.getDay() + 6) % 7) * 86400; // Monday
  const year0 = new Date(now.getFullYear(), 0, 1).getTime() / 1000;
  let total = 0, today = 0, week = 0, pages = 0;
  const perDay = new Map();
  const perBook = new Map();
  for (const [ended, secs, pg, bookId, title] of data.sessions) {
    total += secs;
    pages += pg;
    if (ended >= today0) today += secs;
    if (ended >= week0) week += secs;
    perDay.set(dayKey(ended), (perDay.get(dayKey(ended)) || 0) + secs);
    const b = perBook.get(bookId) || { title, secs: 0 };
    b.secs += secs;
    b.title = title;
    perBook.set(bookId, b);
  }
  // Streaks: days in a row with at least a minute of reading.
  const readOn = (d) => (perDay.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`) || 0) >= 60;
  let streak = 0;
  const cursor = new Date(now);
  if (!readOn(cursor)) cursor.setDate(cursor.getDate() - 1); // today not started yet
  while (readOn(cursor)) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  let best = 0, run = 0;
  const days = [...perDay.entries()]
    .filter(([, secs]) => secs >= 60)
    .map(([k]) => {
      const [y, m, d] = k.split("-").map(Number);
      return new Date(y, m, d).getTime();
    })
    .sort((a, b) => a - b);
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && Math.round((days[i] - days[i - 1]) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const finishedYear = data.finished.filter((t) => t >= year0).length;

  const tiles = [
    ["Today", minutes(today)],
    ["This week", minutes(week)],
    ["All time", minutes(total)],
    ["Pages turned", pages.toLocaleString()],
    ["Finished this year", String(finishedYear)],
    ["Finished in all", String(data.finished.length)],
    ["Streak", `${streak} day${streak === 1 ? "" : "s"}`],
    ["Longest streak", `${best} day${best === 1 ? "" : "s"}`],
  ];
  const box = $("#stats-tiles");
  box.textContent = "";
  for (const [label, value] of tiles) {
    const t = document.createElement("div");
    t.className = "stat-tile";
    const v = document.createElement("strong");
    v.textContent = value;
    const l = document.createElement("span");
    l.textContent = label;
    t.append(v, l);
    box.appendChild(t);
  }

  // Bars for the last 30 days.
  const bars = $("#stats-days");
  bars.textContent = "";
  const vals = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    vals.push([d, perDay.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`) || 0]);
  }
  const max = Math.max(60, ...vals.map(([, v]) => v));
  for (const [d, v] of vals) {
    const bar = document.createElement("div");
    bar.className = "stat-bar";
    bar.style.height = `${Math.max(v ? 4 : 1, Math.round((v / max) * 100))}%`;
    bar.title = `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${minutes(v)}`;
    bars.appendChild(bar);
  }

  const top = $("#stats-top");
  top.textContent = "";
  [...perBook.values()]
    .sort((a, b) => b.secs - a.secs)
    .slice(0, 10)
    .forEach((b) => {
      const li = document.createElement("li");
      li.textContent = `${b.title} · ${minutes(b.secs)}`;
      top.appendChild(li);
    });
  if (!top.children.length) top.innerHTML = "<li class='muted'>Nothing yet.</li>";
}

// ------------------------------------------------------------- shelves

function pinnedShelves() {
  try {
    const v = JSON.parse(pref("shelves", "[]"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function renderShelfTabs() {
  const box = $("#shelf-tabs");
  box.textContent = "";
  for (const tag of pinnedShelves()) {
    const b = document.createElement("button");
    b.role = "tab";
    b.textContent = tag;
    b.classList.toggle("active", state.shelf === tag);
    b.addEventListener("click", () => {
      state.shelf = tag;
      state.libView = "all";
      state.openSeries = null;
      setPref("shelf", tag);
      $$(".tabs button[data-libview]").forEach((x) => x.classList.remove("active"));
      renderShelfTabs();
      renderShelf();
    });
    box.appendChild(b);
  }
}

$("#lib-shelves").addEventListener("click", async () => {
  $("#lib-menu").close();
  let tags = [];
  try {
    tags = await invoke("list_tags");
  } catch {
    /* none */
  }
  const pinned = new Set(pinnedShelves());
  const list = $("#shelves-list");
  list.textContent = "";
  if (!tags.length) list.innerHTML = "<p class='muted'>No tags yet. Add some under a book's Edit details first.</p>";
  for (const [tag, count] of tags) {
    const l = document.createElement("label");
    l.className = "check";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = pinned.has(tag);
    c.addEventListener("change", () => {
      const now = pinnedShelves().filter((t) => t !== tag);
      if (c.checked) now.push(tag);
      setPref("shelves", JSON.stringify(now));
      if (!c.checked && state.shelf === tag) state.shelf = null;
      renderShelfTabs();
      renderShelf();
    });
    l.append(c, ` ${tag} (${count})`);
    list.appendChild(l);
  }
  $("#shelves-dialog").showModal();
});
$("#shelves-done").addEventListener("click", () => $("#shelves-dialog").close());

// ------------------------------------------------------ continue reading

function renderContinue(visibleCount) {
  const row = $("#continue-row");
  // Only on the plain library: no filter, no shelf, not inside a series.
  const plain = !state.filter && !state.shelf && state.libView === "all" && !selection.on;
  const books = plain
    ? state.books
        .filter((b) => readStatus(b) === "reading" && b.last_opened_at && !b.missing && b.format !== "audio")
        .sort((a, b) => (b.last_opened_at || 0) - (a.last_opened_at || 0))
        .slice(0, 12)
    : [];
  row.hidden = books.length === 0 || visibleCount === 0;
  const list = $("#continue-list");
  list.textContent = "";
  for (const b of books) list.appendChild(bookCard(b));
}

// ------------------------------------------------------------ incognito

function incognito() {
  return pref("incognito", "") === "1";
}

function applyIncognito() {
  const on = incognito();
  $("#incognito-badge").hidden = !on;
  $("#lib-incognito").textContent = `Incognito mode: ${on ? "on" : "off"}`;
}
applyIncognito();
$("#lib-incognito").addEventListener("click", () => {
  $("#lib-menu").close();
  const on = !incognito();
  setPref("incognito", on ? "1" : "");
  if (on) stopReading();
  applyIncognito();
  toast(
    on
      ? "Incognito: what you read now is not kept in History or Statistics, and nothing syncs until you switch it off."
      : "Incognito is off. History, Statistics and sync are back on.",
  );
});

// ------------------------------------------------------------- touch
//
// Swipe left or right to turn the page; tap the outer thirds to do the same;
// tap the middle to hide or show the reader's toolbar.

/// What a tap at (fx, fy), as fractions of the page, should do, under the
/// tap-zone scheme chosen in Settings. `rtl` swaps left and right for manga.
function tapAction(fx, fy, rtl = false) {
  const inMiddle = fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7;
  const scheme = pref("tapZones", "sides");
  if (scheme === "custom") {
    const x = rtl ? 1 - fx : fx;
    const col = Math.min(2, Math.max(0, Math.floor(x * 3)));
    const row = Math.min(2, Math.max(0, Math.floor(fy * 3)));
    const act = tapMap()[row * 3 + col] || "none";
    // In a right-to-left comic "next" on the left means forward still.
    return act;
  }
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
      } else if (
        Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.5 &&
        !(state.reader.kind === "epub" && pref("flow", "pages") === "scroll")
      ) {
        runTapAction(pref(dy < 0 ? "swipeUp" : "swipeDown", "none"));
      } else if (quick && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        runTapAction(tapAction(pageX(t), pageY(t)));
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
/// Her own fonts: the list, and the selected one's data once loaded.
const userFonts = { list: [], data: new Map() };
const USER_FAMILY = "FicShelf Own Font";

function faceFamily(face) {
  if (face?.startsWith("user:")) return `"${USER_FAMILY}", serif`;
  return FACES[face] ?? "";
}

function userFontCss() {
  const face = pref("fontFace", "book");
  if (!face.startsWith("user:")) return "";
  const url = userFonts.data.get(face.slice(5));
  if (!url) {
    loadUserFont(face.slice(5));
    return "";
  }
  return `@font-face { font-family: "${USER_FAMILY}"; src: url("${url}"); font-display: swap; }
body, p, div, span, li, blockquote, h1, h2, h3, h4, h5, h6 { font-family: "${USER_FAMILY}", serif !important; }`;
}

async function loadUserFont(file) {
  if (userFonts.data.has(file) || userFonts.loading === file) return;
  userFonts.loading = file;
  try {
    userFonts.data.set(file, await invoke("font_data", { file }));
    readerRestyle?.();
  } catch (e) {
    logError("font", e);
  } finally {
    userFonts.loading = null;
  }
}

function textLayoutCss() {
  const css = [userFontCss()];
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
  const own = pref("customCss", "").trim();
  // Her CSS cannot close the style element or load anything from outside.
  if (own) css.push(own.replace(/<\/?style/gi, "").replace(/@import[^;]*;?/gi, ""));
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
  rendition.themes.font(faceFamily(pref("fontFace", "book")));
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
  const text = (notes.selection?.text || "").trim();
  clearSelection();
  if (text) openLookup(text);
});

/// The look-up pop-up: Wiktionary's meanings and Wikipedia's summary for a
/// word or a name, with Translate for longer passages.
let lookupText = "";
async function openLookup(text) {
  lookupText = text;
  const short = text.split(/\s+/).slice(0, 4).join(" ");
  const body = $("#lookup-body");
  $("#lookup-word").textContent = short.length < text.length ? `${short}…` : short;
  body.innerHTML = "<p class='muted'>Looking it up…</p>";
  $("#lookup-wikt").hidden = text.split(/\s+/).length > 4;
  if (!$("#lookup-sheet").open) $("#lookup-sheet").showModal();
  if (text.split(/\s+/).length > 4) {
    body.innerHTML = "<p class='muted'>That is more than a few words: use Translate, or select a single word or name to look it up.</p>";
    return;
  }
  let found;
  try {
    found = await invoke("define", { text: short });
  } catch (e) {
    body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = `Could not look it up: ${e}`;
    body.appendChild(p);
    return;
  }
  if (lookupText !== text) return;
  body.textContent = "";
  for (const m of found.meanings) {
    const h = document.createElement("p");
    h.className = "lookup-part";
    h.textContent = m.part;
    const ol = document.createElement("ol");
    for (const d of m.definitions) {
      const li = document.createElement("li");
      li.textContent = d;
      ol.appendChild(li);
    }
    body.append(h, ol);
  }
  if (found.wiki_extract) {
    const h = document.createElement("p");
    h.className = "lookup-part";
    h.textContent = `Wikipedia: ${found.wiki_title}`;
    const p = document.createElement("p");
    p.textContent = found.wiki_extract;
    body.append(h, p);
    if (found.wiki_url) {
      const a = document.createElement("button");
      a.textContent = "Read on Wikipedia";
      a.addEventListener("click", () => invoke("open_link", { url: found.wiki_url }).catch(() => {}));
      body.appendChild(a);
    }
  }
  if (!found.meanings.length && !found.wiki_extract) {
    body.innerHTML = "<p class='muted'>Nothing found. Names from a story usually aren't in a dictionary.</p>";
  }
  body.insertAdjacentHTML("beforeend", "<p class='muted small'>From Wiktionary and Wikipedia (CC BY-SA).</p>");
}
$("#lookup-done").addEventListener("click", () => $("#lookup-sheet").close());
$("#lookup-wikt").addEventListener("click", () =>
  call("look_up", { word: lookupText.split(/\s+/).slice(0, 4).join(" ") }).catch(() => {}),
);
$("#lookup-translate").addEventListener("click", () => {
  const lang = (navigator.language || "en").split("-")[0];
  const url = `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(lang)}&op=translate&text=${encodeURIComponent(lookupText.slice(0, 1500))}`;
  invoke("open_link", { url }).catch((e) => toast(String(e), true));
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

/// A book's highlights, notes and bookmarks as Markdown, in reading order,
/// grouped under their chapters.
function notesMarkdown(book, list) {
  const cmp = new ePub.CFI();
  const items = [...list].sort((a, b) => {
    const ka = notesOrderKey(a);
    const kb = notesOrderKey(b);
    if (ka != null && kb != null) return ka - kb;
    try {
      return cmp.compare(a.cfi, b.cfi);
    } catch {
      return a.created_at - b.created_at;
    }
  });
  const chapters = state.reader?.chapterList?.() || [];
  const chapterOf = (cfi) => {
    let label = "";
    for (const c of chapters) {
      try {
        if (cmp.compare(c.cfi, cfi) <= 0) label = c.label;
      } catch {
        /* skip */
      }
    }
    return label.trim();
  };
  const lines = [`# ${book.title}`, ""];
  if (book.author) lines.push(`*${book.author}*`, "");
  lines.push(`Highlights and notes exported from FicShelf on ${new Date().toLocaleDateString()}.`, "");
  let lastChapter = null;
  for (const a of items) {
    const page = a.cfi.startsWith("page:") ? `Page ${a.cfi.slice(5)}` : "";
    const ch = page ? "" : chapterOf(a.cfi);
    if (ch && ch !== lastChapter) {
      lines.push(`## ${ch}`, "");
      lastChapter = ch;
    }
    const when = new Date(a.created_at * 1000).toLocaleDateString();
    if (a.color === "bookmark") {
      lines.push(`- 🔖 Bookmark${page ? ` · ${page}` : ""} · ${when}${a.excerpt ? `: ${a.excerpt.replace(/\s+/g, " ").slice(0, 200)}` : ""}`, "");
      continue;
    }
    lines.push(...a.excerpt.trim().split(/\n+/).map((l) => `> ${l}`));
    lines.push("", `— ${[page, a.color, when].filter(Boolean).join(" · ")}`, "");
    if (a.note) lines.push(`**Note:** ${a.note.trim()}`, "");
  }
  return lines.join("\n");
}

$("#notes-export").addEventListener("click", async () => {
  const book = notes.book || state.reader?.book;
  if (!book) return;
  if (!notes.list.length) {
    toast("Nothing to export yet.");
    return;
  }
  try {
    const path = await invoke("save_export", { name: `${book.title} - notes`, content: notesMarkdown(book, notes.list) });
    const bridge = window.FicShelfAndroid;
    if (bridge?.openExternally) {
      // Lets her send it to Notes, Drive, email, Obsidian…
      if (!bridge.openExternally(path, "text/markdown")) toast(`Saved to ${path}`);
    } else {
      toast(`Saved to ${path}`);
      invoke("reveal_file", { path }).catch(() => {});
    }
  } catch (e) {
    logError("export notes", e);
    toast(`Could not export: ${e}`, true);
  }
});

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
  document.querySelectorAll("#font-face button, #font-user button").forEach((b) =>
    b.classList.toggle("active", b.dataset.face === face),
  );
  $("#font-css").value = pref("customCss", "");
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
  applyRuler();
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

async function renderUserFonts() {
  try {
    userFonts.list = await invoke("list_fonts");
  } catch {
    userFonts.list = [];
  }
  const box = $("#font-user");
  box.textContent = "";
  for (const f of userFonts.list) {
    const b = document.createElement("button");
    b.dataset.face = `user:${f.file}`;
    b.setAttribute("role", "radio");
    b.textContent = f.name;
    b.title = "Tap to use; press and hold to remove";
    b.addEventListener("click", () => {
      setPref("fontFace", b.dataset.face);
      loadUserFont(f.file);
      syncFontSheet();
      readerRestyle?.();
    });
    b.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      if (!(await confirmAsk(`Remove the font “${f.name}” from FicShelf?`))) return;
      await call("remove_font", { file: f.file });
      if (pref("fontFace", "book") === b.dataset.face) setPref("fontFace", "book");
      userFonts.data.delete(f.file);
      await renderUserFonts();
      readerRestyle?.();
    });
    box.appendChild(b);
  }
  // A font that was removed elsewhere falls back to the book's own.
  const face = pref("fontFace", "book");
  if (face.startsWith("user:") && !userFonts.list.some((f) => `user:${f.file}` === face)) setPref("fontFace", "book");
  syncFontSheet();
}
renderUserFonts();

$("#font-add").addEventListener("click", () => $("#font-file").click());
$("#font-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const f = await invoke("add_font", { name: file.name, data: btoa(bin) });
    setPref("fontFace", `user:${f.file}`);
    userFonts.data.delete(f.file);
    await renderUserFonts();
    await loadUserFont(f.file);
    toast(`Added ${f.name}.`);
  } catch (err) {
    toast(String(err), true);
  }
});

let cssTimer = 0;
$("#font-css").addEventListener("input", (e) => {
  clearTimeout(cssTimer);
  cssTimer = setTimeout(() => {
    setPref("customCss", e.target.value);
    readerRestyle?.();
  }, 400);
});

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
    contents.document?.addEventListener("click", (e) => footnoteClicked(e, contents), true);
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
        if (side.rendition) applyPageStyle(side.rendition);
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
    // With a second book open the main one has the left half of the screen.
    (t) => Math.min(1, (t.screenX / window.screen.width) * ($("#reader-stage").classList.contains("split") ? 2 : 1)),
    (t) => t.screenY / window.screen.height,
  );
  rendition.on("touchstart", (e) => turner.start(e));
  rendition.on("touchend", (e) => {
    // Lifting a finger after selecting text must not also turn the page.
    const sel = e.view?.getSelection?.();
    if (sel && !sel.isCollapsed) return;
    // A tap on a link (a footnote mark, a chapter link) is for the link.
    if (e.target?.closest?.("a[href]")) return;
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
    chapterList: () => chapters,
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
  setTimeout(() => {
    settingsGroupWanted = true;
    openSettingsGroup("reading");
    show("settings");
  }, 0);
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

  const textBox = $("#pdf-text");
  const reflow = () => pref("pdfReflow", "") === "1";

  const renderText = async (p) => {
    const content = await p.getTextContent();
    const paras = pdfParagraphs(content.items);
    textBox.textContent = "";
    const head = document.createElement("p");
    head.className = "pdf-text-page";
    head.textContent = `Page ${page} of ${doc.numPages}`;
    textBox.appendChild(head);
    if (!paras.length) {
      const none = document.createElement("p");
      none.className = "muted";
      none.textContent = "This page has no text to wrap (it may be a scanned picture). Switch Text view off in ⋮ to see it.";
      textBox.appendChild(none);
    }
    for (const para of paras) {
      const el = document.createElement(para.heading ? "h4" : "p");
      el.textContent = para.text;
      textBox.appendChild(el);
    }
    const lines = pref("lines", "book");
    textBox.style.setProperty("--pdf-lh", lines === "book" ? "1.6" : String(Number(lines) || 1.6));
    textBox.style.setProperty("--pdf-fs", `${(fontSize() / 100) * 1.05}rem`);
    textBox.style.setProperty("--pdf-ff", faceFamily(pref("fontFace", "book")) || "Georgia, serif");
    if (userFonts.data.size && pref("fontFace", "book").startsWith("user:")) {
      // The app's own page can use her font through a FontFace.
      const url = userFonts.data.get(pref("fontFace", "book").slice(5));
      if (url && !document.fonts.check(`12px "${USER_FAMILY}"`)) {
        try {
          const f = new FontFace(USER_FAMILY, `url(${url})`);
          document.fonts.add(await f.load());
        } catch {
          /* her font could not load; the fallback stands */
        }
      }
    }
    textBox.scrollTop = 0;
  };

  const render = async () => {
    const p = await doc.getPage(page);
    canvas.hidden = reflow();
    textBox.hidden = !reflow();
    if (reflow()) {
      await renderText(p);
      $("#reader-progress").textContent = `${page} / ${doc.numPages}`;
      showPageNumber(page, doc.numPages);
      saveWhere(book, page);
      return;
    }
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
      // In Text view a long page scrolls before the next one comes.
      if (reflow() && textBox.scrollTop + textBox.clientHeight < textBox.scrollHeight - 8) {
        textBox.scrollBy({ top: textBox.clientHeight * 0.9, behavior: "smooth" });
        return;
      }
      if (page < doc.numPages) {
        page += 1;
        render().then(() => playTurn(reflow() ? textBox : canvas, 1));
      }
    },
    prev: () => {
      if (reflow() && textBox.scrollTop > 8) {
        textBox.scrollBy({ top: -textBox.clientHeight * 0.9, behavior: "smooth" });
        return;
      }
      if (page > 1) {
        page -= 1;
        render().then(() => playTurn(reflow() ? textBox : canvas, -1));
      }
    },
    resize: () => render(),
    restyle: () => reflow() && render(),
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
    cleanup: () => {
      textBox.hidden = true;
      textBox.textContent = "";
      doc.destroy();
    },
  };
  readerRestyle = () => state.reader?.restyle?.();
}

/// A PDF page's text items, rejoined into paragraphs: lines are gathered by
/// their height on the page, a bigger gap or a change of size starts a new
/// paragraph, and words broken with a hyphen at a line's end are mended.
function pdfParagraphs(items) {
  const lines = [];
  for (const it of items) {
    if (!it.str && !it.hasEOL) continue;
    const y = it.transform[5];
    const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
    let line = lines[lines.length - 1];
    if (!line || Math.abs(line.y - y) > size * 0.5) {
      line = { y, size, text: "" };
      lines.push(line);
    }
    line.text += it.str;
    line.size = Math.max(line.size, size);
    if (it.hasEOL) line.eol = true;
  }
  const clean = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
  if (!clean.length) return [];
  const gaps = [];
  for (let i = 1; i < clean.length; i++) gaps.push(Math.abs(clean[i - 1].y - clean[i].y));
  const sorted = [...gaps].sort((a, b) => a - b);
  // The ordinary line spacing: low in the range, so that paragraph and
  // heading gaps do not pull it up on short pages.
  const usual = sorted[Math.floor(sorted.length * 0.3)] || clean[0].size * 1.2;
  const sizes = clean.map((l) => l.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 10;
  const out = [];
  let cur = null;
  clean.forEach((l, i) => {
    const gap = i ? Math.abs(clean[i - 1].y - l.y) : 0;
    const heading = l.size > body * 1.25;
    const fresh = !cur || gap > usual * 1.45 || heading !== cur.heading || (cur.heading && gap > usual);
    // Page numbers and running heads alone on a line are dropped.
    if (/^\d{1,4}$/.test(l.text) && (i === 0 || i === clean.length - 1)) return;
    if (fresh) {
      cur = { text: l.text, heading };
      out.push(cur);
    } else if (/[A-Za-z]-$/.test(cur.text) && /^[a-z]/.test(l.text)) {
      cur.text = cur.text.slice(0, -1) + l.text;
    } else {
      cur.text += ` ${l.text}`;
    }
  });
  return out;
}

$("#reader-reflow").addEventListener("click", () => {
  $("#more-sheet").close();
  setPref("pdfReflow", pref("pdfReflow", "") === "1" ? "" : "1");
  state.reader?.goTo?.(state.reader.current());
});
$("#reader-more").addEventListener("click", () => {
  const pdf = state.reader?.kind === "pdf";
  $("#reader-reflow").hidden = !pdf;
  $("#reader-reflow").textContent =
    pref("pdfReflow", "") === "1" ? "📄  Page view: the PDF as printed" : "📄  Text view: words wrap to fit the screen";
  $("#reader-side").textContent = side.book ? "📖  Close the second book" : "📖  A second book beside this one";
  $("#reader-tts").textContent = tts.on ? "🔊  Stop reading aloud" : "🔊  Read aloud";
  $("#reader-tts").hidden = state.reader?.kind !== "epub";
});

// ----------------------------------------------------------------- comics
//
// One page, or two side by side when the screen is wide; right to left for
// manga; pinch, double-tap and drag to zoom and pan. Pages are fetched ahead
// so turning is instant.

const COMIC_LAYOUTS = ["auto", "single", "double"];

function comicDirection(book, hint) {
  return pref(`dir.${book.id}`, hint ? "rtl" : "ltr");
}

/// Pages or one long strip, per comic. Not chosen yet: a comic whose first
/// pages are much taller than wide (a webtoon) starts as a strip.
async function comicMode(book, pages) {
  const chosen = pref(`mode.${book.id}`, "");
  if (chosen === "strip" || chosen === "pages") return chosen;
  try {
    const probe = pages.slice(0, 3);
    const sizes = await Promise.all(
      probe.map(
        async (name) =>
          new Promise(async (res) => {
            const im = new Image();
            im.onload = () => res(im.naturalHeight / Math.max(1, im.naturalWidth));
            im.onerror = () => res(1.4);
            im.src = await invoke("cbz_page", { id: book.id, name });
          }),
      ),
    );
    return sizes.filter((r) => r > 2.2).length >= Math.min(2, sizes.length) ? "strip" : "pages";
  } catch {
    return "pages";
  }
}

/// A comic as one long strip, top to bottom, the way webtoons are read.
/// Pages load as they come near and are let go again far away, so a
/// 300-page strip stays light.
async function openStrip(book, pages) {
  const strip = $("#cbz-strip");
  strip.hidden = false;
  strip.textContent = "";
  $("#view-reader").classList.add("kind-cbz", "kind-strip");
  let current = Math.min(Math.max(parseInt(book.position || "0", 10) || 0, 0), pages.length - 1);
  const slots = pages.map((_, i) => {
    const d = document.createElement("div");
    d.className = "strip-page";
    d.dataset.i = String(i);
    strip.appendChild(d);
    return d;
  });
  const loaded = new Map();
  let alive = true;

  const load = async (i) => {
    if (!alive || loaded.has(i) || i < 0 || i >= pages.length) return;
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    loaded.set(i, img);
    try {
      img.src = await invoke("cbz_page", { id: book.id, name: pages[i] });
      await img.decode().catch(() => {});
      if (!alive || loaded.get(i) !== img) return;
      slots[i].style.height = "";
      slots[i].classList.add("ready");
      slots[i].appendChild(img);
      applyCrop(img);
    } catch {
      loaded.delete(i);
    }
  };
  const unload = (i) => {
    const img = loaded.get(i);
    if (!img) return;
    // Keep its height so nothing below jumps.
    slots[i].style.height = `${slots[i].getBoundingClientRect().height}px`;
    img.remove();
    img.src = "";
    loaded.delete(i);
  };
  const tidy = () => {
    for (const i of [...loaded.keys()]) if (Math.abs(i - current) > 14) unload(i);
  };

  const near = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) load(Number(e.target.dataset.i));
    },
    { root: strip, rootMargin: "200% 0px" },
  );
  slots.forEach((s) => near.observe(s));

  const label = () => `${current + 1} / ${pages.length}`;
  let saveTimer = 0;
  const whereNow = () => {
    // The page at a third of the way down the screen is "the" page.
    const mark = strip.scrollTop + strip.clientHeight / 3;
    let lo = 0;
    let hi = slots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slots[mid].offsetTop <= mark) lo = mid;
      else hi = mid - 1;
    }
    if (lo !== current) {
      current = lo;
      $("#reader-progress").textContent = label();
      showPageNumber(current + 1, pages.length, label());
      tidy();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveWhere(book, current), 700);
    }
  };
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      whereNow();
    });
  };
  strip.addEventListener("scroll", onScroll, { passive: true });

  // Taps: the middle shows the toolbar; above or below scrolls by most of a
  // screen.
  let down = null;
  const onDown = (e) => (down = { x: e.clientX, y: e.clientY, at: Date.now() });
  const onUp = (e) => {
    const d = down;
    down = null;
    if (!d || Date.now() - d.at > 350 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
    const r = strip.getBoundingClientRect();
    const fy = (e.clientY - r.top) / r.height;
    if (fy > 0.3 && fy < 0.7) $("#view-reader").classList.toggle("show-chrome");
    else page(fy >= 0.7 ? 1 : -1);
  };
  strip.addEventListener("pointerdown", onDown);
  strip.addEventListener("pointerup", onUp);

  const page = (dir) => strip.scrollBy({ top: dir * strip.clientHeight * 0.85, behavior: "smooth" });
  const goTo = async (n) => {
    current = Math.min(Math.max(Math.round(n) - 1, 0), pages.length - 1);
    await load(current);
    slots[current].scrollIntoView({ block: "start" });
    whereNow();
  };

  state.reader = {
    book,
    kind: "cbz",
    strip: true,
    rtl: false,
    next: () => page(1),
    prev: () => page(-1),
    scrollBy: (px) => strip.scrollBy(0, px),
    total: () => pages.length,
    current: () => current + 1,
    mark: () => current + 1,
    restore: (n) => goTo(n),
    goTo,
    setDirection: () => {},
    relayout: () => {},
    cleanup: () => {
      alive = false;
      near.disconnect();
      clearTimeout(saveTimer);
      strip.removeEventListener("scroll", onScroll);
      strip.removeEventListener("pointerdown", onDown);
      strip.removeEventListener("pointerup", onUp);
      for (const i of [...loaded.keys()]) unload(i);
      strip.textContent = "";
      strip.hidden = true;
      $("#view-reader").classList.remove("kind-strip");
    },
  };
  $("#reader-progress").textContent = label();
  showPageNumber(current + 1, pages.length, label());
  await goTo(current + 1);
}

async function openCbz(book, pages, rtlHint) {
  if (!pages.length) throw new Error("no images in this archive");
  if ((await comicMode(book, pages)) === "strip") return openStrip(book, pages);
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
    applyCrop(imgA);
    if (!imgB.hidden) applyCrop(imgB);
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
      if (act === "next") next();
      else if (act === "prev") prev();
      else runTapAction(act);
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
  const mode = state.reader?.strip ? "strip" : "pages";
  document.querySelectorAll("#comic-mode button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
    b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  });
  const layout = pref("comicLayout", "auto");
  document.querySelectorAll("#comic-mode button").forEach((b) =>
  b.addEventListener("click", async () => {
    const r = state.reader;
    if (!r || r.kind !== "cbz") return;
    const want = b.dataset.mode;
    if ((want === "strip") === Boolean(r.strip)) return;
    setPref(`mode.${r.book.id}`, want);
    $("#comic-sheet").close();
    // Reopen at the same page in the other mode.
    const id = r.book.id;
    const at = r.current() - 1;
    closeReader();
    await invoke("save_position", { id, position: String(at) }).catch(() => {});
    await openBook(id);
  }),
);
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
    $("#ao3-status").textContent = `${searchState.count} works. Loading more failed — see Settings → About and help.`;
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
    $("#ao3-status").textContent = "That didn't work — the reason is in Settings → About and help.";
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

const syncUi = { status: null, running: false, lastError: "", timer: null, retry: false };

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
  if (incognito()) {
    if (!quiet) toast("Incognito is on, so nothing syncs. Switch it off in the Library ⋯ menu.");
    return;
  }
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
    const msg = typeof e === "string" ? e : e?.message || String(e);
    // No network for the moment (often: the phone cuts off apps going into
    // the background). Not a failure worth logging; try again on return.
    const offline = /dns error|failed to lookup|\(Connect\)|connection (refused|reset)|network is unreachable|timed out/i.test(msg);
    if (quiet && offline) {
      syncUi.retry = true;
      return;
    }
    syncUi.lastError = offline ? "no internet connection right now." : msg;
    logError(quiet ? "sync (automatic)" : "sync", e);
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
    if (!/cancelled/i.test(msg)) {
      logError("sync sign-in", msg);
      toast(msg, true);
    }
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
  else if (syncUi.retry) {
    syncUi.retry = false;
    syncSoon(1500);
  } else if (!$("#sync-signin").hidden) invoke("sync_nudge").catch(() => {});
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

// ---------------------------------------------------- about and updates

const DAY_MS = 24 * 60 * 60 * 1000;

async function checkForNewVersion({ quiet }) {
  setPref("updateCheckedAt", String(Date.now()));
  let u;
  try {
    u = await invoke("check_app_update");
  } catch (e) {
    if (!quiet) $("#about-status").textContent = `Could not check: ${e}`;
    return;
  }
  if (!u.newer) {
    if (!quiet) $("#about-status").textContent = `You have the newest version (${u.current}).`;
    return;
  }
  if (!quiet) $("#about-status").textContent = `FicShelf ${u.latest} is available.`;
  // "Later" on this version keeps it quiet until the next one.
  if (quiet && pref("updateDismissed", "") === u.latest) return;
  $("#app-update-text").textContent = `FicShelf ${u.latest} is available (you have ${u.current}).`;
  $("#app-update").dataset.version = u.latest;
  $("#app-update").dataset.download = u.download || u.page;
  $("#app-update").dataset.page = u.page;
  $("#app-update").hidden = false;
}

$("#app-update-get").addEventListener("click", () => {
  invoke("open_link", { url: $("#app-update").dataset.download }).catch((e) => toast(String(e), true));
  if (IS_ANDROID) toast("When the download finishes, open it and tap Update. Your library stays as it is.");
});
$("#app-update-notes").addEventListener("click", () =>
  invoke("open_link", { url: $("#app-update").dataset.page }).catch((e) => toast(String(e), true)),
);
$("#app-update-later").addEventListener("click", () => {
  setPref("updateDismissed", $("#app-update").dataset.version || "");
  $("#app-update").hidden = true;
});

$("#auto-update-check").checked = pref("updateCheck", "on") !== "off";
$("#auto-update-check").addEventListener("change", (e) => setPref("updateCheck", e.target.checked ? "on" : "off"));
$("#btn-check-app").addEventListener("click", () => {
  $("#about-status").textContent = "Checking…";
  checkForNewVersion({ quiet: false });
});
$("#btn-whats-new").addEventListener("click", () => {
  const v = appVersion ? `/tag/v${appVersion}` : "";
  invoke("open_link", { url: `https://github.com/mrichman45/ficshelf/releases${v}` }).catch((e) =>
    toast(String(e), true),
  );
});
$("#btn-privacy").addEventListener("click", () =>
  invoke("open_link", { url: "https://github.com/mrichman45/ficshelf/blob/main/PRIVACY.md" }).catch((e) =>
    toast(String(e), true),
  ),
);
getVersion()
  .then((v) => ($("#about-version").textContent = v))
  .catch(() => {});

// Once a day at most, a little after starting.
setTimeout(() => {
  if (pref("updateCheck", "on") === "off") return;
  if (Date.now() - Number(pref("updateCheckedAt", "0")) < DAY_MS) return;
  checkForNewVersion({ quiet: true });
}, 30_000);

// Report a problem: the email app opens with everything filled in; she
// reads it and presses Send herself.
let reportAddress = false;
invoke("report_available")
  .then((ok) => (reportAddress = ok))
  .catch(() => {});

function problemReport() {
  const list = readLog().slice(0, 15);
  const platform = IS_ANDROID ? "Android" : navigator.userAgent.includes("Windows") ? "Windows" : "Linux";
  const head = `FicShelf ${appVersion || "?"} on ${platform}\n${new Date().toString()}\n\nWhat happened (in your own words):\n\n\n`;
  const log = list.length ? `Error log (newest first):\n\n${list.map(logLine).join("\n\n")}` : "Error log: empty.";
  return head + log;
}

$("#btn-report").addEventListener("click", async () => {
  const body = problemReport();
  if (reportAddress) {
    try {
      await invoke("report_problem", { subject: `FicShelf problem report (${appVersion || "?"})`, body });
      return;
    } catch (e) {
      logError("report a problem", e);
    }
  }
  // No address in this build, or no email app: copy it instead.
  try {
    await navigator.clipboard.writeText(body);
    toast("The report is copied. Paste it into a message to whoever set FicShelf up for you.");
  } catch {
    toast("Use Copy log under Error log, and send it to whoever set FicShelf up for you.", true);
  }
});

// ------------------------------------------------------- accessibility
//
// Buttons that show only a symbol (☰ 🔖 ⋮ ▶) carry a title; screen readers
// on phones read aria-label instead, so the label follows the title, for
// buttons made later and for titles that change (▶ becoming ⏸).
function labelFromTitle(el) {
  if (el instanceof HTMLButtonElement && el.title && el.getAttribute("aria-label") !== el.title) {
    el.setAttribute("aria-label", el.title);
  }
}
document.querySelectorAll("button[title]").forEach(labelFromTitle);
new MutationObserver((changes) => {
  for (const c of changes) {
    if (c.type === "attributes") labelFromTitle(c.target);
    else c.addedNodes.forEach((n) => n instanceof Element && n.querySelectorAll?.("button[title]").forEach(labelFromTitle));
    if (c.type === "childList") c.addedNodes.forEach((n) => labelFromTitle(n));
  }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });

// ------------------------------------------------------------- welcome

const welcome = { step: 0 };

function showWelcomeStep(i) {
  welcome.step = i;
  $$("#welcome .welcome-step").forEach((el) => (el.hidden = Number(el.dataset.step) !== i));
  $$("#welcome .welcome-dots span").forEach((d, n) => d.classList.toggle("on", n === i));
  $("#welcome-next").textContent = i === 2 ? "Start reading" : "Next";
  $("#welcome-skip").hidden = i === 2;
}

function openWelcome() {
  showWelcomeStep(0);
  $("#welcome").hidden = false;
  $("#welcome-next").focus();
}

function closeWelcome() {
  $("#welcome").hidden = true;
  setPref("welcomed", "1");
}

$("#welcome-next").addEventListener("click", () => (welcome.step < 2 ? showWelcomeStep(welcome.step + 1) : closeWelcome()));
$("#welcome-skip").addEventListener("click", closeWelcome);
$("#btn-welcome-again").addEventListener("click", openWelcome);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#welcome").hidden) closeWelcome();
});

// A fresh install (nothing in the library, never welcomed) gets it once.
// Someone updating with books already in place does not.
setTimeout(async () => {
  if (pref("welcomed", "") === "1") return;
  try {
    const books = await invoke("list_books", { sort: "added" });
    if (Array.isArray(books) && books.length === 0) openWelcome();
    else setPref("welcomed", "1");
  } catch {
    /* try again next start */
  }
}, 400);

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
// ----------------------------------------------------------- footnotes
//
// Tapping a note mark (¹, [3], *) shows the note in a pop-up instead of
// jumping away to it; "Go to note" still jumps.

const NOTE_MARK = /^\s*[\[(]?\s*(\d{1,4}|[ivxlc]{1,6}|[a-z]|[*†‡§¶#]+)\s*[\])]?\s*$/i;

function isNoteLink(a) {
  const type = `${a.getAttribute("epub:type") || ""} ${a.getAttributeNS?.("http://www.idpf.org/2007/ops", "type") || ""} ${a.getAttribute("role") || ""}`;
  if (/noteref|doc-noteref/.test(type)) return true;
  const href = a.getAttribute("href") || "";
  if (!href.includes("#") || /^[a-z]+:/i.test(href)) return false;
  return NOTE_MARK.test(a.textContent || "") && (a.closest("sup") || /^\s*[\[(]?\s*[\d*†‡]/.test(a.textContent || ""));
}

/// The note an id points at: its aside, list item or paragraph, without the
/// back-link.
function noteText(target) {
  if (!target) return "";
  const box =
    target.closest?.("aside, [epub\\:type~='footnote'], [epub\\:type~='endnote'], [role='doc-footnote'], [role='doc-endnote'], li, dd") ||
    (target.matches?.("p, div, section") ? target : target.closest?.("p, div")) ||
    target;
  const clone = box.cloneNode(true);
  for (const back of clone.querySelectorAll("a[href*='#']")) {
    if (NOTE_MARK.test(back.textContent || "") || /back|return|↩|↑/i.test(back.textContent || "")) back.remove();
  }
  return (clone.innerText || clone.textContent || "").replace(/\s+\n/g, "\n").trim();
}

let footnoteTarget = null;
async function footnoteClicked(e, contents) {
  const a = e.target.closest?.("a[href]");
  if (!a || !isNoteLink(a)) return;
  e.preventDefault();
  e.stopPropagation();
  const href = a.getAttribute("href");
  const [file, frag] = href.split("#");
  let text = "";
  let target = null;
  try {
    const section = notes.epub.spine.get(contents.sectionIndex);
    let doc = contents.document;
    let fullHref = section.href;
    if (file) {
      fullHref = new URL(file, `https://book.invalid/${section.href}`).pathname.slice(1);
      const other = notes.epub.spine.get(fullHref);
      if (other && other.index !== section.index) {
        await other.load(notes.epub.load.bind(notes.epub));
        doc = other.document;
      }
    }
    target = doc?.getElementById(frag) || doc?.querySelector(`[name="${CSS.escape(frag)}"]`);
    text = noteText(target);
    footnoteTarget = `${fullHref}#${frag}`;
  } catch {
    footnoteTarget = null;
  }
  if (!text) {
    // Not found as a note after all: follow the link as usual.
    if (footnoteTarget) notes.rendition.display(footnoteTarget);
    return;
  }
  $("#footnote-text").textContent = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  $("#footnote-sheet").showModal();
}
$("#footnote-done").addEventListener("click", () => $("#footnote-sheet").close());
$("#footnote-go").addEventListener("click", () => {
  $("#footnote-sheet").close();
  if (footnoteTarget) notes.rendition?.display(footnoteTarget);
});

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
  renderShelfTabs();
  await refreshLibrary();
  await refreshSavedSearches();
  await refreshSettings();
  renderUpdates(await call("list_updates"));
  // Pick up what was read on other devices.
  await refreshSyncStatus();
  runSync(true);
})().catch((e) => toast(`Could not start: ${e}`, true));
