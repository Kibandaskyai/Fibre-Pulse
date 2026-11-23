/**
 * Subscriptions, invoices and payments.
 *
 * Every state change calls a SECURITY DEFINER database function (migration
 * 20261124000100) that checks the caller's permission, writes the audit
 * reason and keeps balances consistent in one transaction. Direct table
 * writes are refused by RLS, except recording a new manual payment.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normaliseKenyanPhone } from "@/lib/validation/common";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };
type DataSource = "simulated" | "manual" | "connector" | "provider";

export const PAGE_SIZE = 25;

async function rpc<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>, fallback: string): Promise<Result<T>> {
  const { data, error } = await db.rpc(fn, args);
  if (error) return { ok: false, message: friendlyDbError(error, fallback) };
  return { ok: true, data: data as T };
}

// -----------------------------------------------------------------------------
// Subscriptions
// -----------------------------------------------------------------------------
export const purchaseSubscription = (db: SupabaseClient, customerId: string, packageId: string) =>
  rpc<string>(db, "purchase_subscription", { p_customer: customerId, p_package: packageId }, "Could not activate the package.");

export async function changeSubscription(db: SupabaseClient, id: string, action: "suspend" | "restore" | "cancel", reason: string): Promise<Result<string | null>> {
  const fn = { suspend: "suspend_subscription", restore: "restore_subscription", cancel: "cancel_subscription" }[action];
  return rpc<string | null>(db, fn, { p_subscription: id, p_reason: reason }, "Could not change the subscription.");
}

/** Close periods that have ended. Safe to call on every page load. */
export async function expireDueSubscriptions(db: SupabaseClient, tenantId: string): Promise<number> {
  const { data } = await db.rpc("expire_due_subscriptions", { p_tenant: tenantId });
  return Number(data ?? 0);
}

export type SubscriptionRow = {
  id: string;
  status: string;
  change_type: string;
  starts_at: string;
  expires_at: string;
  price: number;
  billing_period: string;
  suspension_reason: string | null;
  customer_id: string;
  customers: { full_name: string; customer_number: string; phone: string } | null;
  service_packages: { name: string } | null;
};

export async function listSubscriptions(
  db: SupabaseClient,
  tenantId: string,
  f: { status: string; expiring: boolean; page: number },
): Promise<Result<{ rows: SubscriptionRow[]; total: number }>> {
  let q = db
    .from("subscriptions")
    .select("id, status, change_type, starts_at, expires_at, price, billing_period, suspension_reason, customer_id, customers(full_name, customer_number, phone), service_packages(name)", {
      count: "exact",
    })
    .eq("tenant_id", tenantId);
  if (f.expiring) {
    q = q.eq("status", "active").lte("expires_at", new Date(Date.now() + 3 * 86_400_000).toISOString()).order("expires_at");
  } else {
    if (f.status) q = q.eq("status", f.status);
    else q = q.in("status", ["active", "suspended"]);
    q = q.order("expires_at", { ascending: true });
  }
  const from = (f.page - 1) * PAGE_SIZE;
  const { data, error, count } = await q.range(from, from + PAGE_SIZE - 1);
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load subscriptions.") };
  return { ok: true, data: { rows: (data ?? []) as unknown as SubscriptionRow[], total: count ?? 0 } };
}

export async function subscriptionCounts(db: SupabaseClient, tenantId: string) {
  const head = (status: string) => db.from("subscriptions").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", status);
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const [active, suspended, expiring] = await Promise.all([head("active"), head("suspended"), head("active").lte("expires_at", soon)]);
  return { active: active.count ?? 0, suspended: suspended.count ?? 0, expiringSoon: expiring.count ?? 0 };
}

// -----------------------------------------------------------------------------
// Invoices
// -----------------------------------------------------------------------------
export type InvoiceRow = {
  id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  total: number;
  amount_paid: number;
  status: string;
  customer_id: string;
  customers: { full_name: string; customer_number: string } | null;
};

export async function listInvoices(
  db: SupabaseClient,
  tenantId: string,
  f: { status: string; page: number; customerId?: string },
): Promise<Result<{ rows: InvoiceRow[]; total: number }>> {
  let q = db
    .from("invoices")
    .select("id, invoice_number, issue_date, due_date, total, amount_paid, status, customer_id, customers(full_name, customer_number)", { count: "exact" })
    .eq("tenant_id", tenantId);
  if (f.status === "open") q = q.in("status", ["issued", "partially_paid"]);
  else if (f.status) q = q.eq("status", f.status);
  if (f.customerId) q = q.eq("customer_id", f.customerId);
  const from = (f.page - 1) * PAGE_SIZE;
  const { data, error, count } = await q.order("issue_date", { ascending: false }).order("created_at", { ascending: false }).range(from, from + PAGE_SIZE - 1);
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load invoices.") };
  return { ok: true, data: { rows: (data ?? []) as unknown as InvoiceRow[], total: count ?? 0 } };
}

export async function openInvoicesForCustomer(db: SupabaseClient, tenantId: string, customerId: string) {
  const { data } = await db
    .from("invoices")
    .select("id, invoice_number, total, amount_paid, issue_date")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customerId)
    .in("status", ["issued", "partially_paid"])
    .order("issue_date");
  return (data ?? []).map((i) => ({ ...i, balance: Number(i.total) - Number(i.amount_paid) }));
}

export const createInvoice = (
  db: SupabaseClient,
  input: { customerId: string; description: string; category: string; quantity: number; unitPrice: number; dueDate: string | null; notes: string | null },
) =>
  rpc<string>(
    db,
    "create_invoice",
    {
      p_customer: input.customerId,
      p_lines: [{ description: input.description, category: input.category, quantity: input.quantity, unit_price: input.unitPrice }],
      p_due_date: input.dueDate,
      p_notes: input.notes,
    },
    "Could not create the invoice.",
  );

export const voidInvoice = (db: SupabaseClient, id: string, reason: string) =>
  rpc<null>(db, "void_invoice", { p_invoice: id, p_reason: reason }, "Could not void the invoice.");

// -----------------------------------------------------------------------------
// Payments
// -----------------------------------------------------------------------------
export type PaymentRow = {
  id: string;
  method: string;
  provider_reference: string | null;
  amount: number;
  transaction_at: string;
  status: string;
  verification_status: string;
  reconciliation_status: string;
  data_source: DataSource;
  payer_phone: string | null;
  payer_name: string | null;
  description: string | null;
  customer_id: string | null;
  created_at: string;
  customers: { full_name: string; customer_number: string } | null;
};

const PAYMENT_COLUMNS =
  "id, method, provider_reference, amount, transaction_at, status, verification_status, reconciliation_status, data_source, payer_phone, payer_name, description, customer_id, created_at, customers(full_name, customer_number)";

export type PaymentFilters = { verification: string; method: string; q: string; from: string; to: string; page: number };

function paymentQuery(db: SupabaseClient, tenantId: string, f: PaymentFilters) {
  let q = db.from("payments").select(PAYMENT_COLUMNS, { count: "exact" }).eq("tenant_id", tenantId);
  if (f.verification === "unmatched") q = q.is("customer_id", null);
  else if (f.verification) q = q.eq("verification_status", f.verification);
  if (f.method) q = q.eq("method", f.method);
  const ref = f.q.replace(/[^A-Za-z0-9/-]/g, "").toUpperCase().slice(0, 64);
  if (ref) q = q.ilike("provider_reference", `%${ref}%`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from)) q = q.gte("transaction_at", `${f.from}T00:00:00+03:00`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) q = q.lte("transaction_at", `${f.to}T23:59:59.999+03:00`);
  return q.order("transaction_at", { ascending: false });
}

export async function listPayments(db: SupabaseClient, tenantId: string, f: PaymentFilters, pageSize = PAGE_SIZE): Promise<Result<{ rows: PaymentRow[]; total: number }>> {
  const from = (f.page - 1) * pageSize;
  const { data, error, count } = await paymentQuery(db, tenantId, f).range(from, from + pageSize - 1);
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load payments.") };
  return { ok: true, data: { rows: (data ?? []) as unknown as PaymentRow[], total: count ?? 0 } };
}

export async function getPayment(db: SupabaseClient, tenantId: string, id: string) {
  const { data, error } = await db.from("payments").select(PAYMENT_COLUMNS).eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (error || !data) return null;
  const [allocations, reconciliation] = await Promise.all([
    db.from("payment_allocations").select("id, amount, created_at, invoices(id, invoice_number, total, status)").eq("payment_id", id).order("created_at"),
    db.from("payment_reconciliation_records").select("id, statement_source, statement_reference, result, notes, created_at").eq("payment_id", id).order("created_at"),
  ]);
  const allocated = (allocations.data ?? []).reduce((s, a) => s + Number(a.amount), 0);
  return {
    payment: data as unknown as PaymentRow,
    allocations: (allocations.data ?? []) as unknown as { id: string; amount: number; created_at: string; invoices: { id: string; invoice_number: string; total: number; status: string } | null }[],
    reconciliation: reconciliation.data ?? [],
    unallocated: Math.round((Number(data.amount) - allocated) * 100) / 100,
  };
}

export async function recordPayment(
  db: SupabaseClient,
  tenantId: string,
  userId: string,
  input: {
    customerId: string | null;
    method: string;
    reference: string;
    amount: number;
    transactionAt: string;
    payerPhone: string | null;
    payerName: string | null;
    description: string | null;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("payments")
    .insert({
      tenant_id: tenantId,
      customer_id: input.customerId,
      method: input.method,
      provider_reference: input.reference,
      amount: input.amount,
      transaction_at: input.transactionAt,
      // A staff member saw the money arrive; it still needs checking against
      // the statement before it counts as collected revenue.
      status: "successful",
      verification_status: "unverified",
      data_source: "manual",
      payer_phone: input.payerPhone,
      payer_name: input.payerName,
      description: input.description,
      recorded_by: userId,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, message: `Reference ${input.reference} has already been recorded. This looks like a duplicate payment.` };
    return { ok: false, message: friendlyDbError(error, "Could not record the payment.") };
  }
  return { ok: true, data: { id: data.id } };
}

export const verifyPayment = (db: SupabaseClient, id: string, source: string, reference: string | null, notes: string | null) =>
  rpc<null>(db, "verify_payment", { p_payment: id, p_statement_source: source, p_statement_reference: reference, p_notes: notes }, "Could not verify the payment.");

export const rejectPayment = (db: SupabaseClient, id: string, reason: string) =>
  rpc<null>(db, "reject_payment", { p_payment: id, p_reason: reason }, "Could not reject the payment.");

export const reversePayment = (db: SupabaseClient, id: string, reason: string) =>
  rpc<null>(db, "reverse_payment", { p_payment: id, p_reason: reason }, "Could not reverse the payment.");

export const allocatePayment = (db: SupabaseClient, paymentId: string, invoiceId: string, amount: number) =>
  rpc<null>(db, "allocate_payment", { p_payment: paymentId, p_invoice: invoiceId, p_amount: amount }, "Could not allocate the payment.");

export const assignPaymentCustomer = (db: SupabaseClient, paymentId: string, customerId: string) =>
  rpc<null>(db, "assign_payment_customer", { p_payment: paymentId, p_customer: customerId }, "Could not assign the payment.");

export async function paymentTotals(db: SupabaseClient, tenantId: string) {
  const head = () => db.from("payments").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  const [awaiting, unmatched] = await Promise.all([
    head().eq("status", "successful").eq("verification_status", "unverified"),
    head().is("customer_id", null).eq("status", "successful"),
  ]);
  return { awaitingVerification: awaiting.count ?? 0, unmatched: unmatched.count ?? 0 };
}

/** Customers for pickers (payment assignment, recording). */
export async function findCustomers(db: SupabaseClient, tenantId: string, q: string) {
  const term = q.replace(/[%_*,()\\:"']/g, " ").trim().slice(0, 60);
  if (term.length < 2) return [];
  const phone = normaliseKenyanPhone(term);
  const ors = [`full_name.ilike.*${term}*`, `customer_number.ilike.*${term}*`, `phone.ilike.*${term.replace(/\s/g, "")}*`];
  if (phone) ors.push(`phone.eq.${phone}`);
  const { data } = await db
    .from("customers")
    .select("id, full_name, customer_number, phone")
    .eq("tenant_id", tenantId)
    .or(ors.join(","))
    .limit(10);
  return data ?? [];
}
