"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { assertPermission, AuthorizationError } from "@/lib/auth/guards";
import { ACTIVE_TENANT_COOKIE, getSessionContext } from "@/lib/auth/session";
import type { TenantRole } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, type ActionResult } from "@/lib/validation/common";
import { changeRoleSchema, inviteStaffSchema, memberStatusSchema, organisationSchema, registerTenantSchema } from "@/lib/validation/tenants";
import { friendlyDbError } from "@/lib/validation/db-errors";
import * as tenants from "./service";

const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };

function denied(e: unknown): ActionResult {
  if (e instanceof AuthorizationError) return { ok: false, message: e.message };
  throw e;
}

export async function registerTenantAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx) return { ok: false, message: "Sign in first." };
  const parsed = registerTenantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };

  const db = await createClient();
  const result = await tenants.registerTenant(db, parsed.data);
  if (!result.ok) return { ok: false, message: result.message };

  (await cookies()).set(ACTIVE_TENANT_COOKIE, result.data.tenantId, cookieOptions);
  redirect("/overview");
}

export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const id = String(formData.get("invitationId") ?? "");
  const db = await createClient();
  const result = await tenants.acceptInvitation(db, id);
  if (result.ok) {
    (await cookies()).set(ACTIVE_TENANT_COOKIE, result.data.tenantId, cookieOptions);
    redirect("/overview");
  }
  redirect(`/onboarding?error=${encodeURIComponent(result.message)}`);
}

export async function switchTenantAction(formData: FormData): Promise<void> {
  const ctx = await getSessionContext();
  const id = String(formData.get("tenantId") ?? "");
  // Only switch to an ISP the user actually belongs to.
  if (ctx?.memberships.some((m) => m.tenantId === id)) {
    (await cookies()).set(ACTIVE_TENANT_COOKIE, id, cookieOptions);
  }
  redirect("/overview");
}

export async function inviteStaffAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await assertPermission("staff:manage");
    const parsed = inviteStaffSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const db = await createClient();
    const result = await tenants.inviteStaff(db, {
      tenantId: ctx.active.tenantId,
      invitedBy: ctx.userId,
      email: parsed.data.email,
      role: parsed.data.role as TenantRole,
    });
    if (!result.ok) return { ok: false, message: result.message };
    // TODO: SOFTWARE ENGINEER - send the invitation email once an email
    // provider delivers notification_outbox. Until then the owner shares the
    // sign-up link themselves.
    revalidatePath("/settings/staff");
    return { ok: true, message: `Invitation created for ${parsed.data.email}. Ask them to sign up with that email.` };
  } catch (e) {
    return denied(e);
  }
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const ctx = await assertPermission("staff:manage");
  const db = await createClient();
  await tenants.revokeInvitation(db, ctx.active.tenantId, String(formData.get("invitationId") ?? ""));
  revalidatePath("/settings/staff");
}

export async function changeRoleAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await assertPermission("staff:manage");
    const parsed = changeRoleSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Choose a valid role." };
    const db = await createClient();
    const result = await tenants.updateMember(db, ctx.active.tenantId, parsed.data.memberId, { role: parsed.data.role });
    if (!result.ok) return { ok: false, message: result.message };
    revalidatePath("/settings/staff");
    return { ok: true, message: "Role updated." };
  } catch (e) {
    return denied(e);
  }
}

export async function setMemberStatusAction(formData: FormData): Promise<void> {
  const ctx = await assertPermission("staff:manage");
  const parsed = memberStatusSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;
  const db = await createClient();
  await tenants.updateMember(db, ctx.active.tenantId, parsed.data.memberId, { status: parsed.data.status });
  revalidatePath("/settings/staff");
}

export async function updateOrganisationAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await assertPermission("settings:manage");
    const parsed = organisationSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const db = await createClient();
    const { error } = await db
      .from("tenants")
      .update({
        name: parsed.data.name,
        legal_name: parsed.data.legalName || null,
        county: parsed.data.county,
        town: parsed.data.town || null,
        contact_phone: parsed.data.contactPhone,
      })
      .eq("id", ctx.active.tenantId);
    if (error) return { ok: false, message: friendlyDbError(error) };
    revalidatePath("/", "layout");
    return { ok: true, message: "Organisation details saved." };
  } catch (e) {
    return denied(e);
  }
}
