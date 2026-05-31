// Cloud sync: Supabase auth + days table reconciliation.
// Supabase is the sole source of truth — there is no local data cache;
// the page rehydrates from cloud on every load.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
// Propagate the cache-buster from app.js so config.js refreshes too.
const BUST = new URL(import.meta.url).search;
const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import(`./config.js${BUST}`);

export const cloudConfigured =
  SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== "PASTE_ANON_KEY_HERE";

export const supabase = cloudConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

// Supabase's fetch has no implicit deadline — a slept laptop or a stalled
// connection can leave a request pending forever, which strands callers that
// only decrement counters in .finally(). Race every network call against a
// timeout so the promise always settles.
const NET_TIMEOUT_MS = 15000;
function withTimeout(promise, label = "network") {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${NET_TIMEOUT_MS}ms`)), NET_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb) {
  if (!supabase) return { data: { subscription: { unsubscribe() {} } } };
  return supabase.auth.onAuthStateChange((_e, session) => cb(session));
}

export async function signInWithProvider(provider) {
  if (!supabase) throw new Error("cloud not configured");
  const redirectTo = window.location.origin + window.location.pathname;
  return supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo },
  });
}

export async function signOut() {
  if (!supabase) return;
  // scope:"local" clears this device's session without calling the server's
  // /logout endpoint. The default ("global") tries to revoke the JWT across
  // every session for this user and returns 403 if the token is stale —
  // which leaves the user stuck signed-in on the client.
  await supabase.auth.signOut({ scope: "local" });
}

export async function pullDays(sinceIso) {
  let q = supabase.from("days").select("date, hours, notes, updated_at");
  if (sinceIso) q = q.gt("updated_at", sinceIso);
  const { data, error } = await withTimeout(q, "pullDays");
  if (error) throw error;
  return data || [];
}

function dayPayload(userId, day, nowIso) {
  return {
    user_id: userId,
    date: day.date,
    hours: day.hours || new Array(24).fill(null),
    notes: day.notes || "",
    updated_at: nowIso,
  };
}

export async function pushDays(userId, days) {
  if (!days.length) return;
  const now = new Date().toISOString();
  const rows = days.map((d) => dayPayload(userId, d, d.updated_at || now));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await withTimeout(supabase.from("days").upsert(chunk), "pushDays");
    if (error) throw error;
  }
}

export async function pushDay(userId, day) {
  const payload = dayPayload(userId, day, new Date().toISOString());
  const { error } = await withTimeout(supabase.from("days").upsert(payload), "pushDay");
  if (error) throw error;
  day.updated_at = payload.updated_at;
}

// ---- categories ----
export async function pullCategories() {
  const { data, error } = await withTimeout(
    supabase.from("categories").select("id, name, color, updated_at").order("id"),
    "pullCategories"
  );
  if (error) throw error;
  return data || [];
}

function categoryPayload(userId, cat, nowIso) {
  return {
    user_id: userId,
    id: cat.id,
    name: cat.name,
    color: cat.color || null,
    updated_at: nowIso,
  };
}

export async function pushCategory(userId, cat) {
  const payload = categoryPayload(userId, cat, new Date().toISOString());
  const { error } = await withTimeout(supabase.from("categories").upsert(payload), "pushCategory");
  if (error) throw error;
  cat.updated_at = payload.updated_at;
}

export async function pushCategories(userId, cats) {
  if (!cats.length) return;
  const now = new Date().toISOString();
  const rows = cats.map((c) => categoryPayload(userId, c, c.updated_at || now));
  const { error } = await withTimeout(supabase.from("categories").upsert(rows), "pushCategories");
  if (error) throw error;
}
