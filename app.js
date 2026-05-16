/* Life Tracker — stacked rows view.
   Each day is a row, 24 columns are hours, years are grouped.
   Storage: IndexedDB (seeded once from data/seed.json), with optional
   Supabase cloud sync (see sync.js) for cross-device. */

// Bump on each user-visible release. Stamped into the topbar so a refresh
// can be verified at a glance after a Pages rebuild.
const APP_VERSION = "1.1.6";

// "Four Thousand Weeks" (Burkeman) — a life is ~4000 weeks. Used to render
// the slim progress bar under the topbar.
const DOB = "1992-02-21";
const LIFE_TOTAL_WEEKS = 4000;
const LIFE_PHASES = {
  childhoodEndAge: 21,    // 0–21: childhood through university
  retirementStartAge: 67, // 67+: retirement
};
const LIFE_PHASE_COLORS = {
  childhood:  "rgba(192, 154, 53, 0.22)",  // warm amber
  adult:      "rgba(255, 255, 255, 0.06)", // neutral
  retirement: "rgba(176,  72, 160, 0.22)", // plum
};

import {
  cloudConfigured, getSession, onAuthChange,
  signInWithProvider, signOut,
  pullDays, pushDay, pushDays,
} from "./sync.js";

// Unified palette — same hue family as the original xlsx, but consistent
// saturation/lightness so the cells read as a set. Overrides any color
// imported from the xlsx (the xlsx colors are still preserved in the DB
// under colorsByYear if we ever want them back).
const PALETTE = {
  1:  "#5a6270",  // Sleep — cool gray
  2:  "#bf4eaf",  // Work — vivid mauve-purple
  3:  "#d97a1f",  // Hobby — vivid amber
  4:  "#6fa572",  // Sorting House — sage green
  5:  "#2fa2a3",  // Party / Clare — teal
  6:  "#6fab37",  // Social — apple green
  7:  "#4d70d0",  // Exercise — steel blue
  8:  "#cc4125",  // Foxo — crimson red
  9:  "#8b5d2a",  // Gaming — warm brown
  10: "#b048a0",  // Family Time — plum
  11: "#181b22",  // Travel — near-black
  12: "#4d9926",  // Cooking — forest
  13: "#c09a35",  // Waste Time — olive
  14: "#a55a8d",  // Holiday — mauve
  15: "#c0a05a",  // TV — sand
  16: "#4eaa7a",  // Health — jade
  17: "#c69020",  // Swedish — gold
  18: "#2f7ad5",  // Elin — clear blue
  19: "#535b56",
  20: "#535b56",
};
const colorFor = (id) => PALETTE[id] ?? "#666";

const ICONS = {
  1: "Zz",  // Sleep
};
const iconFor = (id) => ICONS[id] || null;

function adjustHex(hex, amount) {
  const m = String(hex || "").replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  const clamp = (c) => Math.max(0, Math.min(255, c + amount));
  return "#" + m.slice(1, 4)
    .map((x) => clamp(parseInt(x, 16)).toString(16).padStart(2, "0"))
    .join("");
}

function gradientFor(hex, dir = "135deg") {
  return `linear-gradient(${dir}, ${adjustHex(hex, 22)} 0%, ${hex} 55%, ${adjustHex(hex, -22)} 100%)`;
}

// pick black or white text based on background luminance
function textOn(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return "#fff";
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.45 ? "#111" : "#fff";
}

// ---------- IndexedDB ----------
const DB_NAME = "life-tracker";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("days"))
        db.createObjectStore("days", { keyPath: "date" });
      if (!db.objectStoreNames.contains("categories"))
        db.createObjectStore("categories", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta"))
        db.createObjectStore("meta", { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const reqP = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

function txDone(t) {
  return new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

async function bulkPut(db, store, items) {
  const t = db.transaction([store], "readwrite");
  const os = t.objectStore(store);
  for (const it of items) os.put(it);
  await txDone(t);
}

async function getMeta(db, k) {
  const t = db.transaction(["meta"]);
  const r = await reqP(t.objectStore("meta").get(k));
  return r?.v;
}
async function setMeta(db, k, v) {
  const t = db.transaction(["meta"], "readwrite");
  t.objectStore("meta").put({ k, v });
  await txDone(t);
}
async function getAllCategories(db) {
  const t = db.transaction(["categories"]);
  return await reqP(t.objectStore("categories").getAll());
}
async function getAllDays(db) {
  const t = db.transaction(["days"]);
  return await reqP(t.objectStore("days").getAll());
}
async function putDay(db, day) {
  const t = db.transaction(["days"], "readwrite");
  t.objectStore("days").put(day);
  await txDone(t);
}

// ---------- seed ----------
// Loads category names + per-year overrides from seed.json. Day data is
// NOT seeded into IndexedDB — historical hours live per-user in Supabase.
// Visitors who aren't signed in see an empty grid with the palette ready.
async function maybeSeed(db) {
  let seed;
  try {
    const res = await fetch("data/seed.json", { cache: "no-store" });
    if (!res.ok) { console.warn("seed http", res.status); return false; }
    seed = await res.json();
  } catch (e) {
    console.warn("seed fetch failed:", e);
    return false;
  }
  const cats = Object.entries(seed.categories || {}).map(([id, name]) => ({
    id: Number(id),
    name,
    color: colorFor(Number(id)),
  }));
  if (cats.length) await bulkPut(db, "categories", cats);
  await setMeta(db, "categoriesByYear", seed.categoriesByYear || {});
  await setMeta(db, "colorsByYear", seed.colorsByYear || {});
  return false;
}

// ---------- demo mode ----------
// Click the "Oscar" word in the header to swap in synthetic data for
// showing the app to people without exposing real life. Demo edits are
// in-memory only — scheduleSave / cloud sync are gated by demoActive so
// nothing leaks into IndexedDB or Supabase.
const DEMO_LS_KEY = "lt.demoMode";
let demoActive = false;
let realDaysSnapshot = null;

function demoSeed(iso) {
  let h = 2166136261;
  for (let i = 0; i < iso.length; i++) {
    h ^= iso.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function demoRand(seed, salt) {
  const x = Math.sin(seed + salt * 9973) * 43758.5453;
  return x - Math.floor(x);
}

function generateDemoDays() {
  const map = new Map();
  const today = todayISO();
  const todayD = isoToDate(today);
  const startY = 2023;
  const endY = todayD.getFullYear();
  const WEEKDAY_EVE = [15, 7, 12, 9, 6, 3, 16];
  const WEEKEND = [3, 7, 6, 9, 15, 12, 16, 4, 10];

  for (let y = startY; y <= endY; y++) {
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const days = isLeap ? 366 : 365;
    const start = new Date(y, 0, 1);
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      if (d > todayD) break;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dow = d.getDay();
      const isWknd = dow === 0 || dow === 6;
      const seed = demoSeed(iso);
      const hours = new Array(24).fill(null);

      const sleepStart = isWknd
        ? 23 + Math.floor(demoRand(seed, 1) * 2)   // 23–24
        : 22 + Math.floor(demoRand(seed, 2) * 2);  // 22–23
      const sleepEnd = isWknd
        ? 8 + Math.floor(demoRand(seed, 3) * 3)    // 8–10
        : 7 + Math.floor(demoRand(seed, 4) * 2);   // 7–8
      for (let h = 0; h < 24; h++) {
        const isSleep = h >= sleepStart || h < sleepEnd;
        if (isSleep) hours[h] = 1;
      }

      if (!isWknd) {
        const workStart = 9;
        const workEnd = 17 + Math.floor(demoRand(seed, 5) * 2);
        for (let h = workStart; h < workEnd; h++) hours[h] = 2;
        if (demoRand(seed, 6) > 0.3) hours[12] = 12;
        // Morning exercise sometimes
        if (demoRand(seed, 7) > 0.7) hours[Math.max(sleepEnd, 7)] = 7;
        // Evening
        let cur = workEnd;
        while (cur < sleepStart) {
          const cat = WEEKDAY_EVE[Math.floor(demoRand(seed, cur + 100) * WEEKDAY_EVE.length)];
          const len = 1 + Math.floor(demoRand(seed, cur + 200) * 3);
          for (let h = cur; h < Math.min(cur + len, sleepStart); h++) hours[h] = cat;
          cur += len;
        }
      } else {
        let cur = sleepEnd;
        while (cur < sleepStart) {
          const cat = WEEKEND[Math.floor(demoRand(seed, cur + 300) * WEEKEND.length)];
          const len = 1 + Math.floor(demoRand(seed, cur + 400) * 4);
          for (let h = cur; h < Math.min(cur + len, sleepStart); h++) hours[h] = cat;
          cur += len;
        }
      }

      map.set(iso, { date: iso, day: dowShort(iso), hours, notes: "" });
    }
  }
  return map;
}

function setDemoMode(on, { persist = true } = {}) {
  if (on === demoActive) return;
  demoActive = on;
  if (persist) localStorage.setItem(DEMO_LS_KEY, on ? "1" : "0");
  document.body.classList.toggle("demo-mode", on);
  document.title = on ? "DEMO — Life Tracker" : "Oscar — Life Tracker";
  const word = document.querySelector(".brand .word");
  if (word) word.textContent = on ? "DEMO" : "Oscar";

  if (on) {
    realDaysSnapshot = state.daysByIso;
    state.daysByIso = generateDemoDays();
  } else {
    state.daysByIso = realDaysSnapshot || new Map();
    realDaysSnapshot = null;
  }
  renderYears();
  scrollToIso(todayISO());
  refreshSignedOutOverlay();
  if (!on && state.userId) refreshFromCloud(true);
}

function wireDemoToggle() {
  const word = document.querySelector(".brand .word");
  if (!word) return;
  word.style.cursor = "pointer";
  word.title = "Click to toggle demo mode";
  word.addEventListener("click", () => setDemoMode(!demoActive));
}

// ---------- date helpers ----------
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isoToDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function shiftIso(iso, days) {
  const d = isoToDate(iso);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function shortDate(iso) {
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}
function dowShort(iso) {
  return DOW[isoToDate(iso).getDay()];
}
function isWeekend(iso) {
  const w = isoToDate(iso).getDay();
  return w === 0 || w === 6;
}

// ---------- state ----------
const state = {
  db: null,
  categories: [],          // [{id, name, color}]
  catById: new Map(),      // id -> {id, name, color}
  namesByYear: {},         // {"2023": {"5": "Clare", ...}, ...}
  daysByIso: new Map(),    // iso -> day record
  rowEls: new Map(),       // iso -> rowEl
  cellEls: new Map(),      // `${iso}#${h}` -> cellEl
  yearSections: new Map(), // year(number) -> sectionEl
  activeYear: null,        // number
  activeCat: null,
  paint: { active: false, button: 0 },
  userId: null,            // supabase auth user id when signed in
  userEmail: null,
};

function nameFor(catId, iso) {
  const year = iso?.slice(0, 4);
  const yearName = year && state.namesByYear?.[year]?.[String(catId)];
  if (yearName) return yearName;
  return state.catById.get(catId)?.name || `Cat ${catId}`;
}

// ---------- DOM helper ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) e.dataset[dk] = dv;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) {
    if (k == null) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}

// ---------- rendering ----------
function renderHourHeader() {
  const root = document.getElementById("hour-header");
  root.replaceChildren();
  root.append(
    el("div", { class: "h-date" }, "Date"),
    el("div", { class: "h-day" }, "Day"),
    ...Array.from({ length: 24 }, (_, h) =>
      el("div", { class: "h-hour", dataset: { h: String(h) } }, String(h).padStart(2, "0"))),
    el("div", { class: "h-notes" }, "Notes"),
  );
}

// Each non-empty cell renders its category's gradient, but stretched as if
// it spanned the full 24-hour row width — so cell at hour h always shows the
// h-th 1/24th slice of the gradient. Cells in the same hour column across
// different days therefore show the same shade, eliminating row-to-row
// terracing while keeping a smooth left-to-right gradient.
function styleRowRuns(iso) {
  const day = state.daysByIso.get(iso);
  const hours = day?.hours || new Array(24).fill(null);
  let i = 0;
  while (i < 24) {
    const v = hours[i];
    if (v == null) {
      const cell = state.cellEls.get(`${iso}#${i}`);
      if (cell) {
        cell.classList.add("empty");
        cell.style.background = "";
        cell.style.backgroundSize = "";
        cell.style.backgroundPosition = "";
        cell.style.backgroundRepeat = "";
        cell.style.color = "";
        cell.style.borderLeftColor = "";
        cell.title = "";
        cell.textContent = "";
      }
      i++;
      continue;
    }
    let j = i;
    while (j < 24 && hours[j] === v) j++;
    const cat = state.catById.get(v);
    const grad = cat ? gradientFor(cat.color, "to right") : "";
    const fg = cat ? textOn(cat.color) : "";
    const label = `${v} · ${nameFor(v, iso)}`;
    const icon = iconFor(v);
    for (let k = i; k < j; k++) {
      const cell = state.cellEls.get(`${iso}#${k}`);
      if (!cell) continue;
      cell.classList.remove("empty");
      cell.classList.toggle("has-icon", !!icon);
      cell.textContent = icon || String(v);
      cell.title = label;
      cell.style.color = fg;
      cell.style.background = grad;
      cell.style.backgroundSize = "2400% 100%";
      cell.style.backgroundPosition = `${(k / 23) * 100}% 0`;
      cell.style.backgroundRepeat = "no-repeat";
      cell.style.borderLeftColor = k === i ? "" : "transparent";
    }
    i = j;
  }
}

function buildRow(iso) {
  const day = state.daysByIso.get(iso) || {
    date: iso, day: "", hours: new Array(24).fill(null), notes: "",
  };
  const row = el("div", {
    class: "row" + (isWeekend(iso) ? " is-weekend" : "") +
            (iso === todayISO() ? " is-today" : "") +
            (iso.endsWith("-01") ? " month-first" : ""),
    dataset: { iso },
  });
  row.append(
    el("div", { class: "date" }, shortDate(iso)),
    el("div", { class: "day" }, dowShort(iso)),
  );
  for (let h = 0; h < 24; h++) {
    const c = el("div", {
      class: "cell empty",
      dataset: { iso, h: String(h) },
    });
    row.append(c);
    state.cellEls.set(`${iso}#${h}`, c);
  }
  styleRowRuns(iso);
  const notesInput = el("input", {
    type: "text",
    value: day.notes || "",
    dataset: { iso, notes: "1" },
  });
  row.append(el("div", { class: "notes" }, notesInput));
  state.rowEls.set(iso, row);
  return row;
}

function renderYears() {
  const root = document.getElementById("years");
  const select = document.getElementById("year-select");
  root.replaceChildren();
  select.replaceChildren();
  state.rowEls.clear();
  state.cellEls.clear();
  state.yearSections.clear();

  const allIsos = [...state.daysByIso.keys()].sort();
  if (allIsos.length === 0) return;

  const firstYear = Number(allIsos[0].slice(0, 4));
  const today = todayISO();
  const currentYear = Number(today.slice(0, 4));
  const lastYear = Math.max(Number(allIsos[allIsos.length - 1].slice(0, 4)), currentYear);

  // dropdown lists newest year first so 2026 is on top
  for (let y = lastYear; y >= firstYear; y--) {
    select.append(el("option", { value: String(y) }, String(y)));
  }

  for (let y = firstYear; y <= lastYear; y++) {
    const section = el("section", {
      class: "year-section",
      dataset: { year: String(y) },
    });
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const days = isLeap ? 366 : 365;
    const start = new Date(y, 0, 1);
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      section.append(buildRow(iso));
    }
    root.append(section);
    state.yearSections.set(y, section);
  }

  // default: persisted choice → current year → last year present
  let initial = Number(localStorage.getItem("lt.activeYear")) || currentYear;
  if (!state.yearSections.has(initial)) initial = lastYear;
  activateYear(initial, { scroll: false });
}

function activateYear(y, { scroll = true } = {}) {
  if (!state.yearSections.has(y)) return;
  state.activeYear = y;
  localStorage.setItem("lt.activeYear", String(y));
  for (const [yy, section] of state.yearSections) {
    section.classList.toggle("is-active", yy === y);
  }
  const select = document.getElementById("year-select");
  if (select && select.value !== String(y)) select.value = String(y);
  if (scroll) {
    document.getElementById("years").scrollTop = 0;
    if (y === Number(todayISO().slice(0, 4))) {
      requestAnimationFrame(() => scrollToIso(todayISO()));
    }
  }
}

function renderPalette() {
  const ul = document.getElementById("palette-list");
  ul.replaceChildren();
  for (const c of state.categories) {
    ul.append(el("li", {
      class: "cat",
      "aria-pressed": String(state.activeCat === c.id),
      dataset: { id: String(c.id) },
      onclick: () => setActiveCat(c.id),
    },
      el("span", { class: "id" }, c.id),
      el("span", { class: "swatch", style: `background:${gradientFor(c.color)}` }),
      el("span", { class: "name", title: c.name },
        iconFor(c.id) ? `${iconFor(c.id)} ${c.name}` : c.name),
    ));
  }
  renderActiveCat();
}

function renderActiveCat() {
  const wrap = document.getElementById("active-cat");
  const cat = state.activeCat != null ? state.catById.get(state.activeCat) : null;
  wrap.classList.toggle("has-cat", !!cat);
  wrap.querySelector(".swatch").style.background = cat ? gradientFor(cat.color) : "";
  wrap.querySelector(".label").textContent = cat
    ? `${cat.id} · ${cat.name}`
    : "no category selected";
}

function setActiveCat(id) {
  state.activeCat = id;
  for (const li of document.querySelectorAll("#palette-list .cat")) {
    li.setAttribute("aria-pressed", String(Number(li.dataset.id) === id));
  }
  renderActiveCat();
}

// ---------- mutations ----------
function getOrInitDay(iso) {
  let d = state.daysByIso.get(iso);
  if (!d) {
    d = { date: iso, day: dowShort(iso), hours: new Array(24).fill(null), notes: "" };
    state.daysByIso.set(iso, d);
  }
  return d;
}

let saveTimer = null;
const dirty = new Set();

const cloudState = {
  lastSyncAt: null,      // ms epoch of last successful cloud push or pull
  hasError: false,       // last cloud op errored
  maxUpdatedAt: null,    // ISO of max updated_at seen — drives delta pulls
};

// ISOs whose latest local edit hasn't been confirmed by the cloud yet.
// Persisted to IndexedDB ("pending_push") so a tab closed mid-upload still
// retries on next boot. The indicator reads .size as "needs uploading"
// regardless of whether a push is currently in flight.
const cloudPending = new Set();
let flushInflight = false;
// Epoch ms until which the indicator should flash "saved ✓". Set when a
// flush actually pushed something and ended with nothing left to upload.
let savedFlashUntil = 0;
let savedFlashTimer = null;
function flashSaved(ms = 1800) {
  savedFlashUntil = Date.now() + ms;
  clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(refreshSaveIndicator, ms + 50);
  refreshSaveIndicator();
}
async function persistPending() {
  if (!state.db) return;
  try { await setMeta(state.db, "pending_push", [...cloudPending]); }
  catch (e) { console.warn("persist pending_push", e); }
}
async function markPending(iso) { cloudPending.add(iso); await persistPending(); }
async function markSynced(iso) { cloudPending.delete(iso); await persistPending(); }

function fmtClock(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// localPhase: 'idle' | 'saving' | 'error'
let localPhase = "idle";
function setSaveStatus(s) {
  localPhase = s === "saving" ? "saving" : s === "error" ? "error" : "idle";
  refreshSaveIndicator();
}

function refreshSaveIndicator() {
  const el = document.getElementById("save-indicator");
  if (!el) return;
  el.classList.remove("saving", "error", "uploading", "ok-local", "ok-cloud", "just-saved");
  const lbl = el.querySelector(".lbl");

  // Nothing to indicate when signed out — the grid is empty and edits are
  // blocked. The "Sign in" topbar button is the only relevant affordance.
  if (!state.userId) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  if (localPhase === "error") {
    el.classList.add("error");
    if (lbl) lbl.textContent = "save error";
    el.title = "Save failed — your changes may not have been written.";
    return;
  }
  if (localPhase === "saving") {
    el.classList.add("saving");
    if (lbl) lbl.textContent = "saving…";
    el.title = "Saving to this device…";
    return;
  }
  // local idle
  const signedIn = !!state.userId;
  if (cloudState.hasError) {
    el.classList.add("error");
    if (lbl) lbl.textContent = "cloud error";
    el.title = "Local data is safe; cloud upload failed. Will retry on next change.";
    return;
  }
  if (signedIn) {
    if (cloudPending.size > 0) {
      el.classList.add("uploading");
      if (lbl) lbl.textContent = "uploading…";
      el.title = `${cloudPending.size} change(s) waiting to upload to cloud`;
      return;
    }
    if (savedFlashUntil > Date.now()) {
      el.classList.add("ok-cloud", "just-saved");
      if (lbl) lbl.textContent = "saved ✓";
      el.title = "Your change is safe in Supabase.";
      return;
    }
    if (cloudState.lastSyncAt) {
      el.classList.add("ok-cloud");
      const d = new Date(cloudState.lastSyncAt);
      if (lbl) lbl.textContent = `synced ${fmtClock(d)}`;
      el.title = `Last cloud sync: ${d.toLocaleString()}\nSafe to close — your data is in Supabase.`;
      return;
    }
    el.classList.add("ok-cloud");
    if (lbl) lbl.textContent = "signed in";
    el.title = "Cloud connected — no changes yet this session.";
    return;
  }
}

// Tick the clock label every minute so "synced 14:23" stays current as time passes.
setInterval(() => {
  if (localPhase === "idle" && cloudPending.size === 0 && !cloudState.hasError) {
    refreshSaveIndicator();
  }
}, 30_000);
function scheduleSave(iso) {
  if (demoActive) return;
  dirty.add(iso);
  setSaveStatus("saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const isos = [...dirty];
    dirty.clear();
    const nowIso = new Date().toISOString();
    try {
      const t = state.db.transaction(["days"], "readwrite");
      const os = t.objectStore("days");
      for (const id of isos) {
        const d = state.daysByIso.get(id);
        if (d) {
          d.updated_at = nowIso;
          os.put(d);
        }
      }
      await txDone(t);
      setSaveStatus("saved");
    } catch (e) {
      console.error(e);
      setSaveStatus("error");
      return;
    }
    // Best-effort cloud push. Anything that fails (or times out) stays in
    // cloudPending and gets retried by flushPending() on focus / 60s tick.
    if (state.userId) {
      for (const id of isos) {
        const d = state.daysByIso.get(id);
        if (!d) continue;
        await markPending(id);
        refreshSaveIndicator();
      }
      flushPending();
    }
  }, 250);
}

// Re-push every iso still in cloudPending. Called from scheduleSave, on
// window focus, and from the 60s background tick. Single-flighted so
// overlapping triggers don't pile on duplicate requests.
async function flushPending() {
  if (!state.userId || demoActive) return;
  if (flushInflight) return;
  if (cloudPending.size === 0) return;
  flushInflight = true;
  let pushed = 0;
  try {
    for (const id of [...cloudPending]) {
      const d = state.daysByIso.get(id);
      if (!d) { await markSynced(id); continue; }
      try {
        await pushDay(state.userId, d);
        await markSynced(id);
        pushed++;
        cloudState.lastSyncAt = Date.now();
        cloudState.hasError = false;
        if (d.updated_at && (!cloudState.maxUpdatedAt || d.updated_at > cloudState.maxUpdatedAt)) {
          cloudState.maxUpdatedAt = d.updated_at;
        }
      } catch (e) {
        cloudState.hasError = true;
        console.warn("push", id, e);
        break; // stop on first failure; next tick will retry the rest
      } finally {
        refreshSaveIndicator();
      }
    }
  } finally {
    flushInflight = false;
    // Flash "saved ✓" only when this flush actually drained the queue —
    // not when it was a no-op or stopped mid-way on error.
    if (pushed > 0 && cloudPending.size === 0 && !cloudState.hasError) {
      flashSaved();
    } else {
      refreshSaveIndicator();
    }
  }
}

function applyHour(iso, h, catId) {
  if (h < 0 || h > 23) return;
  // Editing requires sign-in (or demo mode). Without a session, edits would
  // write to IndexedDB but never reload, since reload() now gates IDB load
  // on session — so the change would silently vanish on refresh.
  if (!state.userId && !demoActive) return;
  const d = getOrInitDay(iso);
  if (d.hours[h] === catId) return;
  d.hours[h] = catId;
  styleRowRuns(iso);
  scheduleSave(iso);
}

// ---------- events ----------
function wirePaint() {
  const root = document.getElementById("years");
  const cellOf = (target) => {
    const c = target.closest(".cell");
    if (!c || !c.dataset.iso) return null;
    return c;
  };
  root.addEventListener("mousedown", (e) => {
    const cell = cellOf(e.target);
    if (!cell) return;
    e.preventDefault();
    state.paint.active = true;
    state.paint.button = e.button;
    const { iso, h } = cell.dataset;
    if (e.button === 2) applyHour(iso, Number(h), null);
    else if (state.activeCat != null) applyHour(iso, Number(h), state.activeCat);
  });
  root.addEventListener("mouseover", (e) => {
    if (!state.paint.active) return;
    const cell = cellOf(e.target);
    if (!cell) return;
    const { iso, h } = cell.dataset;
    if (state.paint.button === 2) applyHour(iso, Number(h), null);
    else if (state.activeCat != null) applyHour(iso, Number(h), state.activeCat);
  });
  ["mouseup", "mouseleave"].forEach((ev) =>
    window.addEventListener(ev, () => { state.paint.active = false; }));
  root.addEventListener("contextmenu", (e) => {
    if (cellOf(e.target)) e.preventDefault();
  });
  // Notes editing — save on input. Same auth gate as applyHour().
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.notes !== "1") return;
    if (!state.userId && !demoActive) { t.value = ""; return; }
    const iso = t.dataset.iso;
    const d = getOrInitDay(iso);
    d.notes = t.value;
    scheduleSave(iso);
  });
}

function wireKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    // Use e.code so non-US layouts (e.g. Swedish) still get the digit row.
    const m = e.code.match(/^Digit([0-9])$/);
    if (m) {
      const n = Number(m[1]);
      const id = e.shiftKey ? (n === 0 ? 20 : 10 + n) : (n === 0 ? 10 : n);
      if (state.catById.has(id)) {
        setActiveCat(id);
        e.preventDefault();
      }
      return;
    }
    if (e.key.toLowerCase() === "t") {
      scrollToIso(todayISO(), true);
    }
  });
}

function scrollToIso(iso, smooth = false) {
  const y = Number(iso.slice(0, 4));
  if (y !== state.activeYear && state.yearSections.has(y)) {
    activateYear(y, { scroll: false });
  }
  const row = state.rowEls.get(iso);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
}

function wireDateNav() {
  document.getElementById("btn-today").addEventListener("click", () =>
    scrollToIso(todayISO(), true));
  document.getElementById("fab-today").addEventListener("click", () =>
    scrollToIso(todayISO(), true));
  document.getElementById("year-select").addEventListener("change", (e) =>
    activateYear(Number(e.target.value)));
}

function wireSync() {
  const dlg = document.getElementById("sync-dialog");
  document.getElementById("btn-sync").addEventListener("click", () => dlg.showModal());

  document.getElementById("btn-export").addEventListener("click", async () => {
    const days = await getAllDays(state.db);
    const cats = await getAllCategories(state.db);
    const blob = new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      categories: cats,
      days,
    }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `life-tracker-${todayISO()}.json`;
    document.body.append(a); a.click(); a.remove();
    document.getElementById("sync-status").textContent = `Exported ${days.length} days.`;
  });
  document.getElementById("btn-import").addEventListener("click", () =>
    document.getElementById("file-import").click());
  document.getElementById("file-import").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    if (Array.isArray(data.categories)) await bulkPut(state.db, "categories", data.categories);
    if (Array.isArray(data.days)) await bulkPut(state.db, "days", data.days);
    await reload();
    document.getElementById("sync-status").textContent =
      `Imported ${data.days?.length || 0} days, ${data.categories?.length || 0} categories.`;
  });
}

function computeStats(yearFilter) {
  const totals = new Map();
  let totalHours = 0;
  let dayCount = 0;
  for (const d of state.daysByIso.values()) {
    if (yearFilter !== "all" && !d.date.startsWith(yearFilter)) continue;
    let any = false;
    for (const id of d.hours || []) {
      if (id == null) continue;
      totals.set(id, (totals.get(id) || 0) + 1);
      totalHours++;
      any = true;
    }
    if (any) dayCount++;
  }
  return { totals, totalHours, dayCount };
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function renderPie(segments, size = 220) {
  const r = size / 2 - 4;
  const cx = size / 2, cy = size / 2;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${size} ${size}`,
    width: String(size),
    height: String(size),
  });
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) {
    svg.append(svgEl("circle", { cx, cy, r, fill: "rgba(255,255,255,0.05)" }));
    return svg;
  }
  // Single-segment case: full circle.
  if (segments.length === 1) {
    const c = svgEl("circle", { cx, cy, r, fill: segments[0].color });
    const t = svgEl("title");
    t.textContent = `${segments[0].label} — 100%`;
    c.appendChild(t);
    svg.appendChild(c);
    return svg;
  }
  let angle = -Math.PI / 2; // start at 12 o'clock
  for (const seg of segments) {
    const slice = (seg.value / total) * Math.PI * 2;
    const end = angle + slice;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const largeArc = slice > Math.PI ? 1 : 0;
    const path = svgEl("path", {
      d: `M ${cx},${cy} L ${x1.toFixed(2)},${y1.toFixed(2)} A ${r},${r} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`,
      fill: seg.color,
      stroke: "rgba(0,0,0,0.35)",
      "stroke-width": "0.75",
    });
    const t = svgEl("title");
    const pct = ((seg.value / total) * 100).toFixed(1);
    t.textContent = `${seg.label} — ${seg.value.toLocaleString()} h (${pct}%)`;
    path.appendChild(t);
    svg.appendChild(path);
    angle = end;
  }
  return svg;
}

function populateStatsYears(select) {
  select.replaceChildren();
  const years = new Set();
  for (const iso of state.daysByIso.keys()) years.add(iso.slice(0, 4));
  const sorted = [...years].sort((a, b) => Number(b) - Number(a));
  select.append(el("option", { value: "all" }, "All time"));
  for (const y of sorted) select.append(el("option", { value: y }, y));
  // default to current year if present, else all
  const cy = todayISO().slice(0, 4);
  select.value = years.has(cy) ? cy : "all";
}

// Highlights: derived per-day / per-week averages for a fixed set of
// categories, mirroring the breakdown the user kept at the bottom of
// the original xlsx tracker.
const HIGHLIGHT_CATS = [
  { id: 1,  label: "Avg sleep / day",        unit: "day"  },
  { id: 2,  label: "Avg work / week",        unit: "week" },
  { id: 3,  label: "Avg hobby / week",       unit: "week" },
  { id: 8,  label: "Avg productivity / week", unit: "week" },
  { id: 7,  label: "Avg exercise / week",    unit: "week" },
  { id: 9,  label: "Avg gaming / week",      unit: "week" },
  { id: 15, label: "Avg TV / week",          unit: "week" },
  { id: 6,  label: "Avg social / week",      unit: "week" },
];
const fmtNum = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

function buildHighlights(totals, dayCount) {
  if (dayCount === 0) return [];
  const weeks = dayCount / 7;
  const items = HIGHLIGHT_CATS.map(({ id, label, unit }) => {
    const hours = totals.get(id) || 0;
    const denom = unit === "day" ? dayCount : weeks;
    const cat = state.catById.get(id);
    return {
      label,
      value: `${fmtNum(hours / denom)} h`,
      color: cat?.color || "#666",
    };
  });
  // "Days wasted (waking)" — total waste hours / (24 - avg sleep per day)
  const sleepPerDay = (totals.get(1) || 0) / dayCount;
  const wasteHours = totals.get(13) || 0;
  const wasteCat = state.catById.get(13);
  if (sleepPerDay < 24) {
    items.push({
      label: "Days wasted (waking)",
      value: fmtNum(wasteHours / (24 - sleepPerDay)),
      color: wasteCat?.color || "#666",
    });
  }
  return items;
}

function yearProgress(yearFilter) {
  const cy = todayISO().slice(0, 4);
  // Only show year-progress when looking at the current year (or all-time).
  if (yearFilter !== "all" && yearFilter !== cy) return null;
  const now = new Date();
  const y = now.getFullYear();
  const start = new Date(y, 0, 1);
  const dayOfYear = Math.floor((now - start) / 86400000) + 1;
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;
  const hoursLeft = (daysInYear - dayOfYear) * 24;
  return { dayOfYear, hoursLeft, year: y };
}

function kpiCard(label, value, sub, accent) {
  return el("div", { class: `kpi${accent ? " " + accent : ""}` },
    el("div", { class: "kpi-label" }, label),
    el("div", { class: "kpi-value" }, value),
    sub ? el("div", { class: "kpi-sub" }, sub) : null,
  );
}
function chartCard(title, ...children) {
  return el("section", { class: "chart-card" },
    el("h3", {}, title),
    ...children,
  );
}
function collapsibleCard(title, ...children) {
  const card = document.createElement("section");
  card.className = "chart-card collapsible";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.append(el("h3", {}, title));
  details.append(summary, ...children);
  card.append(details);
  return card;
}

function renderStats() {
  const select = document.getElementById("stats-year");
  const yearFilter = select?.value || "all";
  const body = document.getElementById("stats-body");
  body.replaceChildren();
  const { totals, totalHours, dayCount } = computeStats(yearFilter);
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);

  const period = yearFilter === "all" ? "all time" : yearFilter;
  body.append(el("p", { class: "muted stats-subtitle" }, `Period · ${period}`));

  if (totalHours === 0) {
    body.append(el("div", { class: "stats-empty" }, "No tracked hours in this period."));
    return;
  }

  // ----- KPI grid -----
  const kpis = el("div", { class: "kpi-grid" });
  kpis.append(
    kpiCard("Days tracked", dayCount.toLocaleString(), `over ${period}`),
    kpiCard("Hours tracked", totalHours.toLocaleString(),
      `${(totalHours / dayCount).toFixed(1)} h/day avg`, "green"),
  );
  // Days wasted KPI (waking)
  const sleepPerDay = (totals.get(1) || 0) / dayCount;
  if (sleepPerDay < 24) {
    const waste = totals.get(13) || 0;
    const wastedDays = waste / (24 - sleepPerDay);
    kpis.append(kpiCard("Days wasted", fmtNum(wastedDays), "waking time", "red"));
  }
  // Year-progress KPIs (when relevant)
  const yp = yearProgress(yearFilter);
  if (yp) {
    kpis.append(
      kpiCard("Days gone", yp.dayOfYear.toLocaleString(), `${yp.year}`, "blue"),
      kpiCard("Hours left", yp.hoursLeft.toLocaleString(), `in ${yp.year}`, "blue"),
    );
  }
  body.append(kpis);

  // ----- Pie + Highlights side-by-side -----
  const segments = sorted.map(([id, n]) => {
    const cat = state.catById.get(id);
    return { value: n, color: cat?.color || "#666", label: cat?.name || `Cat ${id}` };
  });
  const pieWrap = el("div", { class: "stats-pie" }, renderPie(segments, 280));

  const highlights = buildHighlights(totals, dayCount);
  const hlList = el("ul", { class: "stats-hl-list" });
  for (const h of highlights) {
    hlList.append(el("li", { class: "stats-hl-row" },
      el("span", { class: "stats-hl-swatch", style: `background:${h.color}` }),
      el("span", { class: "stats-hl-label" }, h.label),
      el("span", { class: "stats-hl-value" }, h.value),
    ));
  }

  body.append(el("div", { class: "stats-grid-2" },
    chartCard("Distribution", pieWrap),
    chartCard("Highlights", hlList),
  ));

  // ----- Full category list -----
  const list = el("ul", { class: "stats-list" });
  for (const [id, n] of sorted) {
    const cat = state.catById.get(id);
    if (!cat) continue;
    const pct = (n / totalHours) * 100;
    const pctText = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    list.append(el("li", { class: "stats-row" },
      el("span", { class: "stats-swatch", style: `background:${gradientFor(cat.color)}` }),
      el("span", { class: "stats-name" }, cat.name),
      el("span", { class: "stats-bar-wrap" },
        el("span", { class: "stats-bar", style: `width:${pct}%; background:${cat.color}` }),
      ),
      el("span", { class: "stats-num" }, `${n.toLocaleString()} h`),
      el("span", { class: "stats-pct muted" }, `${pctText}%`),
    ));
  }
  body.append(collapsibleCard("All categories", list));
}

function wireStats() {
  const dlg = document.getElementById("stats-dialog");
  const select = document.getElementById("stats-year");
  document.getElementById("btn-stats").addEventListener("click", () => {
    populateStatsYears(select);
    renderStats();
    dlg.showModal();
  });
  select?.addEventListener("change", renderStats);
}

// ---------- cloud sync ----------
function setSyncIndicator(text) {
  const el = document.getElementById("sync-state");
  if (el) el.textContent = text || "";
}
function updateAccountUI() {
  const signedOut = document.getElementById("signed-out-pane");
  const signedIn = document.getElementById("signed-in-pane");
  const emailEl = document.getElementById("account-email");
  const btnSync = document.getElementById("btn-sync");
  const isIn = !!state.userId;
  if (signedOut) signedOut.hidden = isIn;
  if (signedIn) signedIn.hidden = !isIn;
  if (emailEl) emailEl.textContent = state.userEmail || "";
  if (btnSync) {
    btnSync.classList.toggle("is-signed-in", isIn);
    btnSync.textContent = isIn ? "Account" : "Sign in";
  }
  refreshSignedOutOverlay();
}

// Show the centered sign-in CTA whenever the user has no real session and
// isn't in demo mode. Both updateAccountUI and setDemoMode call this so the
// overlay reacts to either auth or demo-toggle changes.
function refreshSignedOutOverlay() {
  const show = !state.userId && !demoActive;
  document.body.classList.toggle("signed-out", show);
  const overlay = document.getElementById("signin-overlay");
  if (overlay) overlay.hidden = !show;
}

async function reconcileWithCloud() {
  if (!state.userId || demoActive) return;
  setSyncIndicator("syncing…");
  try {
    const remote = await pullDays();
    for (const r of remote) {
      if (!cloudState.maxUpdatedAt || r.updated_at > cloudState.maxUpdatedAt) {
        cloudState.maxUpdatedAt = r.updated_at;
      }
    }
    const remoteByDate = new Map(remote.map((r) => [r.date, r]));
    const localUpdates = [];
    const toPush = [];
    for (const local of state.daysByIso.values()) {
      const r = remoteByDate.get(local.date);
      const localT = Date.parse(local.updated_at || 0) || 0;
      const remoteT = r ? (Date.parse(r.updated_at) || 0) : -1;
      if (!r) {
        // Only push if local has any actual content.
        const hasContent =
          (Array.isArray(local.hours) && local.hours.some((h) => h != null)) ||
          (local.notes && local.notes.length);
        if (hasContent) toPush.push(local);
      } else if (localT > remoteT) {
        toPush.push(local);
      } else if (remoteT > localT) {
        const merged = {
          date: r.date,
          day: dowShort(r.date),
          hours: r.hours,
          notes: r.notes,
          updated_at: r.updated_at,
        };
        state.daysByIso.set(r.date, merged);
        localUpdates.push(merged);
      }
    }
    for (const r of remote) {
      if (state.daysByIso.has(r.date)) continue;
      const merged = {
        date: r.date,
        day: dowShort(r.date),
        hours: r.hours,
        notes: r.notes,
        updated_at: r.updated_at,
      };
      state.daysByIso.set(r.date, merged);
      localUpdates.push(merged);
    }
    if (localUpdates.length) await bulkPut(state.db, "days", localUpdates);
    if (toPush.length) await pushDays(state.userId, toPush);
    for (const u of localUpdates) styleRowRuns(u.date);
    cloudState.lastSyncAt = Date.now();
    cloudState.hasError = false;
    setSyncIndicator(`synced · ${remote.length + toPush.length} days`);
    setTimeout(() => setSyncIndicator(""), 2500);
    refreshSaveIndicator();
  } catch (e) {
    console.error("reconcile failed", e);
    cloudState.hasError = true;
    setSyncIndicator("sync error");
    refreshSaveIndicator();
  }
}

// Pull-only refresh: fetch latest from cloud and overlay any rows that
// were edited elsewhere since our last sync. Local rows that are newer
// than remote (i.e. unpushed edits) are left untouched.
let refreshInflight = false;
async function refreshFromCloud(silent = true) {
  if (!state.userId || refreshInflight || demoActive) return 0;
  refreshInflight = true;
  if (!silent) setSyncIndicator("checking…");
  try {
    // Delta query: only rows updated after our last pull. Saves bandwidth.
    const remote = await pullDays(cloudState.maxUpdatedAt || undefined);
    const updates = [];
    for (const r of remote) {
      if (!cloudState.maxUpdatedAt || r.updated_at > cloudState.maxUpdatedAt) {
        cloudState.maxUpdatedAt = r.updated_at;
      }
      const local = state.daysByIso.get(r.date);
      const localT = Date.parse(local?.updated_at || 0) || 0;
      const remoteT = Date.parse(r.updated_at) || 0;
      if (remoteT > localT) {
        const merged = {
          date: r.date,
          day: dowShort(r.date),
          hours: r.hours,
          notes: r.notes,
          updated_at: r.updated_at,
        };
        state.daysByIso.set(r.date, merged);
        updates.push(merged);
      }
    }
    if (updates.length) {
      await bulkPut(state.db, "days", updates);
      for (const u of updates) {
        styleRowRuns(u.date);
        const input = state.rowEls.get(u.date)?.querySelector('input[data-notes="1"]');
        if (input && input.value !== (u.notes || "")) input.value = u.notes || "";
      }
    }
    cloudState.lastSyncAt = Date.now();
    cloudState.hasError = false;
    refreshSaveIndicator();
    if (!silent) {
      setSyncIndicator(updates.length ? `pulled ${updates.length} update(s)` : "up to date");
      setTimeout(() => setSyncIndicator(""), 2500);
    }
    return updates.length;
  } catch (e) {
    console.warn("refresh failed", e);
    cloudState.hasError = true;
    if (!silent) setSyncIndicator("refresh error");
    refreshSaveIndicator();
    return -1;
  } finally {
    refreshInflight = false;
  }
}

let bgRefreshTimer = null;
function startBackgroundRefresh() {
  stopBackgroundRefresh();
  bgRefreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && state.userId) {
      refreshFromCloud(true);
      flushPending();
    }
  }, 60_000);
}
function stopBackgroundRefresh() {
  if (bgRefreshTimer) { clearInterval(bgRefreshTimer); bgRefreshTimer = null; }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.userId) {
    refreshFromCloud(true);
    flushPending();
  }
});
window.addEventListener("focus", () => {
  if (state.userId) { refreshFromCloud(true); flushPending(); }
});

async function initCloud() {
  if (!cloudConfigured) {
    const note = document.getElementById("cloud-note");
    if (note) note.textContent =
      "Cloud sync not configured. Paste your Supabase anon key into config.js.";
    return;
  }
  const session = await getSession();
  if (session) {
    state.userId = session.user.id;
    state.userEmail = session.user.email;
    updateAccountUI();
    refreshSaveIndicator();
    await reconcileWithCloud();
    flushPending();
    startBackgroundRefresh();
  } else {
    updateAccountUI();
    refreshSaveIndicator();
  }
  onAuthChange(async (s) => {
    if (s) {
      state.userId = s.user.id;
      state.userEmail = s.user.email;
      updateAccountUI();
      refreshSaveIndicator();
      await reconcileWithCloud();
      flushPending();
      startBackgroundRefresh();
    } else {
      state.userId = null;
      state.userEmail = null;
      cloudState.lastSyncAt = null;
      cloudState.hasError = false;
      cloudState.maxUpdatedAt = null;
      cloudPending.clear();
      await persistPending();
      stopBackgroundRefresh();
      state.daysByIso = new Map();
      renderYears();
      scrollToIso(todayISO());
      updateAccountUI();
      refreshSaveIndicator();
    }
  });

  const wireProviderButton = (id, provider, label) => {
    document.getElementById(id)?.addEventListener("click", async () => {
      const status = document.getElementById("signin-status");
      if (status) status.textContent = `Redirecting to ${label}…`;
      try {
        await signInWithProvider(provider);
      } catch (e) {
        console.error(e);
        if (status) status.textContent = `Error: ${e.message || e}. Make sure ${label} is enabled in Supabase.`;
      }
    });
  };
  wireProviderButton("btn-signin-google", "google", "Google");
  wireProviderButton("overlay-signin-btn", "google", "Google");
  document.getElementById("overlay-demo-btn")?.addEventListener("click", () => {
    setDemoMode(true);
  });
  document.getElementById("btn-signout")?.addEventListener("click", async () => {
    try { await signOut(); } catch (e) { console.warn("signOut error", e); }
    document.getElementById("sync-dialog")?.close();
  });
  document.getElementById("btn-refresh")?.addEventListener("click", async () => {
    await refreshFromCloud(false);
  });
}

// ---------- boot ----------
// Days are only loaded from IndexedDB when the user has a Supabase
// session — without auth the grid stays blank, so the local cache
// from a previous signed-in session doesn't leak into a signed-out view.
async function reload() {
  const cats = await getAllCategories(state.db);
  cats.sort((a, b) => a.id - b.id);
  state.categories = cats;
  state.catById = new Map(cats.map((c) => [c.id, c]));
  state.namesByYear = (await getMeta(state.db, "categoriesByYear")) || {};
  const session = cloudConfigured ? await getSession() : null;
  if (session) {
    const days = await getAllDays(state.db);
    state.daysByIso = new Map(days.map((d) => [d.date, d]));
    cloudPending.clear();
    const persisted = await getMeta(state.db, "pending_push");
    if (Array.isArray(persisted)) persisted.forEach((iso) => cloudPending.add(iso));
  } else {
    state.daysByIso = new Map();
    cloudPending.clear();
  }
  renderHourHeader();
  renderYears();
  renderPalette();
  scrollToIso(todayISO());
}

function renderLifeBar() {
  const fill = document.getElementById("life-bar-fill");
  const label = document.getElementById("life-bar-label");
  const end = document.getElementById("life-bar-end");
  const wrap = document.getElementById("life-bar");
  const track = wrap?.querySelector(".life-bar-track");
  if (!fill || !label || !end || !wrap || !track) return;
  const dob = isoToDate(DOB);
  const ms = Date.now() - dob.getTime();
  const weeksLived = ms / (1000 * 60 * 60 * 24 * 7);
  const pct = Math.max(0, Math.min(100, (weeksLived / LIFE_TOTAL_WEEKS) * 100));
  const w = Math.floor(weeksLived);

  // Map age boundaries onto the 4000-week bar (4000 wk ≈ 76.66 yr).
  const weeksPerYear = 365.25 / 7;
  const childPct = (LIFE_PHASES.childhoodEndAge * weeksPerYear / LIFE_TOTAL_WEEKS) * 100;
  const retirePct = (LIFE_PHASES.retirementStartAge * weeksPerYear / LIFE_TOTAL_WEEKS) * 100;
  const { childhood, adult, retirement } = LIFE_PHASE_COLORS;
  track.style.background =
    `linear-gradient(90deg,` +
    ` ${childhood} 0%, ${childhood} ${childPct}%,` +
    ` ${adult} ${childPct}%, ${adult} ${retirePct}%,` +
    ` ${retirement} ${retirePct}%, ${retirement} 100%)`;

  const fmt = (n) => n.toLocaleString("sv-SE");
  fill.style.width = pct.toFixed(3) + "%";
  label.textContent = `Week ${fmt(w)} / ${fmt(LIFE_TOTAL_WEEKS)}`;
  end.textContent = pct.toFixed(1).replace(".", ",") + "%";
  const remaining = LIFE_TOTAL_WEEKS - w;
  const ageYears = (weeksLived * 7) / 365.25;
  const phase =
    ageYears < LIFE_PHASES.childhoodEndAge ? "childhood"
    : ageYears < LIFE_PHASES.retirementStartAge ? "adult"
    : "retirement";
  wrap.title =
    `Four Thousand Weeks — ${fmt(w)} lived, ${fmt(remaining)} remaining ` +
    `(${pct.toFixed(2)}%). Born ${DOB}. ` +
    `Phases: childhood 0–${LIFE_PHASES.childhoodEndAge}, ` +
    `retirement ${LIFE_PHASES.retirementStartAge}+. ` +
    `Currently: ${phase}.`;
}

async function boot() {
  const vEl = document.getElementById("app-version");
  if (vEl) vEl.textContent = `v${APP_VERSION}`;
  renderLifeBar();
  state.db = await openDB();
  await maybeSeed(state.db);
  await reload();
  if (state.categories.length === 0) {
    const defaults = Object.entries({
      1:"Sleep", 2:"Work", 3:"Hobby", 4:"Sorting House", 5:"Party",
      6:"Social time friends", 7:"Exercise", 8:"Foxo", 9:"Gaming",
      10:"Family Time", 11:"Travel", 12:"Cooking", 13:"Waste Time",
      14:"Holiday", 15:"TV", 16:"Health", 17:"Swedish", 18:"Elin",
    }).map(([id, name]) => ({ id: Number(id), name, color: colorFor(Number(id)) }));
    await bulkPut(state.db, "categories", defaults);
    await reload();
  }
  wirePaint();
  wireKeyboard();
  wireDateNav();
  wireSync();
  wireStats();
  wireDemoToggle();
  if (localStorage.getItem(DEMO_LS_KEY) === "1") {
    setDemoMode(true, { persist: false });
  }
  refreshSaveIndicator();
  await initCloud();
}

boot().catch((e) => {
  console.error(e);
  document.body.append(el("pre", { style: "padding:16px;color:#f88;" }, String(e?.stack || e)));
});
