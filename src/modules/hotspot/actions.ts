"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertPermission, AuthorizationError } from "@/lib/auth/guards";
import type { Permission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, type ActionResult } from "@/lib/validation/common";
import { cancelCodeSchema, compensateSchema, resendCodeSchema, freeCodeSchema, hotspotPlanSchema, sellCodeSchema, serviceSettingsSchema } from "@/lib/validation/hotspot";
import * as hotspot from "./service";

async function guarded<T = undefined>(permissions: Permission[], run: (tenantId: string) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    let tenantId = "";
    for (const p of permissions) tenantId = (await assertPermission(p)).active.tenantId;
    return await run(tenantId);
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function savePlanAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const id = z.uuid().safeParse(formData.get("id"));
  const r = await guarded(["packages:edit"], async (tenantId) => {
    const parsed = hotspotPlanSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await hotspot.savePlan(await createClient(), tenantId, id.success ? id.data : null, parsed.data);
    return res.ok ? { ok: true } : res;
  });
  if (!r.ok) return r;
  revalidatePath("/hotspot/plans");
  if (id.success) return { ok: true, message: "Plan saved. Codes already bought keep their price and time." };
  redirect("/hotspot/plans?created=1");
}

const planStatusSchema = z.object({ id: z.uuid(), status: z.enum(["active", "inactive", "archived"]) });

export async function setPlanStatusAction(formData: FormData): Promise<void> {
  await assertPermission("packages:edit");
  const parsed = planStatusSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/hotspot/plans?error=" + encodeURIComponent("Invalid request."));
  const res = await hotspot.setPlanStatus(await createClient(), parsed.data.id, parsed.data.status);
  revalidatePath("/hotspot/plans");
  redirect("/hotspot/plans?" + (res.ok ? `saved=${parsed.data.status}` : `error=${encodeURIComponent(res.message)}`));
}

export async function sellCodeAction(_prev: ActionResult<{ code: string }> | null, formData: FormData): Promise<ActionResult<{ code: string }>> {
  return guarded(["subscriptions:edit", "payments:record"], async (tenantId) => {
    const parsed = sellCodeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await hotspot.sellCode(await createClient(), tenantId, parsed.data.planId, parsed.data.phone, parsed.data.mpesaReference);
    if (!res.ok) return res;
    revalidatePath("/hotspot");
    return {
      ok: true,
      data: { code: res.data.code },
      message: `Code ${res.data.code} is ready${parsed.data.phone ? " and will be sent by SMS" : ""}. The payment counts as collected once it is checked against the M-Pesa statement.`,
    };
  });
}

export async function giveFreeCodeAction(_prev: ActionResult<{ code: string }> | null, formData: FormData): Promise<ActionResult<{ code: string }>> {
  return guarded(["subscriptions:suspend"], async (tenantId) => {
    const parsed = freeCodeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await hotspot.giveFreeCode(await createClient(), tenantId, parsed.data.planId, parsed.data.phone, parsed.data.reason);
    if (!res.ok) return res;
    revalidatePath("/hotspot");
    return { ok: true, data: { code: res.data.code }, message: `Free code ${res.data.code} is ready. It is recorded with your reason.` };
  });
}

export async function cancelCodeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded(["subscriptions:suspend"], async () => {
    const parsed = cancelCodeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Give a reason (at least 5 characters).", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await hotspot.cancelCode(await createClient(), parsed.data.id, parsed.data.reason);
    if (!res.ok) return res;
    revalidatePath("/hotspot/codes");
    return { ok: true, message: "Code cancelled. If the device is online it is being disconnected." };
  });
}

export async function resendCodeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded(["subscriptions:edit"], async () => {
    const parsed = resendCodeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the phone number.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await hotspot.resendCode(await createClient(), parsed.data.id, parsed.data.phone);
    if (!res.ok) return res;
    revalidatePath("/hotspot/codes");
    return { ok: true, message: "The code is on its way by SMS." };
  });
}

export async function compensateAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded(["subscriptions:suspend"], async (tenantId) => {
    const parsed = compensateSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await hotspot.compensateOutage(await createClient(), tenantId, parsed.data.minutes, parsed.data.reason);
    if (!res.ok) return res;
    revalidatePath("/hotspot");
    return { ok: true, message: `Added ${parsed.data.minutes} minutes to ${res.data.toLocaleString("en-KE")} running ${res.data === 1 ? "code" : "codes"}.` };
  });
}

export async function saveServiceSettingsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded(["settings:manage"], async (tenantId) => {
    const parsed = serviceSettingsSchema.safeParse({
      methods: formData.getAll("methods"),
      paybill: formData.get("paybill") ?? "",
      accountNumber: formData.get("accountNumber") ?? "",
      upstreamProvider: formData.get("upstreamProvider") ?? "",
      upstreamPhone: formData.get("upstreamPhone") ?? "",
      upstreamCheckTarget: formData.get("upstreamCheckTarget") ?? "",
      hotspotClockStart: formData.get("hotspotClockStart") ?? "payment",
    });
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await hotspot.saveServiceSettings(await createClient(), tenantId, parsed.data);
    if (!res.ok) return res;
    revalidatePath("/settings/organisation");
    revalidatePath("/", "layout");
    return { ok: true, message: "Saved." };
  });
}
