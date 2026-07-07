/* Life Tracker — stacked rows view.
   Each day is a row, 24 columns are hours, years are grouped.
   Storage: local IndexedDB cache so the grid paints instantly (and offline)
   from the last known state; Supabase (see sync.js) is the source of truth
   and reconcile overlays newer cloud rows after the cached paint. */

// Bump on each user-visible release. Stamped into the topbar so a refresh
// can be verified at a glance after a Pages rebuild.
const APP_VERSION = "1.6.1";

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
// Saturated versions painted on the *lived* portion so the phase you're
// currently in (and any you've passed) reads clearly, instead of the green
// accent washing over the amber childhood band.
const LIFE_PHASE_FILL_COLORS = {
  childhood:  "#c09a35",  // warm amber
  adult:      "#1fe3a8",  // accent green
  retirement: "#b048a0",  // plum
};

// Dynamic import so the ?v=... cache-buster from index.html propagates
// down the module graph (static `import` URLs ignore the parent's query).
const BUST = new URL(import.meta.url).search;
const {
  cloudConfigured, getSession, onAuthChange,
  signInWithProvider, signOut,
  pullDays, pushDay, pushDays,
  pullCategories, pushCategory, pushCategories,
} = await import(`./sync.js${BUST}`);

// Unified palette — same hue family as the original xlsx, but consistent
// saturation/lightness so the cells read as a set. Overrides any color
// imported from the xlsx (the xlsx colors are still preserved in the DB
// under colorsByYear if we ever want them back).
const PALETTE = {
  1:  "#5a6270",  // Sleep — cool gray
  2:  "#bf4eaf",  // Work — vivid mauve-purple
  3:  "#d97a1f",  // Hobby — vivid amber
  4:  "#6fa572",  // Sorting House — sage green
  5:  "#2fa2a3",  // Party — teal
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

// ---------- local cache (IndexedDB) ----------
// Persistent read cache: days/categories/meta are mirrored in memory for
// synchronous reads and written through to IndexedDB, so the grid paints
// instantly (and offline) from the last known state on the next visit.
// Supabase stays the source of truth — reconcile/refresh overlay newer
// cloud rows after the cached paint.
const LEGACY_DB_NAME = "life-tracker"; // pre-1.6 store, deleted on boot
const DB_NAME = "life-tracker-cache";

const keyOf = (store, item) =>
  store === "days" ? item.date : store === "categories" ? item.id : item.k;
const valOf = (store, item) => (store === "meta" ? item.v : item);

function openDB() {
  return new Promise((resolve) => {
    const stores = { days: new Map(), categories: new Map(), meta: new Map() };
    const makeDB = (idb) => ({
      _stores: stores,
      _idb: idb,
      // IDB-shaped surface. Writes hit the in-memory mirror synchronously
      // and the real IndexedDB best-effort — a cache write failure must
      // never block an edit (the cloud push still runs regardless).
      transaction(names, mode = "readonly") {
        let real = null;
        if (idb) {
          try { real = idb.transaction(names, mode); }
          catch (e) { console.warn("cache tx open", e); }
        }
        return {
          _done: real
            ? new Promise((res) => {
                real.oncomplete = res;
                real.onabort = res;
                real.onerror = () => { console.warn("cache tx", real.error); res(); };
              })
            : Promise.resolve(),
          objectStore(name) {
            const m = stores[name];
            const ros = real ? real.objectStore(name) : null;
            const tryIdb = (fn) => {
              if (!ros) return;
              try { fn(ros); } catch (e) { console.warn("cache write", e); }
            };
            return {
              put(item) { m.set(keyOf(name, item), valOf(name, item)); tryIdb((s) => s.put(item)); },
              delete(key) { m.delete(key); tryIdb((s) => s.delete(key)); },
              clear() { m.clear(); tryIdb((s) => s.clear()); },
            };
          },
        };
      },
    });
    if (typeof indexedDB === "undefined") { resolve(makeDB(null)); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "date" });
      if (!db.objectStoreNames.contains("categories")) db.createObjectStore("categories", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "k" });
    };
    req.onerror = () => {
      console.warn("cache open failed — running memory-only", req.error);
      resolve(makeDB(null));
    };
    req.onsuccess = () => {
      const idb = req.result;
      // Hydrate the in-memory mirror so all reads stay synchronous.
      try {
        const t = idb.transaction(["days", "categories", "meta"]);
        const read = (name) =>
          new Promise((res, rej) => {
            const r = t.objectStore(name).getAll();
            r.onsuccess = () => res(r.result || []);
            r.onerror = () => rej(r.error);
          });
        Promise.all([read("days"), read("categories"), read("meta")])
          .then(([days, cats, metas]) => {
            for (const d of days) stores.days.set(d.date, d);
            for (const c of cats) stores.categories.set(c.id, c);
            for (const m of metas) stores.meta.set(m.k, m.v);
            resolve(makeDB(idb));
          })
          .catch((e) => { console.warn("cache hydrate failed", e); resolve(makeDB(idb)); });
      } catch (e) {
        console.warn("cache hydrate failed", e);
        resolve(makeDB(idb));
      }
    };
  });
}

function txDone(t) { return (t && t._done) || Promise.resolve(); }

async function bulkPut(db, store, items) {
  const t = db.transaction([store], "readwrite");
  const os = t.objectStore(store);
  for (const it of items) os.put(it);
  await txDone(t);
}

async function getMeta(db, k) { return db._stores.meta.get(k); }
async function setMeta(db, k, v) {
  const t = db.transaction(["meta"], "readwrite");
  t.objectStore("meta").put({ k, v });
  await txDone(t);
}
async function getAllCategories(db) {
  return Array.from(db._stores.categories.values());
}
async function getAllDays(db) {
  return Array.from(db._stores.days.values());
}
async function putDay(db, day) {
  const t = db.transaction(["days"], "readwrite");
  t.objectStore("days").put(day);
  await txDone(t);
}

// One-time cleanup: drop the IndexedDB from versions before 1.6 — it has a
// different schema than the current cache DB. (The pending-push queue uses
// a *different* database name, so running this on every boot doesn't touch
// the queue, and DB_NAME above is new so the cache survives too.)
function deleteLegacyIDB() {
  try {
    if (typeof indexedDB === "undefined" || !indexedDB.deleteDatabase) return;
    indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch (e) {
    console.warn("legacy IDB cleanup failed", e);
  }
}

// ---------- pending-push queue (IDB) ----------
// Write-ahead log for edits we owe the cloud. NOT a read cache: rendering
// always pulls from Supabase. The queue exists only so a timed-out push
// followed by a tab close doesn't lose data — on next boot we replay it.
const QUEUE_DB = "life-tracker-pending";
const QUEUE_STORE = "pending";

function openQueue() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { resolve(null); return; }
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE))
        db.createObjectStore(QUEUE_STORE, { keyPath: "date" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { console.warn("queue open failed", req.error); resolve(null); };
  });
}

function queueTxDone(t) {
  return new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

async function queueWrite(day) {
  if (!state.queue || !day) return;
  try {
    const t = state.queue.transaction([QUEUE_STORE], "readwrite");
    t.objectStore(QUEUE_STORE).put({
      date: day.date,
      hours: day.hours,
      notes: day.notes,
      updated_at: day.updated_at,
      uid: state.userId, // so another user's sign-in never replays these
    });
    await queueTxDone(t);
  } catch (e) { console.warn("queue write", e); }
}

async function queueDelete(date) {
  if (!state.queue) return;
  try {
    const t = state.queue.transaction([QUEUE_STORE], "readwrite");
    t.objectStore(QUEUE_STORE).delete(date);
    await queueTxDone(t);
  } catch (e) { console.warn("queue delete", e); }
}

async function queueClear() {
  if (!state.queue) return;
  try {
    const t = state.queue.transaction([QUEUE_STORE], "readwrite");
    t.objectStore(QUEUE_STORE).clear();
    await queueTxDone(t);
  } catch (e) { console.warn("queue clear", e); }
}

async function queueAll() {
  if (!state.queue) return [];
  try {
    const t = state.queue.transaction([QUEUE_STORE]);
    return await new Promise((res, rej) => {
      const req = t.objectStore(QUEUE_STORE).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  } catch (e) { console.warn("queue read", e); return []; }
}

// ---------- seed ----------
// Loads category names + per-year overrides from seed.json into the
// in-memory store. Day data is never seeded — historical hours live
// per-user in Supabase. Visitors who aren't signed in see an empty grid
// with the palette ready.
async function maybeSeed(db) {
  // A populated cache means a previous visit already merged cloud
  // categories (possibly with custom names/colors) — don't stomp them
  // with seed defaults on every boot.
  const haveCats = db._stores.categories.size > 0;
  const haveMeta = db._stores.meta.has("categoriesByYear");
  if (haveCats && haveMeta) return false;
  let seed;
  try {
    const res = await fetch("data/seed.json", { cache: "no-store" });
    if (!res.ok) { console.warn("seed http", res.status); return false; }
    seed = await res.json();
  } catch (e) {
    console.warn("seed fetch failed:", e);
    return false;
  }
  if (!haveCats) {
    const cats = Object.entries(seed.categories || {}).map(([id, name]) => ({
      id: Number(id),
      name,
      color: colorFor(Number(id)),
    }));
    if (cats.length) await bulkPut(db, "categories", cats);
  }
  if (!haveMeta) {
    await setMeta(db, "categoriesByYear", seed.categoriesByYear || {});
    await setMeta(db, "colorsByYear", seed.colorsByYear || {});
  }
  return false;
}

// ---------- demo mode ----------
// Click the "Oscar" word in the header to swap in synthetic data for
// showing the app to people without exposing real life. Demo edits are
// in-memory only — scheduleSave / cloud sync are gated by demoActive so
// nothing leaks into Supabase.
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
  applyBrand();

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
  queue: null,             // IDB handle for the pending-push queue (see below)
  categories: [],          // [{id, name, color}]
  catById: new Map(),      // id -> {id, name, color}
  namesByYear: {},         // {"2023": {"5": "Relationship", ...}, ...}
  daysByIso: new Map(),    // iso -> day record
  rowEls: new Map(),       // iso -> rowEl
  cellEls: new Map(),      // `${iso}#${h}` -> cellEl
  yearSections: new Map(), // year(number) -> sectionEl
  activeYear: null,        // number
  activeCat: null,
  paint: { active: false, button: 0 },
  userId: null,            // supabase auth user id when signed in
  userEmail: null,
  userName: null,          // display name from OAuth metadata, used as brand
};

// Default brand word when no one is signed in — matches the static HTML.
const DEFAULT_BRAND = "Oscar";

// Pull a friendly first name out of the Supabase user record. Google OAuth
// populates user_metadata.given_name; other providers may only give
// full_name or name. Falls back to the local-part of the email.
function deriveUserName(user) {
  if (!user) return null;
  const m = user.user_metadata || {};
  const first = (s) => String(s).trim().split(/\s+/)[0];
  return (
    m.given_name ||
    (m.name && first(m.name)) ||
    (m.full_name && first(m.full_name)) ||
    (user.email && user.email.split("@")[0]) ||
    null
  );
}

// Single source of truth for the topbar word and the tab title. Demo mode
// wins (so the "DEMO" affordance stays obvious); otherwise it's the signed-in
// user's first name, or the default brand when signed out.
function applyBrand() {
  const name = demoActive ? "DEMO" : (state.userName || DEFAULT_BRAND);
  const word = document.querySelector(".brand .word");
  if (word) word.textContent = name;
  document.title = `${name}, Life Tracker`;
}

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
        cell.classList.remove("run-not-first", "run-not-last");
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
      cell.classList.toggle("run-not-first", k > i);
      cell.classList.toggle("run-not-last", k < j - 1);
      cell.textContent = icon || String(v);
      cell.title = label;
      cell.style.color = fg;
      cell.style.background = grad;
      cell.style.backgroundSize = "2400% 100%";
      cell.style.backgroundPosition = `${(k / 23) * 100}% 0`;
      cell.style.backgroundRepeat = "no-repeat";
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
  const today = todayISO();
  const currentYear = Number(today.slice(0, 4));
  const dataMin = allIsos.length ? Number(allIsos[0].slice(0, 4)) : currentYear;
  const dataMax = allIsos.length ? Number(allIsos[allIsos.length - 1].slice(0, 4)) : currentYear;
  const lsMin = Number(localStorage.getItem("lt.userYearMin"));
  const lsMax = Number(localStorage.getItem("lt.userYearMax"));
  const firstYear = Math.min(dataMin, lsMin || currentYear, currentYear);
  const lastYear = Math.max(dataMax, lsMax || currentYear, currentYear);

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

// Edit-mode flag controlled by the Edit/Done button in the palette header.
// When true, names become editable text inputs and swatches become native
// color pickers; row clicks no longer change the active category.
let paletteEditing = false;

function renderPalette() {
  const ul = document.getElementById("palette-list");
  ul.replaceChildren();
  for (const c of state.categories) {
    const swatchEl = paletteEditing
      ? el("input", {
          type: "color",
          class: "swatch swatch-edit",
          value: c.color,
          title: "Change color",
          onchange: (e) => commitColorEdit(c.id, e.target.value),
          onclick: (e) => e.stopPropagation(),
        })
      : el("span", { class: "swatch", style: `background:${gradientFor(c.color)}` });

    const nameEl = paletteEditing
      ? el("input", {
          type: "text",
          class: "name name-edit",
          value: c.name,
          "aria-label": `Rename category ${c.id}`,
          onblur: (e) => commitNameEdit(c.id, e.target.value),
          onkeydown: (e) => {
            if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
            else if (e.key === "Escape") { e.preventDefault(); e.target.value = c.name; e.target.blur(); }
          },
          onclick: (e) => e.stopPropagation(),
        })
      : el("span", { class: "name", title: c.name },
          iconFor(c.id) ? `${iconFor(c.id)} ${c.name}` : c.name);

    ul.append(el("li", {
      class: "cat",
      "aria-pressed": String(state.activeCat === c.id),
      dataset: { id: String(c.id) },
      onclick: () => { if (!paletteEditing) setActiveCat(c.id); },
    },
      el("span", { class: "id" }, c.id),
      swatchEl,
      nameEl,
    ));
  }
  renderActiveCat();
}

function togglePaletteEdit() {
  // Commit any in-flight edit before tearing down inputs.
  if (paletteEditing && document.activeElement?.classList?.contains?.("name-edit")) {
    document.activeElement.blur();
  }
  paletteEditing = !paletteEditing;
  document.body.classList.toggle("palette-editing", paletteEditing);
  const btn = document.getElementById("palette-edit-btn");
  if (btn) {
    btn.textContent = paletteEditing ? "Done" : "Edit";
    btn.setAttribute("aria-pressed", String(paletteEditing));
  }
  renderPalette();
}

async function persistCategory(cat) {
  state.catById.set(cat.id, cat);
  const idx = state.categories.findIndex((c) => c.id === cat.id);
  if (idx >= 0) state.categories[idx] = cat;
  try {
    await bulkPut(state.db, "categories", [cat]);
  } catch (e) {
    console.error("save category", e);
  }
}

// Repaint every row that uses this category so cell colors/tooltips
// reflect the change immediately.
function repaintCategoryUsage(catId) {
  for (const [iso, day] of state.daysByIso) {
    if (day.hours?.some((h) => h === catId)) styleRowRuns(iso);
  }
}

async function commitNameEdit(catId, newName) {
  if (demoActive) return;
  newName = (newName || "").trim();
  const cat = state.catById.get(catId);
  if (!cat || !newName || newName === cat.name) return;
  cat.name = newName;
  cat.updated_at = new Date().toISOString();
  await persistCategory(cat);
  repaintCategoryUsage(catId);
  if (state.userId) pushCategoryToCloud(cat);
}

async function commitColorEdit(catId, newColor) {
  if (demoActive) return;
  const cat = state.catById.get(catId);
  if (!cat || !newColor || newColor === cat.color) return;
  cat.color = newColor;
  cat.updated_at = new Date().toISOString();
  state.catById.set(catId, cat);
  const idx = state.categories.findIndex((c) => c.id === catId);
  if (idx >= 0) state.categories[idx] = cat;
  repaintCategoryUsage(catId);
  try { await bulkPut(state.db, "categories", [cat]); }
  catch (e) { console.error("save category", e); }
  if (state.userId) pushCategoryToCloud(cat);
}

async function resetPaletteColors() {
  if (demoActive) return;
  if (!confirm("Reset all category colors to defaults?")) return;
  const updated = [];
  const now = new Date().toISOString();
  for (const c of state.categories) {
    const def = colorFor(c.id);
    if (c.color !== def) {
      c.color = def;
      c.updated_at = now;
      state.catById.set(c.id, c);
      updated.push(c);
    }
  }
  if (!updated.length) return;
  try { await bulkPut(state.db, "categories", updated); }
  catch (e) { console.error("reset colors", e); }
  renderPalette();
  const updatedIds = new Set(updated.map((c) => c.id));
  for (const [iso, day] of state.daysByIso) {
    if (day.hours?.some((h) => updatedIds.has(h))) styleRowRuns(iso);
  }
  if (state.userId && !demoActive) {
    try { await pushCategories(state.userId, updated); }
    catch (e) { console.warn("push reset colors", e); }
  }
}

// Fire-and-forget cloud push for a single category. Errors are logged but
// don't surface — the local change is already persisted, and the next
// reconcileCategoriesWithCloud will re-push anything newer than remote.
async function pushCategoryToCloud(cat) {
  if (demoActive || !state.userId) return;
  try { await pushCategory(state.userId, cat); }
  catch (e) { console.warn("push category", cat.id, e); }
}

// On sign-in: pull the user's category overrides from Supabase. First-time
// users have no rows yet — push the local defaults (from seed.json) so the
// cloud has a baseline they can edit from any device.
async function reconcileCategoriesWithCloud() {
  if (!state.userId || demoActive) return;
  let remote;
  try { remote = await pullCategories(); }
  catch (e) { console.warn("pullCategories", e); return; }

  if (remote.length === 0) {
    if (state.categories.length) {
      try { await pushCategories(state.userId, state.categories); }
      catch (e) { console.warn("seed categories to cloud", e); }
    }
    return;
  }

  const byId = new Map(remote.map((r) => [r.id, r]));
  const toPush = [];
  let changed = false;

  for (const local of state.categories) {
    const r = byId.get(local.id);
    if (!r) { toPush.push(local); continue; }
    const localT = Date.parse(local.updated_at || 0) || 0;
    const remoteT = Date.parse(r.updated_at) || 0;
    if (remoteT > localT) {
      local.name = r.name || local.name;
      local.color = r.color || local.color;
      local.updated_at = r.updated_at;
      state.catById.set(local.id, local);
      changed = true;
    } else if (localT > remoteT) {
      toPush.push(local);
    }
  }
  // Categories that exist only in the cloud — covers future "Add category"
  // support and devices that haven't run maybeSeed yet for new defaults.
  for (const r of remote) {
    if (state.catById.has(r.id)) continue;
    const cat = {
      id: r.id,
      name: r.name,
      color: r.color || colorFor(r.id),
      updated_at: r.updated_at,
    };
    state.categories.push(cat);
    state.catById.set(cat.id, cat);
    changed = true;
  }

  if (changed) {
    state.categories.sort((a, b) => a.id - b.id);
    try { await bulkPut(state.db, "categories", state.categories); }
    catch (e) { console.warn("save categories to store", e); }
    renderPalette();
    // Cell colors and tooltips depend on category data, so repaint everywhere.
    for (const iso of state.daysByIso.keys()) styleRowRuns(iso);
  }
  if (toPush.length) {
    try { await pushCategories(state.userId, toPush); }
    catch (e) { console.warn("push local categories", e); }
  }
}

function renderActiveCat() {
  // The topbar chip was removed — the active category is now indicated by
  // the highlighted row in the palette. Kept as a no-op shim because
  // setActiveCat still calls this; cheaper than scrubbing every call site.
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
// Mirrored into the IDB queue (queueWrite / queueDelete) so a timed-out
// push survives a tab close — on next boot the queue is replayed before
// reconcile. The indicator reads .size as "needs uploading" regardless
// of whether a push is currently in flight.
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
async function markPending(iso) {
  cloudPending.add(iso);
  await queueWrite(state.daysByIso.get(iso));
}
async function markSynced(iso) {
  cloudPending.delete(iso);
  await queueDelete(iso);
}

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
    el.title = "Save failed. Your changes may not have been written.";
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
      el.title = `Last cloud sync: ${d.toLocaleString()}\nSafe to close, your data is in Supabase.`;
      return;
    }
    el.classList.add("ok-cloud");
    if (lbl) lbl.textContent = "signed in";
    el.title = "Cloud connected, no changes yet this session.";
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
  // Editing requires sign-in (or demo mode). Without a session there is
  // nowhere to persist the change, so the edit would silently vanish on
  // refresh — block it outright instead.
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
  document.getElementById("year-select").addEventListener("change", (e) =>
    activateYear(Number(e.target.value)));
  document.getElementById("btn-year-earlier").addEventListener("click", () =>
    extendYearRange("earlier"));
  document.getElementById("btn-year-later").addEventListener("click", () =>
    extendYearRange("later"));
}

function extendYearRange(direction) {
  const allIsos = [...state.daysByIso.keys()].sort();
  const currentYear = Number(todayISO().slice(0, 4));
  const dataMin = allIsos.length ? Number(allIsos[0].slice(0, 4)) : currentYear;
  const dataMax = allIsos.length ? Number(allIsos[allIsos.length - 1].slice(0, 4)) : currentYear;
  const lsMin = Number(localStorage.getItem("lt.userYearMin"));
  const lsMax = Number(localStorage.getItem("lt.userYearMax"));
  const curMin = Math.min(dataMin, lsMin || currentYear, currentYear);
  const curMax = Math.max(dataMax, lsMax || currentYear, currentYear);
  const target = direction === "earlier" ? curMin - 1 : curMax + 1;
  localStorage.setItem(
    direction === "earlier" ? "lt.userYearMin" : "lt.userYearMax",
    String(target)
  );
  renderYears();
  activateYear(target);
}

async function exportPayload() {
  return {
    exportedAt: new Date().toISOString(),
    categories: await getAllCategories(state.db),
    days: await getAllDays(state.db),
  };
}

// ---------- automatic backup (File System Access) ----------
// Once per day, writes a dated JSON export (same shape as the manual
// Export button) into a user-chosen folder — point it at Dropbox and
// there's always an offline copy independent of Supabase. The folder
// handle persists in the meta store; Chrome can remember the permission
// ("Allow on every visit"), after which backups run silently.
const BACKUP_DIR_KEY = "backupDir";      // FileSystemDirectoryHandle
const BACKUP_LAST_KEY = "lastBackupDay"; // "YYYY-MM-DD" of last successful write
const BACKUP_KEEP = 60;                  // dated files retained before pruning

const backupSupported = () => "showDirectoryPicker" in window;
let backupRetryArmed = false;

// Backups go in a LifeTracker/Backups subfolder of the picked folder, so
// pointing the picker at the Dropbox root doesn't litter it with dated
// files. Subfolder handles inherit the stored permission, so this needs
// no re-grant. Picking the subfolder itself directly also works.
async function resolveBackupDir(dir) {
  if (dir.name === "Backups") return dir;
  const parent = dir.name === "LifeTracker"
    ? dir
    : await dir.getDirectoryHandle("LifeTracker", { create: true });
  return parent.getDirectoryHandle("Backups", { create: true });
}

const backupDirLabel = (dir) =>
  dir.name === "Backups" ? dir.name
  : dir.name === "LifeTracker" ? "LifeTracker/Backups"
  : `${dir.name}/LifeTracker/Backups`;

function setBackupStatus(text) {
  const s = document.getElementById("backup-status");
  if (s) s.textContent = text || "";
}

async function updateBackupStatus() {
  if (!backupSupported()) {
    setBackupStatus("Not supported in this browser. Use Chrome or Edge on desktop.");
    return;
  }
  const dir = await getMeta(state.db, BACKUP_DIR_KEY);
  if (!dir) { setBackupStatus("No folder chosen yet."); return; }
  const last = await getMeta(state.db, BACKUP_LAST_KEY);
  let perm = "denied";
  try { perm = await dir.queryPermission({ mode: "readwrite" }); } catch (e) { /* gone */ }
  const lastTxt = last ? `Last backup: ${last}.` : "No backup written yet.";
  setBackupStatus(
    perm === "granted"
      ? `Backing up daily to “${backupDirLabel(dir)}”. ${lastTxt}`
      : `Folder “${dir.name}” needs permission, click “Back up now” to re-grant. ${lastTxt}`
  );
}

// interactive=true only from a click handler — requestPermission needs a
// user gesture. Non-interactive calls that hit a "prompt" permission arm a
// one-time retry on the next click anywhere, so the daily backup still
// happens with at most one permission prompt.
async function runAutoBackup({ force = false, interactive = false } = {}) {
  if (!backupSupported() || demoActive || !state.userId) return;
  const dir = await getMeta(state.db, BACKUP_DIR_KEY);
  if (!dir) return;
  const today = todayISO();
  if (!force && (await getMeta(state.db, BACKUP_LAST_KEY)) === today) return;
  let perm = "denied";
  try {
    perm = await dir.queryPermission({ mode: "readwrite" });
    if (perm === "prompt" && interactive) perm = await dir.requestPermission({ mode: "readwrite" });
  } catch (e) { console.warn("backup permission", e); }
  if (perm !== "granted") {
    if (perm === "prompt" && !backupRetryArmed) {
      backupRetryArmed = true;
      window.addEventListener("pointerdown", () => {
        backupRetryArmed = false;
        runAutoBackup({ interactive: true });
      }, { once: true });
    }
    updateBackupStatus();
    return;
  }
  try {
    const payload = await exportPayload();
    // Never write a file that records an empty grid — a failed cloud pull
    // must not produce a "backup" with no days in it.
    const tracked = payload.days.some((d) =>
      (Array.isArray(d.hours) && d.hours.some((h) => h != null)) || d.notes);
    if (!tracked) { console.warn("backup skipped — no tracked days in memory"); return; }
    const out = await resolveBackupDir(dir);
    const fh = await out.getFileHandle(`life-tracker-${today}.json`, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(payload, null, 2));
    await w.close();
    await setMeta(state.db, BACKUP_LAST_KEY, today);
    await pruneBackups(out);
    updateBackupStatus();
  } catch (e) {
    console.warn("backup failed", e);
    setBackupStatus(`Backup failed: ${e.message || e}`);
  }
}

async function pruneBackups(dir) {
  try {
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && /^life-tracker-\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
        names.push(name);
      }
    }
    names.sort(); // ISO-dated names sort chronologically
    for (const name of names.slice(0, Math.max(0, names.length - BACKUP_KEEP))) {
      await dir.removeEntry(name);
    }
  } catch (e) { console.warn("backup prune", e); }
}

function wireSync() {
  const dlg = document.getElementById("sync-dialog");
  document.getElementById("btn-sync").addEventListener("click", () => {
    updateBackupStatus();
    dlg.showModal();
  });

  document.getElementById("btn-export").addEventListener("click", async () => {
    const payload = await exportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `life-tracker-${todayISO()}.json`;
    document.body.append(a); a.click(); a.remove();
    document.getElementById("sync-status").textContent = `Exported ${payload.days.length} days.`;
  });

  document.getElementById("btn-backup-folder")?.addEventListener("click", async () => {
    if (!backupSupported()) { updateBackupStatus(); return; }
    try {
      const dir = await window.showDirectoryPicker({ id: "lt-backup", mode: "readwrite" });
      await setMeta(state.db, BACKUP_DIR_KEY, dir);
      await runAutoBackup({ force: true, interactive: true });
    } catch (e) {
      if (e?.name !== "AbortError") {
        console.warn(e);
        setBackupStatus(`Couldn't set folder: ${e.message || e}`);
      }
    }
  });
  document.getElementById("btn-backup-now")?.addEventListener("click", () =>
    runAutoBackup({ force: true, interactive: true }));
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

  // Custom hover tooltip — shows immediately and styles to match the app,
  // unlike the native <title> tooltip which has a long delay and uses the
  // OS chrome. The <title> elements stay for screen readers + fallback.
  const tooltip = el("div", { class: "pie-tooltip", role: "tooltip" });
  const wrap = el("div", { class: "stats-pie-wrap" }, svg, tooltip);

  const showTip = (seg) => {
    const pct = total > 0 ? ((seg.value / total) * 100) : 0;
    const pctText = pct >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    tooltip.replaceChildren(
      el("span", { class: "pie-tip-swatch", style: `background:${seg.color}` }),
      el("span", { class: "pie-tip-label" }, seg.label),
      el("span", { class: "pie-tip-value" }, `${seg.value.toLocaleString()} h · ${pctText}%`),
    );
    tooltip.classList.add("visible");
  };
  const moveTip = (e) => {
    const rect = wrap.getBoundingClientRect();
    // Position past the cursor; if it would overflow the wrap on the right,
    // flip to the left of the cursor so it stays visible.
    const pad = 14;
    const w = tooltip.offsetWidth || 140;
    const h = tooltip.offsetHeight || 40;
    let x = e.clientX - rect.left + pad;
    let y = e.clientY - rect.top + pad;
    if (x + w > rect.width) x = e.clientX - rect.left - pad - w;
    if (y + h > rect.height) y = e.clientY - rect.top - pad - h;
    tooltip.style.left = Math.max(0, x) + "px";
    tooltip.style.top = Math.max(0, y) + "px";
  };
  const hideTip = () => tooltip.classList.remove("visible");
  const wireHover = (node, seg) => {
    node.addEventListener("mouseenter", () => showTip(seg));
    node.addEventListener("mousemove", moveTip);
    node.addEventListener("mouseleave", hideTip);
  };

  if (total === 0) {
    svg.append(svgEl("circle", { cx, cy, r, fill: "rgba(255,255,255,0.05)" }));
    return wrap;
  }
  // Single-segment case: full circle.
  if (segments.length === 1) {
    const c = svgEl("circle", { cx, cy, r, fill: segments[0].color });
    const t = svgEl("title");
    t.textContent = `${segments[0].label}: 100%`;
    c.appendChild(t);
    svg.appendChild(c);
    wireHover(c, segments[0]);
    return wrap;
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
    t.textContent = `${seg.label}: ${seg.value.toLocaleString()} h (${pct}%)`;
    path.appendChild(t);
    svg.appendChild(path);
    wireHover(path, seg);
    angle = end;
  }
  return wrap;
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
    // Freshly merged with the cloud — best moment for the daily backup.
    // Fire-and-forget; it self-gates to once per day.
    runAutoBackup();
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
      runAutoBackup(); // no-op until the date rolls over
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

// Set by the Sign out button so onAuthChange can tell a user-initiated
// sign-out (wipe this device's copy) from an involuntary one like a failed
// token refresh after a long sleep (keep the cache AND the pending queue —
// wiping those on an expired session is how unpushed edits used to vanish).
let explicitSignOut = false;

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
    state.userName = deriveUserName(session.user);
    applyBrand();
    updateAccountUI();
    refreshSaveIndicator();
    await reconcileCategoriesWithCloud();
    await reconcileWithCloud();
    // First load rendered before the cloud pull completed. Rebuild from
    // the just-merged state so days are visible without a second refresh
    // — covers fresh sign-ins and rows we didn't have in memory yet.
    renderYears();
    scrollToIso(todayISO());
    flushPending();
    startBackgroundRefresh();
  } else {
    updateAccountUI();
    refreshSaveIndicator();
  }
  onAuthChange(async (s) => {
    if (s) {
      // Supabase fires this on INITIAL_SESSION and every TOKEN_REFRESHED
      // too, not just on a fresh sign-in. Rebuilding state for the same
      // user would blank-and-refill the grid (and re-reconcile) for no
      // reason — only run the heavy path when the user actually changed.
      const sameUser = state.userId === s.user.id;
      state.userId = s.user.id;
      state.userEmail = s.user.email;
      state.userName = deriveUserName(s.user);
      applyBrand();
      updateAccountUI();
      refreshSaveIndicator();
      if (sameUser) return;
      // reload() picks up the pending-push queue — without it, a queue
      // written before sign-in would stay stranded in IDB.
      await reload();
      await reconcileCategoriesWithCloud();
      await reconcileWithCloud();
      renderYears();
      scrollToIso(todayISO());
      flushPending();
      startBackgroundRefresh();
    } else {
      const explicit = explicitSignOut;
      explicitSignOut = false;
      state.userId = null;
      state.userEmail = null;
      state.userName = null;
      applyBrand();
      cloudState.lastSyncAt = null;
      cloudState.hasError = false;
      cloudState.maxUpdatedAt = null;
      stopBackgroundRefresh();
      if (explicit) {
        // The user asked to sign out: clear this device's copy.
        cloudPending.clear();
        await queueClear();
        state.daysByIso = new Map();
        const clearT = state.db.transaction(["days"], "readwrite");
        clearT.objectStore("days").clear();
        await txDone(clearT);
        renderYears();
        scrollToIso(todayISO());
      }
      // Involuntary sign-out (expired/failed token refresh): keep the
      // cache and the pending-push queue. The sign-in overlay appears and
      // everything — including unpushed edits — resumes on next sign-in.
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
    explicitSignOut = true;
    try { await signOut(); } catch (e) { console.warn("signOut error", e); }
    document.getElementById("sync-dialog")?.close();
  });
  document.getElementById("btn-refresh")?.addEventListener("click", async () => {
    await refreshFromCloud(false);
  });
  document.getElementById("btn-clear-cache")?.addEventListener("click", async () => {
    if (!confirm("Drop the local cache and re-pull everything from the cloud? Unsaved edits in this tab will be lost.")) return;
    setSyncIndicator("reloading…");
    try {
      // Drop the cached days + categories and the pending-push queue,
      // then re-seed categories from seed.json and re-pull everything
      // from Supabase. Meta (per-year overrides) is reloaded by maybeSeed.
      const t = state.db.transaction(["days", "categories"], "readwrite");
      t.objectStore("days").clear();
      t.objectStore("categories").clear();
      await txDone(t);
      state.daysByIso = new Map();
      cloudPending.clear();
      await queueClear();
      cloudState.lastSyncAt = null;
      cloudState.maxUpdatedAt = null;
      cloudState.hasError = false;
      // Reseed category defaults so the palette isn't empty before the
      // cloud reconcile completes.
      await maybeSeed(state.db);
      await reload();
      if (state.userId && !demoActive) {
        await reconcileCategoriesWithCloud();
        await reconcileWithCloud();
        renderYears();
        scrollToIso(todayISO());
        setSyncIndicator("re-pulled from cloud");
      } else {
        renderYears();
        setSyncIndicator("reloaded");
      }
      setTimeout(() => setSyncIndicator(""), 2500);
    } catch (e) {
      console.error("re-pull failed", e);
      setSyncIndicator("reload failed");
    }
  });
}

// ---------- boot ----------
// Days are only surfaced when the user has a Supabase session — without
// auth the grid stays blank. With a session, the local IndexedDB cache
// paints the last known state immediately (even offline), the pending-push
// queue (unconfirmed edits) is replayed on top, and cloud reconcile then
// overlays anything newer.
async function reload() {
  const cats = await getAllCategories(state.db);
  cats.sort((a, b) => a.id - b.id);
  state.categories = cats;
  state.catById = new Map(cats.map((c) => [c.id, c]));
  state.namesByYear = (await getMeta(state.db, "categoriesByYear")) || {};
  state.daysByIso = new Map();
  cloudPending.clear();
  const session = cloudConfigured ? await getSession() : null;
  if (session) {
    for (const d of await getAllDays(state.db)) state.daysByIso.set(d.date, d);
    // Replay any unconfirmed edits from a previous session so the user
    // sees them immediately. reconcileWithCloud will push them when it
    // runs (last-write-wins by updated_at), and flushPending retries
    // anything still in the queue afterwards.
    const queued = await queueAll();
    for (const entry of queued) {
      // Entries tagged with another user's id (someone else signed in on
      // this browser) must not leak into this account. Untagged entries
      // predate uid-tagging and are safe to replay.
      if (entry.uid && entry.uid !== session.user.id) continue;
      state.daysByIso.set(entry.date, {
        date: entry.date,
        day: dowShort(entry.date),
        hours: entry.hours,
        notes: entry.notes,
        updated_at: entry.updated_at,
      });
      cloudPending.add(entry.date);
    }
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

  // Paint the fill with the same phase boundaries (in saturated form) and
  // scale the gradient up so the stops line up with the full track. The
  // visible fill then shows just the prefix of that gradient.
  const f = LIFE_PHASE_FILL_COLORS;
  fill.style.background =
    `linear-gradient(90deg,` +
    ` ${f.childhood} 0%, ${f.childhood} ${childPct}%,` +
    ` ${f.adult} ${childPct}%, ${f.adult} ${retirePct}%,` +
    ` ${f.retirement} ${retirePct}%, ${f.retirement} 100%)`;
  fill.style.backgroundSize = pct > 0 ? `${(100 / pct) * 100}% 100%` : "100% 100%";
  fill.style.backgroundPosition = "0 0";
  fill.style.boxShadow = "none"; // green accent shadow would muddy the amber

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
    `Four Thousand Weeks: ${fmt(w)} lived, ${fmt(remaining)} remaining ` +
    `(${pct.toFixed(2)}%). Born ${DOB}. ` +
    `Phases: childhood 0 to ${LIFE_PHASES.childhoodEndAge}, ` +
    `retirement ${LIFE_PHASES.retirementStartAge}+. ` +
    `Currently: ${phase}.`;

  // Decade age markers (10, 20, …) — thin slivers laid over the track.
  track.querySelectorAll(".life-bar-tick").forEach((t) => t.remove());
  const lifespanYears = LIFE_TOTAL_WEEKS / weeksPerYear;
  for (let age = 10; age < lifespanYears; age += 10) {
    const left = (age * weeksPerYear / LIFE_TOTAL_WEEKS) * 100;
    const tick = document.createElement("span");
    tick.className = "life-bar-tick";
    tick.style.left = left.toFixed(3) + "%";
    track.appendChild(tick);
  }
}

async function boot() {
  const vEl = document.getElementById("app-version");
  if (vEl) vEl.textContent = `v${APP_VERSION}`;
  renderLifeBar();
  deleteLegacyIDB();
  state.db = await openDB();
  state.queue = await openQueue();
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
  document.getElementById("palette-edit-btn")?.addEventListener("click", togglePaletteEdit);
  document.getElementById("palette-reset-btn")?.addEventListener("click", resetPaletteColors);
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
