"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertPermission, AuthorizationError } from "@/lib/auth/guards";
import type { Permission } from "@/lib/auth/permissions";
import { kenyaLocalToIso } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import {
  allocateSchema,
  invoiceSchema,
  purchaseSchema,
  reasonSchema,
  recordPaymentSchema,
  subscriptionActionSchema,
  verifySchema,
} from "@/lib/validation/billing";
import type { ActionResult } from "@/lib/validation/common";
import * as billing from "./service";

/** First validation message, for compact forms that show one message. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form.";
}

async function guarded(permission: Permission, run: (tenantId: string, userId: string) => Promise<ActionResult>): Promise<ActionResult> {
  try {
    const ctx = await assertPermission(permission);
    return await run(ctx.active.tenantId, ctx.userId);
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
}

function refresh(...paths: string[]) {
  for (const p of paths) revalidatePath(p);
}

// -----------------------------------------------------------------------------
// Subscriptions
// -----------------------------------------------------------------------------
export async function purchaseSubscriptionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("subscriptions:edit", async () => {
    const parsed = purchaseSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const r = await billing.purchaseSubscription(await createClient(), parsed.data.customerId, parsed.data.packageId);
    if (!r.ok) return r;
    refresh(`/customers/${parsed.data.customerId}`, "/subscriptions");
    return { ok: true, message: "Package activated and invoice issued. Record and verify the payment to mark it paid." };
  });
}

export async function changeSubscriptionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = subscriptionActionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
  const { action, subscriptionId, reason } = parsed.data;
  return guarded(action === "cancel" ? "subscriptions:edit" : "subscriptions:suspend", async () => {
    if (action !== "restore") {
      const r = reasonSchema.safeParse(reason);
      if (!r.success) return { ok: false, message: firstIssue(r.error) };
    }
    const result = await billing.changeSubscription(await createClient(), subscriptionId, action, reason);
    if (!result.ok) return result;
    const customerId = String(formData.get("customerId") ?? "");
    refresh("/subscriptions", ...(customerId ? [`/customers/${customerId}`] : []));
    const message = {
      suspend: "Subscription suspended. Until the router connector is installed, also disconnect the customer on the router yourself.",
      restore: result.data === "expired" ? "Restored, but the paid period had already ended, so it is now expired." : "Subscription restored.",
      cancel: "Subscription cancelled.",
    }[action];
    return { ok: true, message };
  });
}

// -----------------------------------------------------------------------------
// Invoices
// -----------------------------------------------------------------------------
export async function createInvoiceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("invoices:edit", async () => {
    const parsed = invoiceSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const r = await billing.createInvoice(await createClient(), parsed.data);
    if (!r.ok) return r;
    refresh(`/customers/${parsed.data.customerId}`, "/payments");
    return { ok: true, message: "Invoice issued." };
  });
}

export async function voidInvoiceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("invoices:edit", async () => {
    const id = z.uuid().safeParse(formData.get("invoiceId"));
    const reason = reasonSchema.safeParse(formData.get("reason") ?? "");
    if (!id.success) return { ok: false, message: "Invoice not found." };
    if (!reason.success) return { ok: false, message: firstIssue(reason.error) };
    const r = await billing.voidInvoice(await createClient(), id.data, reason.data);
    if (!r.ok) return r;
    refresh("/payments", `/customers/${String(formData.get("customerId") ?? "")}`);
    return { ok: true, message: "Invoice voided." };
  });
}

// -----------------------------------------------------------------------------
// Payments
// -----------------------------------------------------------------------------
export async function recordPaymentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  let id: string;
  const back = String(formData.get("returnTo") ?? "");
  const result = await guarded("payments:record", async (tenantId, userId) => {
    const parsed = recordPaymentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const at = kenyaLocalToIso(parsed.data.transactionAt);
    if (!at) return { ok: false, message: "Enter when the payment was made." };
    if (new Date(at).getTime() > Date.now() + 5 * 60_000) return { ok: false, message: "The payment time cannot be in the future." };
    const r = await billing.recordPayment(await createClient(), tenantId, userId, { ...parsed.data, transactionAt: at });
    if (!r.ok) return r;
    id = r.data.id;
    return { ok: true };
  });
  if (!result.ok) return result;
  refresh("/payments", ...(back.startsWith("/customers/") ? [back] : []));
  redirect(`/payments/${id!}?recorded=1`);
}

export async function verifyPaymentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("payments:reconcile", async () => {
    const parsed = verifySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const d = parsed.data;
    const r = await billing.verifyPayment(await createClient(), d.paymentId, d.statementSource, d.statementReference, d.notes);
    if (!r.ok) return r;
    refresh("/payments", `/payments/${d.paymentId}`);
    return { ok: true, message: "Payment verified and applied to the customer's oldest unpaid invoices." };
  });
}

const reasonFor = (formData: FormData) =>
  z.object({ paymentId: z.uuid(), reason: reasonSchema }).safeParse({ paymentId: formData.get("paymentId"), reason: formData.get("reason") ?? "" });

export async function rejectPaymentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("payments:reconcile", async () => {
    const parsed = reasonFor(formData);
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const r = await billing.rejectPayment(await createClient(), parsed.data.paymentId, parsed.data.reason);
    if (!r.ok) return r;
    refresh("/payments", `/payments/${parsed.data.paymentId}`);
    return { ok: true, message: "Payment marked as rejected. It will not count as revenue." };
  });
}

export async function reversePaymentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("payments:reconcile", async () => {
    const parsed = reasonFor(formData);
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const r = await billing.reversePayment(await createClient(), parsed.data.paymentId, parsed.data.reason);
    if (!r.ok) return r;
    refresh("/payments", `/payments/${parsed.data.paymentId}`);
    return { ok: true, message: "Payment reversed. Its invoices are unpaid again." };
  });
}

export async function allocatePaymentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("payments:reconcile", async () => {
    const parsed = allocateSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const r = await billing.allocatePayment(await createClient(), parsed.data.paymentId, parsed.data.invoiceId, parsed.data.amount);
    if (!r.ok) return r;
    refresh(`/payments/${parsed.data.paymentId}`);
    return { ok: true, message: "Allocated." };
  });
}

export async function assignPaymentCustomerAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("payments:reconcile", async () => {
    const parsed = z
      .object({ paymentId: z.uuid(), customerId: z.uuid("Choose a customer.") })
      .safeParse({ paymentId: formData.get("paymentId"), customerId: formData.get("customerId") });
    if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) };
    const r = await billing.assignPaymentCustomer(await createClient(), parsed.data.paymentId, parsed.data.customerId);
    if (!r.ok) return r;
    refresh("/payments", `/payments/${parsed.data.paymentId}`);
    return { ok: true, message: "Payment linked to the customer." };
  });
}
