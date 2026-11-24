"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPermission, assertPlatformAdmin, AuthorizationError } from "@/lib/auth/guards";
import { getSessionContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/validation/common";
import { friendlyDbError } from "@/lib/validation/db-errors";

const uuid = z.uuid("Something went wrong. Reload the page.");
const month = z.string().regex(/^\d{4}-\d{2}$/, "Choose a month.");
const reason = z.string().trim().min(5, "Give a reason of at least 5 characters.").max(500);

async function asAdmin(run: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    await assertPlatformAdmin();
    return await run();
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
}

function first(error: z.ZodError) {
  return error.issues[0]?.message ?? "Check the form.";
}

function refresh(tenantId?: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/agreements");
  revalidatePath("/admin/invoices");
  if (tenantId) revalidatePath(`/admin/tenants/${tenantId}`);
}

const agreementSchema = z.object({
  tenantId: uuid,
  agreementId: z.union([uuid, z.literal("")]).optional(),
  feePercent: z.coerce
    .number({ message: "Enter the fee as a percentage, for example 2.75." })
    .gt(0, "The fee must be more than 0%.")
    .max(20, "The fee can be at most 20%."),
  feeBasis: z.enum(["gross", "net_of_vat"]),
  effectiveMonth: month,
  notes: z.string().trim().max(1000).optional(),
});

export async function saveAgreementAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = agreementSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const excluded = formData.getAll("excluded").map(String).filter((c) => ["installation", "equipment", "other"].includes(c));
    const d = parsed.data;
    const db = await createClient();
    const { error } = await db.rpc("admin_save_agreement", {
      p_tenant: d.tenantId,
      p_agreement: d.agreementId || null,
      p_fee_rate: Math.round(d.feePercent * 100) / 10000,
      p_fee_basis: d.feeBasis,
      p_excluded: excluded,
      p_effective_from: `${d.effectiveMonth}-01`,
      p_notes: d.notes ?? null,
    });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not save the agreement.") };
    refresh(d.tenantId);
    return { ok: true, message: "Draft saved. Sign it once the ISP has signed." };
  });
}

export async function signAgreementAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = z
      .object({ tenantId: uuid, agreementId: uuid, signedBy: z.string().trim().min(3, "Enter who signed for the ISP.").max(120) })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const { error } = await (await createClient()).rpc("admin_sign_agreement", { p_agreement: parsed.data.agreementId, p_signed_by: parsed.data.signedBy });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not sign the agreement.") };
    refresh(parsed.data.tenantId);
    return { ok: true, message: "Agreement signed. Its terms are now frozen." };
  });
}

export async function discardAgreementAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = z.object({ tenantId: uuid, agreementId: uuid }).safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const { error } = await (await createClient()).rpc("admin_discard_agreement", { p_agreement: parsed.data.agreementId });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not discard the draft.") };
    refresh(parsed.data.tenantId);
    return { ok: true, message: "Draft discarded." };
  });
}

export async function endAgreementAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = z.object({ tenantId: uuid, agreementId: uuid, endMonth: month, reason }).safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const { error } = await (await createClient()).rpc("admin_end_agreement", {
      p_agreement: parsed.data.agreementId,
      p_end: `${parsed.data.endMonth}-01`,
      p_reason: parsed.data.reason,
    });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not end the agreement.") };
    refresh(parsed.data.tenantId);
    return { ok: true, message: "Agreement ended." };
  });
}

type CalcRow = { result: string; total_eligible: number; total_fee: number; eligible_amount: number; fee_amount: number };
const ksh = (v: unknown) => `KSh ${Number(v ?? 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function calculateFeesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = z.object({ tenantId: uuid, month }).safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const { data, error } = await (await createClient()).rpc("admin_calculate_fees", { p_tenant: parsed.data.tenantId, p_month: `${parsed.data.month}-01` });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not calculate fees.") };
    const r = (data as CalcRow[])[0];
    refresh(parsed.data.tenantId);
    if (r.result === "unchanged") return { ok: true, message: `No change: ${ksh(r.total_eligible)} eligible, fee ${ksh(r.total_fee)}.` };
    if (r.result === "adjustment") {
      return { ok: true, message: `Adjustment of ${ksh(r.fee_amount)} added. The month is now ${ksh(r.total_eligible)} eligible, fee ${ksh(r.total_fee)}.` };
    }
    return { ok: true, message: `Calculated: ${ksh(r.total_eligible)} eligible, fee ${ksh(r.total_fee)}.` };
  });
}

export async function calculateAllFeesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = z.object({ month }).safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const { data, error } = await (await createClient()).rpc("admin_calculate_all_fees", { p_month: `${parsed.data.month}-01` });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not run the fee calculation.") };
    const rows = data as { result: string; tenant_name: string; message: string | null }[];
    refresh();
    const done = rows.filter((r) => ["calculated", "adjustment", "unchanged"].includes(r.result)).length;
    const skipped = rows.filter((r) => r.result === "no_agreement").map((r) => r.tenant_name);
    const failed = rows.filter((r) => r.result === "error").map((r) => `${r.tenant_name}: ${r.message}`);
    const parts = [`${done} ISP${done === 1 ? "" : "s"} calculated.`];
    if (skipped.length) parts.push(`No signed agreement: ${skipped.join(", ")}.`);
    if (failed.length) parts.push(failed.join(" "));
    return { ok: failed.length === 0, message: parts.join(" ") };
  });
}

export async function issueInvoiceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = z
      .object({
        tenantId: uuid,
        dueDays: z.coerce.number().int().min(1, "Payment terms must be 1 to 90 days.").max(90, "Payment terms must be 1 to 90 days."),
        notes: z.string().trim().max(1000).optional(),
      })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const { error } = await (await createClient()).rpc("admin_issue_platform_invoice", {
      p_tenant: parsed.data.tenantId,
      p_due_days: parsed.data.dueDays,
      p_tax_rate: 0, // No VAT or KRA on invoices (pilot ISP is not VAT registered).
      p_notes: parsed.data.notes ?? null,
    });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not issue the invoice.") };
    refresh(parsed.data.tenantId);
    return { ok: true, message: "Invoice issued. The ISP owner and finance manager have been notified." };
  });
}

export async function recordPlatformPaymentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = z
      .object({
        invoiceId: uuid,
        tenantId: uuid,
        reference: z.string().trim().min(3, "Enter the M-Pesa or bank reference.").max(120),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the payment date."),
      })
      .safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const { error } = await (await createClient()).rpc("admin_record_platform_payment", {
      p_invoice: parsed.data.invoiceId,
      p_reference: parsed.data.reference,
      p_paid_on: parsed.data.paidOn,
    });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not record the payment.") };
    refresh(parsed.data.tenantId);
    revalidatePath(`/admin/invoices/${parsed.data.invoiceId}`);
    return { ok: true, message: "Payment recorded. The invoice is paid." };
  });
}

export async function voidPlatformInvoiceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return asAdmin(async () => {
    const parsed = z.object({ invoiceId: uuid, tenantId: uuid, reason }).safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: first(parsed.error) };
    const { error } = await (await createClient()).rpc("admin_void_platform_invoice", { p_invoice: parsed.data.invoiceId, p_reason: parsed.data.reason });
    if (error) return { ok: false, message: friendlyDbError(error, "Could not void the invoice.") };
    refresh(parsed.data.tenantId);
    revalidatePath(`/admin/invoices/${parsed.data.invoiceId}`);
    return { ok: true, message: "Invoice voided. Its fees can go on a new invoice." };
  });
}

// --- Support access -----------------------------------------------------------

export async function requestSupportAccessAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await getSessionContext();
  if (!ctx?.platformRole) return { ok: false, message: "Only FibrePulse staff can request support access." };
  const parsed = z
    .object({ tenantId: uuid, reason: z.string().trim().min(10, "Explain what you need to look at (at least 10 characters).").max(500) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  const { error } = await (await createClient()).rpc("request_support_access", { p_tenant: parsed.data.tenantId, p_reason: parsed.data.reason });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not send the request.") };
  revalidatePath("/admin/support-access");
  return { ok: true, message: "Request sent. The ISP owner has been notified." };
}

export async function decideSupportAccessAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    await assertPermission("staff:manage");
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
  const parsed = z
    .object({ grantId: uuid, decision: z.enum(["approve", "decline", "revoke"]), hours: z.coerce.number().int().min(1).max(72).optional() })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  const { error } = await (await createClient()).rpc("decide_support_access", {
    p_grant: parsed.data.grantId,
    p_decision: parsed.data.decision,
    p_hours: parsed.data.decision === "approve" ? (parsed.data.hours ?? 24) : null,
  });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not save your decision.") };
  revalidatePath("/settings/support-access");
  const msg = { approve: "Access approved. It ends automatically.", decline: "Request declined.", revoke: "Access revoked now." }[parsed.data.decision];
  return { ok: true, message: msg };
}
