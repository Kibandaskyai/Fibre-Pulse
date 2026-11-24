"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPermission, AuthorizationError, requireTenant } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/validation/common";
import { NOTIFICATION_TYPES } from "@/lib/validation/operations";
import * as notifications from "./service";

function prefsFrom(formData: FormData, withChannels: boolean): notifications.Preference[] {
  return NOTIFICATION_TYPES.map(([type]) => ({
    type,
    in_app: formData.get(`${type}.in_app`) === "on",
    email: withChannels && formData.get(`${type}.email`) === "on",
    sms: withChannels && formData.get(`${type}.sms`) === "on",
  }));
}

export async function markReadAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireTenant();
  const id = formData.get("id");
  const ids = id === "all" ? "all" : z.uuid().safeParse(id).success ? [String(id)] : null;
  if (!ids) return { ok: false, message: "Notification not found." };
  const res = await notifications.markRead(await createClient(), ctx.userId, ids);
  if (!res.ok) return res;
  revalidatePath("/notifications", "layout");
  return { ok: true, message: ids === "all" ? `Marked ${res.data} as read.` : undefined };
}

export async function saveMyPreferencesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireTenant();
  const res = await notifications.savePreferences(await createClient(), ctx.active.tenantId, ctx.userId, prefsFrom(formData, true));
  if (!res.ok) return res;
  revalidatePath("/notifications/settings");
  return { ok: true, message: "Saved. Email and SMS copies are queued and will be sent once a provider is connected." };
}

export async function saveIspPreferencesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await assertPermission("settings:manage");
    const res = await notifications.savePreferences(await createClient(), ctx.active.tenantId, null, prefsFrom(formData, false));
    if (!res.ok) return res;
    revalidatePath("/notifications/settings");
    return { ok: true, message: "Saved for everyone in your ISP." };
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
}
