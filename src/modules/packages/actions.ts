"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertPermission, AuthorizationError } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { packageSchema } from "@/lib/validation/billing";
import { fieldErrorsOf, type ActionResult } from "@/lib/validation/common";
import * as packages from "./service";

function denied(e: unknown): ActionResult {
  if (e instanceof AuthorizationError) return { ok: false, message: e.message };
  throw e;
}

export async function createPackageAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await assertPermission("packages:edit");
    const parsed = packageSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const result = await packages.createPackage(await createClient(), ctx.active.tenantId, parsed.data);
    if (!result.ok) return { ok: false, message: result.message };
  } catch (e) {
    return denied(e);
  }
  revalidatePath("/packages");
  redirect("/packages?created=1");
}

export async function updatePackageAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await assertPermission("packages:edit");
    const id = z.uuid().safeParse(formData.get("id"));
    if (!id.success) return { ok: false, message: "Package not found." };
    const parsed = packageSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const result = await packages.updatePackage(await createClient(), ctx.active.tenantId, id.data, parsed.data);
    if (!result.ok) return { ok: false, message: result.message };
    revalidatePath("/packages");
    return { ok: true, message: "Package saved. Existing subscriptions keep the price they were bought at." };
  } catch (e) {
    return denied(e);
  }
}

const statusSchema = z.object({ id: z.uuid(), status: z.enum(["active", "inactive", "archived"]) });

export async function setPackageStatusAction(formData: FormData): Promise<void> {
  const ctx = await assertPermission("packages:edit");
  const parsed = statusSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/packages?error=" + encodeURIComponent("Invalid request."));
  const result = await packages.setPackageStatus(await createClient(), ctx.active.tenantId, parsed.data.id, parsed.data.status);
  revalidatePath("/packages");
  if (!result.ok) redirect("/packages?error=" + encodeURIComponent(result.message));
  redirect(`/packages/${parsed.data.id}?saved=${parsed.data.status}`);
}
