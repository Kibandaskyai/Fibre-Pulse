"use server";
/**
 * The public WiFi buying page. People buying are not signed in, so these
 * actions use the public key; the database functions they call only show
 * plans, start an unpaid purchase (rate limited) and report its status.
 * Nothing is granted until M-Pesa confirms the payment on the server.
 */
import { createClient as createSupabase } from "@supabase/supabase-js";
import { z } from "zod";
import { publicEnv } from "@/lib/env";
import { getPaymentProvider } from "@/lib/integrations/payments/provider";
import { portalBuySchema } from "@/lib/validation/hotspot";
import { cleanMac } from "@/lib/hotspot-login";

function publicDb() {
  const env = publicEnv();
  return createSupabase(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const slugSchema = z.string().regex(/^[a-z0-9-]{3,48}$/);

export type BuyResult =
  | { ok: true; voucherId: string; amount: number; plan: string; phone: string; prompt: "sent" | "simulate" | "paybill"; message: string }
  | { ok: false; message: string; field?: "phone" | "planId" };

export async function buyAction(slug: string, form: { planId: string; phone: string; mac?: string | null }): Promise<BuyResult> {
  if (!slugSchema.safeParse(slug).success) return { ok: false, message: "This WiFi page is not available." };
  const parsed = portalBuySchema.safeParse({ ...form, mac: cleanMac(form.mac) ?? "" });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: issue?.message ?? "Check the form.", field: issue?.path[0] === "phone" ? "phone" : "planId" };
  }
  const db = publicDb();
  const info = (await db.rpc("hotspot_portal", { p_slug: slug })).data as { demo?: boolean; paybill?: string | null; account_number?: string | null } | null;
  const demo = Boolean(info?.demo);
  const paybill = info?.paybill ?? null;
  const { data, error } = await db.rpc("hotspot_portal_buy", { p_slug: slug, p_plan: parsed.data.planId, p_phone: parsed.data.phone, p_mac: parsed.data.mac });
  if (error) return { ok: false, message: error.code === "23514" || error.code === "P0002" ? error.message : "Could not start the payment. Try again." };
  const b = data as { voucher_id: string; amount: number; phone: string; plan: string; account_reference: string };

  // TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION
  // With Daraja live, this sends the M-Pesa prompt to the buyer's phone.
  const stk = await getPaymentProvider().initiateStkPush({
    tenantId: "",
    customerId: null,
    invoiceId: null,
    hotspotVoucherId: b.voucher_id,
    phone: b.phone,
    amount: Number(b.amount),
    accountReference: b.account_reference,
    description: `WiFi ${b.plan}`.slice(0, 13),
  });
  const base = { ok: true as const, voucherId: b.voucher_id, amount: Number(b.amount), plan: b.plan, phone: b.phone };
  if (stk.ok) return { ...base, prompt: "sent", message: "Check your phone and enter your M-Pesa PIN." };
  if (demo) return { ...base, prompt: "simulate", message: "Demo: M-Pesa is not connected. Use the simulate button to see what happens after payment." };
  return {
    ...base,
    prompt: "paybill",
    message: paybill
      ? `Pay Ksh ${Number(b.amount)} to paybill ${paybill}${info?.account_number ? `, account ${info.account_number},` : ""} from ${b.phone.replace(/^\+254/, "0")}. Your code arrives by SMS.`
      : "Automatic M-Pesa prompts are not set up yet. Ask the WiFi owner for a code.",
  };
}

export type StatusResult = { status: string; code: string | null; plan: string; simulated: boolean } | null;

export async function statusAction(slug: string, voucherId: string): Promise<StatusResult> {
  if (!slugSchema.safeParse(slug).success || !z.uuid().safeParse(voucherId).success) return null;
  const { data } = await publicDb().rpc("hotspot_portal_status", { p_slug: slug, p_voucher: voucherId });
  return (data as StatusResult) ?? null;
}

export async function simulatePaymentAction(slug: string, voucherId: string): Promise<{ ok: boolean; message?: string }> {
  if (!slugSchema.safeParse(slug).success || !z.uuid().safeParse(voucherId).success) return { ok: false, message: "Invalid request." };
  const { error } = await publicDb().rpc("hotspot_portal_simulate_payment", { p_slug: slug, p_voucher: voucherId });
  return error ? { ok: false, message: error.message } : { ok: true };
}
