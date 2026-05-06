/* Life Tracker — stacked rows view.
   Each day is a row, 24 columns are hours, years are grouped.
   Storage: IndexedDB (seeded once from data/seed.json), with optional
   Supabase cloud sync (see sync.js) for cross-device. */

import {
  cloudConfigured, getSession, onAuthChange,
  signInWithEmail, signOut,
  pullDays, pushDay, pushDays,
} from "./sync.js";

// Unified palette — same hue family as the original xlsx, but consistent
// saturation/lightness so the cells read as a set. Overrides any color
// imported from the xlsx (the xlsx colors are still preserved in the DB
// under colorsByYear if we ever want them back).
const PALETTE = {
  1:  "#3a3e47",  // Sleep — dark cool gray
  2:  "#a06b9c",  // Work — dusty mauve-purple
  3:  "#a06a32",  // Hobby — toned amber
  4:  "#6f8170",  // Sorting House — deep sage
  5:  "#467a7b",  // Party / Clare — muted teal
  6:  "#5a7a45",  // Social — deeper apple green
  7:  "#475c8c",  // Exercise — steel blue
  8:  "#a85a3f",  // Foxo — deep rust (productive)
  9:  "#624a32",  // Gaming — deep brown
  10: "#8a4a7e",  // Family Time — muted plum
  11: "#2e3a52",  // Travel — deep slate-navy
  12: "#456530",  // Cooking — deep forest
  13: "#8d7c44",  // Waste Time — dusty olive
  14: "#7c5272",  // Holiday — dusky mauve
  15: "#928464",  // TV — dusty sand
  16: "#5e826c",  // Health — deep jade
  17: "#8d772f",  // Swedish — dusty gold
  18: "#b8748b",  // Elin — deep rose (fun)
  19: "#535b56",
  20: "#535b56",
};
const colorFor = (id) => PALETTE[id] ?? "#666";

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
    for (let k = i; k < j; k++) {
      const cell = state.cellEls.get(`${iso}#${k}`);
      if (!cell) continue;
      cell.classList.remove("empty");
      cell.textContent = String(v);
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
      el("span", { class: "name", title: c.name }, c.name),
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
  pending: 0,            // in-flight cloud pushes
  lastSyncAt: null,      // ms epoch of last successful cloud push or pull
  hasError: false,       // last cloud op errored
};

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
  el.classList.remove("saving", "error", "uploading", "ok-local", "ok-cloud");
  const lbl = el.querySelector(".lbl");

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
    if (cloudState.pending > 0) {
      el.classList.add("uploading");
      if (lbl) lbl.textContent = "uploading…";
      el.title = `${cloudState.pending} change(s) uploading to cloud`;
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
  // not signed in
  el.classList.add("ok-local");
  if (lbl) lbl.textContent = "local only";
  el.title = "Saved on this device only. Sign in to back up to the cloud.";
}

// Tick the clock label every minute so "synced 14:23" stays current as time passes.
setInterval(() => {
  if (localPhase === "idle" && cloudState.pending === 0 && !cloudState.hasError) {
    refreshSaveIndicator();
  }
}, 30_000);
function scheduleSave(iso) {
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
    // Best-effort cloud push; failures retry on next save.
    if (state.userId) {
      for (const id of isos) {
        const d = state.daysByIso.get(id);
        if (!d) continue;
        cloudState.pending++;
        refreshSaveIndicator();
        pushDay(state.userId, d)
          .then(() => {
            cloudState.lastSyncAt = Date.now();
            cloudState.hasError = false;
          })
          .catch((e) => {
            cloudState.hasError = true;
            console.warn("push", id, e);
          })
          .finally(() => {
            cloudState.pending--;
            refreshSaveIndicator();
          });
      }
    }
  }, 250);
}

function applyHour(iso, h, catId) {
  if (h < 0 || h > 23) return;
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
  // Notes editing — save on input
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || t.dataset.notes !== "1") return;
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

function renderStats() {
  const select = document.getElementById("stats-year");
  const yearFilter = select?.value || "all";
  const body = document.getElementById("stats-body");
  body.replaceChildren();
  const { totals, totalHours, dayCount } = computeStats(yearFilter);
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);

  const period = yearFilter === "all" ? "all time" : yearFilter;
  body.append(
    el("p", { class: "muted" },
      `${dayCount.toLocaleString()} days · ${totalHours.toLocaleString()} hours tracked · ${period}`),
  );

  if (totalHours === 0) {
    body.append(el("p", { class: "muted" }, "No tracked hours in this period."));
    return;
  }

  const segments = sorted.map(([id, n]) => {
    const cat = state.catById.get(id);
    return { value: n, color: cat?.color || "#666", label: cat?.name || `Cat ${id}` };
  });
  const pieWrap = el("div", { class: "stats-pie" });
  pieWrap.append(renderPie(segments, 220));
  body.append(pieWrap);

  // Highlights box (derived per-day / per-week metrics).
  const highlights = buildHighlights(totals, dayCount);
  if (highlights.length) {
    const hlList = el("ul", { class: "stats-hl-list" });
    for (const h of highlights) {
      hlList.append(el("li", { class: "stats-hl-row" },
        el("span", { class: "stats-hl-swatch", style: `background:${h.color}` }),
        el("span", { class: "stats-hl-label" }, h.label),
        el("span", { class: "stats-hl-value" }, h.value),
      ));
    }
    body.append(
      el("h3", { class: "stats-section-title" }, "Highlights"),
      el("div", { class: "stats-highlights" }, hlList),
    );
  }
  const yp = yearProgress(yearFilter);
  if (yp) {
    body.append(el("p", { class: "muted stats-year-progress" },
      `${yp.year} so far · ${yp.dayOfYear} days gone · ${yp.hoursLeft.toLocaleString()} hours left`));
  }

  body.append(el("h3", { class: "stats-section-title" }, "All categories"));
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
  body.append(list);
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
  if (btnSync) btnSync.classList.toggle("is-signed-in", isIn);
}

async function reconcileWithCloud() {
  if (!state.userId) return;
  setSyncIndicator("syncing…");
  try {
    const remote = await pullDays();
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
    } else {
      state.userId = null;
      state.userEmail = null;
      cloudState.lastSyncAt = null;
      cloudState.hasError = false;
      updateAccountUI();
      refreshSaveIndicator();
    }
  });

  document.getElementById("btn-signin")?.addEventListener("click", async () => {
    const input = document.getElementById("signin-email");
    const email = (input?.value || "").trim();
    const status = document.getElementById("signin-status");
    if (!email) { if (status) status.textContent = "Enter your email."; return; }
    if (status) status.textContent = "Sending link…";
    try {
      await signInWithEmail(email);
      if (status) status.textContent = `Check ${email} for the sign-in link.`;
    } catch (e) {
      console.error(e);
      if (status) status.textContent = `Error: ${e.message || e}`;
    }
  });
  document.getElementById("btn-signout")?.addEventListener("click", async () => {
    await signOut();
  });
}

// ---------- boot ----------
async function reload() {
  const cats = await getAllCategories(state.db);
  cats.sort((a, b) => a.id - b.id);
  state.categories = cats;
  state.catById = new Map(cats.map((c) => [c.id, c]));
  state.namesByYear = (await getMeta(state.db, "categoriesByYear")) || {};
  const days = await getAllDays(state.db);
  state.daysByIso = new Map(days.map((d) => [d.date, d]));
  renderHourHeader();
  renderYears();
  renderPalette();
  scrollToIso(todayISO());
}

async function boot() {
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
  refreshSaveIndicator();
  await initCloud();
}

boot().catch((e) => {
  console.error(e);
  document.body.append(el("pre", { style: "padding:16px;color:#f88;" }, String(e?.stack || e)));
});
