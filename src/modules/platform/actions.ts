"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPlatformAdmin, AuthorizationError } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/validation/common";
import { setTenantStatus } from "./service";

const schema = z.object({
  tenantId: z.uuid(),
  status: z.enum(["pending", "active", "suspended", "deactivated"]),
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters.").max(500),
});

export async function setTenantStatusAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    await assertPlatformAdmin();
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
  const db = await createClient();
  const r = await setTenantStatus(db, parsed.data.tenantId, parsed.data.status, parsed.data.reason);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath("/admin/tenants");
  revalidatePath("/admin");
  return { ok: true, message: "Status updated and recorded in the audit log." };
}
