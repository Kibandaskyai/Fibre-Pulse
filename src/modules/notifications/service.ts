/**
 * The signed-in person's notification inbox and preferences. Delivery rules
 * live in the database: muted types are dropped on insert, and email/SMS
 * copies are queued in notification_outbox for a future delivery worker.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { NOTIFICATION_TYPES } from "@/lib/validation/operations";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };
export type NotificationRow = { id: string; type: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };
export type Preference = { type: string; in_app: boolean; email: boolean; sms: boolean };

export async function listNotifications(db: SupabaseClient, userId: string, f: { unread: boolean; page: number }, pageSize = 30) {
  let q = db.from("notifications").select("id, type, title, body, link, read_at, created_at", { count: "exact" }).eq("recipient_id", userId);
  if (f.unread) q = q.is("read_at", null);
  const from = (f.page - 1) * pageSize;
  const { data, count } = await q.order("created_at", { ascending: false }).range(from, from + pageSize - 1);
  return { rows: (data ?? []) as NotificationRow[], total: count ?? 0 };
}

export async function markRead(db: SupabaseClient, userId: string, ids: string[] | "all"): Promise<Result<number>> {
  let q = db.from("notifications").update({ read_at: new Date().toISOString() }).eq("recipient_id", userId).is("read_at", null);
  if (ids !== "all") q = q.in("id", ids);
  const { data, error } = await q.select("id");
  if (error) return { ok: false, message: friendlyDbError(error, "Could not mark notifications read.") };
  return { ok: true, data: data?.length ?? 0 };
}

const DEFAULT: Omit<Preference, "type"> = { in_app: true, email: false, sms: false };

/** Every type with the person's own choice, plus whether the ISP has turned it off for everyone. */
export async function preferences(db: SupabaseClient, tenantId: string, userId: string) {
  const { data } = await db.from("notification_preferences").select("profile_id, type, in_app, email, sms").eq("tenant_id", tenantId);
  const rows = (data ?? []) as (Preference & { profile_id: string | null })[];
  return NOTIFICATION_TYPES.map(([type, label]) => {
    const mine = rows.find((r) => r.profile_id === userId && r.type === type);
    const isp = rows.find((r) => r.profile_id === null && r.type === type);
    return { type, label, mine: mine ? { in_app: mine.in_app, email: mine.email, sms: mine.sms } : DEFAULT, ispOff: isp ? !isp.in_app : false };
  });
}

export async function savePreferences(db: SupabaseClient, tenantId: string, profileId: string | null, prefs: Preference[]): Promise<Result<null>> {
  // Replace this person's (or the ISP's) rows in one go.
  const del = db.from("notification_preferences").delete().eq("tenant_id", tenantId);
  const { error: delError } = await (profileId ? del.eq("profile_id", profileId) : del.is("profile_id", null));
  if (delError) return { ok: false, message: friendlyDbError(delError, "Could not save your choices.") };
  const changed = profileId ? prefs.filter((p) => !p.in_app || p.email || p.sms) : prefs.filter((p) => !p.in_app);
  if (!changed.length) return { ok: true, data: null };
  const { error } = await db
    .from("notification_preferences")
    .insert(changed.map((p) => ({ tenant_id: tenantId, profile_id: profileId, type: p.type, in_app: p.in_app, email: profileId ? p.email : false, sms: profileId ? p.sms : false })));
  if (error) return { ok: false, message: friendlyDbError(error, "Could not save your choices.") };
  return { ok: true, data: null };
}
