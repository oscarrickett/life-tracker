// Cloud sync: Supabase auth + days table reconciliation.
// Local IndexedDB stays the always-on cache; Supabase is the cross-device source.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const cloudConfigured =
  SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== "PASTE_ANON_KEY_HERE";

export const supabase = cloudConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

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
  const { data, error } = await q;
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
    const { error } = await supabase.from("days").upsert(chunk);
    if (error) throw error;
  }
}

export async function pushDay(userId, day) {
  const payload = dayPayload(userId, day, new Date().toISOString());
  const { error } = await supabase.from("days").upsert(payload);
  if (error) throw error;
  day.updated_at = payload.updated_at;
}
