/**
 * Customers. Reads and writes go through the signed-in user's Supabase
 * client so RLS enforces tenant isolation and role permissions. Exact GPS is
 * in customer_locations, which only customers:view_location can read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normaliseKenyanPhone } from "@/lib/validation/common";
import type { CustomerFilters, CustomerInput } from "@/lib/validation/billing";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export const PAGE_SIZE = 25;

export type Customer = {
  id: string;
  customer_number: string;
  full_name: string;
  phone: string;
  email: string | null;
  address: string | null;
  estate: string | null;
  town: string | null;
  county: string | null;
  status: "active" | "suspended" | "pending_installation" | "disconnected" | "terminated";
  pppoe_username: string | null;
  registered_on: string;
  notes: string | null;
  data_source: "simulated" | "manual" | "connector" | "provider";
  created_at: string;
};

export type AccountSummary = { outstanding: number; credit: number; last_payment_at: string | null };

const COLUMNS =
  "id, customer_number, full_name, phone, email, address, estate, town, county, status, pppoe_username, registered_on, notes, data_source, created_at";

/** Strip characters that have meaning in PostgREST filter strings. */
export function safeSearchTerm(q: string): string {
  return q.replace(/[%_*,()\\:"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function duplicateMessage(error: { code?: string; message?: string }): string | null {
  if (error.code !== "23505") return null;
  if (error.message?.includes("pppoe")) return "That PPPoE username is already used by another customer.";
  if (error.message?.includes("phone")) return "Another customer already has that phone number.";
  return "That customer already exists.";
}

export async function listCustomers(
  db: SupabaseClient,
  tenantId: string,
  f: CustomerFilters,
  pageSize = PAGE_SIZE,
): Promise<Result<{ rows: (Customer & AccountSummary)[]; total: number }>> {
  let q = db.from("customer_directory").select(`${COLUMNS}, outstanding, credit, last_payment_at`, { count: "exact" }).eq("tenant_id", tenantId);
  const term = safeSearchTerm(f.q);
  if (term) {
    const phone = normaliseKenyanPhone(term);
    const ors = [`full_name.ilike.*${term}*`, `customer_number.ilike.*${term}*`, `phone.ilike.*${term.replace(/\s/g, "")}*`, `pppoe_username.ilike.*${term}*`];
    if (phone) ors.push(`phone.eq.${phone}`);
    q = q.or(ors.join(","));
  }
  if (f.status) q = q.eq("status", f.status);
  const area = safeSearchTerm(f.area);
  if (area) q = q.or(`estate.ilike.*${area}*,town.ilike.*${area}*,county.ilike.*${area}*`);
  if (f.balance === "owing") q = q.gt("outstanding", 0);
  if (f.balance === "credit") q = q.gt("credit", 0);

  const from = (f.page - 1) * pageSize;
  const { data, error, count } = await q.order("created_at", { ascending: false }).range(from, from + pageSize - 1);
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load customers.") };
  const rows = (data ?? []).map((r) => ({ ...(r as Customer & AccountSummary), outstanding: Number(r.outstanding), credit: Number(r.credit) }));
  return { ok: true, data: { rows, total: count ?? 0 } };
}

async function summariesFor(db: SupabaseClient, ids: string[]): Promise<Map<string, AccountSummary>> {
  const out = new Map<string, AccountSummary>();
  if (!ids.length) return out;
  // Finance-only figures: roles without payments/invoices access get zeros
  // because RLS hides the rows the view sums.
  // Chunked so the request URL stays short.
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await db
      .from("customer_account_summary")
      .select("customer_id, outstanding, credit, last_payment_at")
      .in("customer_id", ids.slice(i, i + 150));
    for (const r of data ?? []) out.set(r.customer_id, { outstanding: Number(r.outstanding), credit: Number(r.credit), last_payment_at: r.last_payment_at });
  }
  return out;
}

export async function getCustomer(
  db: SupabaseClient,
  tenantId: string,
  id: string,
): Promise<Result<Customer & AccountSummary & { location: { latitude: number; longitude: number } | null }>> {
  const { data, error } = await db.from("customers").select(COLUMNS).eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load the customer.") };
  if (!data) return { ok: false, message: "Customer not found." };
  const [summary, loc] = await Promise.all([
    summariesFor(db, [id]),
    db.from("customer_locations").select("latitude, longitude").eq("customer_id", id).maybeSingle(),
  ]);
  return {
    ok: true,
    data: {
      ...(data as Customer),
      ...(summary.get(id) ?? { outstanding: 0, credit: 0, last_payment_at: null }),
      location: loc.data ? { latitude: Number(loc.data.latitude), longitude: Number(loc.data.longitude) } : null,
    },
  };
}

function toRow(input: CustomerInput) {
  return {
    full_name: input.fullName,
    phone: input.phone,
    email: input.email,
    address: input.address,
    estate: input.estate,
    town: input.town,
    county: input.county,
    status: input.status,
    pppoe_username: input.pppoeUsername,
    notes: input.notes,
  };
}

async function saveLocation(db: SupabaseClient, tenantId: string, customerId: string, input: CustomerInput, canSetLocation: boolean) {
  if (!canSetLocation || input.latitude === null || input.longitude === null) return null;
  const { error } = await db
    .from("customer_locations")
    .upsert({ tenant_id: tenantId, customer_id: customerId, latitude: input.latitude, longitude: input.longitude, captured_at: new Date().toISOString() });
  return error ? "Customer saved, but the location could not be saved." : null;
}

export async function createCustomer(
  db: SupabaseClient,
  tenantId: string,
  userId: string,
  input: CustomerInput,
  canSetLocation: boolean,
): Promise<Result<{ id: string; warning: string | null }>> {
  const { data, error } = await db
    .from("customers")
    .insert({ tenant_id: tenantId, ...toRow(input), data_source: "manual", created_by: userId })
    .select("id")
    .single();
  if (error) return { ok: false, message: duplicateMessage(error) ?? friendlyDbError(error, "Could not add the customer.") };
  const warning = await saveLocation(db, tenantId, data.id, input, canSetLocation);
  return { ok: true, data: { id: data.id, warning } };
}

export async function updateCustomer(
  db: SupabaseClient,
  tenantId: string,
  id: string,
  input: CustomerInput,
  canSetLocation: boolean,
): Promise<Result<{ warning: string | null }>> {
  const { data, error } = await db.from("customers").update(toRow(input)).eq("tenant_id", tenantId).eq("id", id).select("id");
  if (error) return { ok: false, message: duplicateMessage(error) ?? friendlyDbError(error, "Could not save the customer.") };
  if (!data?.length) return { ok: false, message: "Customer not found." };
  const warning = await saveLocation(db, tenantId, id, input, canSetLocation);
  return { ok: true, data: { warning } };
}

/** Phones and PPPoE usernames already used by live customers, for import duplicate checks. */
export async function existingCustomerKeys(db: SupabaseClient, tenantId: string): Promise<{ phones: Set<string>; pppoe: Set<string> }> {
  const phones = new Set<string>();
  const pppoe = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from("customers")
      .select("phone, pppoe_username")
      .eq("tenant_id", tenantId)
      .neq("status", "terminated")
      .range(from, from + 999);
    for (const r of data ?? []) {
      phones.add(r.phone);
      if (r.pppoe_username) pppoe.add(String(r.pppoe_username).toLowerCase());
    }
    if (!data || data.length < 1000) break;
  }
  return { phones, pppoe };
}

export async function importCustomers(db: SupabaseClient, tenantId: string, userId: string, rows: CustomerInput[]): Promise<Result<{ inserted: number }>> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ tenant_id: tenantId, ...toRow(r), data_source: "manual", created_by: userId }));
    const { error } = await db.from("customers").insert(chunk);
    if (error) {
      return {
        ok: false,
        message: `${inserted} customers were imported, then the import stopped: ${duplicateMessage(error) ?? friendlyDbError(error, "a row was refused")}. Check the file again and re-import the rest.`,
      };
    }
    inserted += chunk.length;
  }
  return { ok: true, data: { inserted } };
}

export type CustomerHistory = {
  subscriptions: {
    id: string; package_id: string; status: string; change_type: string; starts_at: string; expires_at: string; price: number; billing_period: string;
    suspension_reason: string | null; ended_at: string | null; service_packages: { name: string } | null;
  }[];
  invoices: { id: string; invoice_number: string; issue_date: string; due_date: string; total: number; amount_paid: number; status: string }[];
  payments: {
    id: string; method: string; provider_reference: string | null; amount: number; transaction_at: string; status: string;
    verification_status: string; data_source: "simulated" | "manual" | "connector" | "provider";
  }[];
  tickets: { id: string; ticket_number: string; subject: string; status: string; priority: string; created_at: string }[];
};

/** Everything about one customer that the caller's role may see. Hidden tables come back empty. */
export async function getCustomerHistory(db: SupabaseClient, tenantId: string, customerId: string): Promise<CustomerHistory> {
  const [subs, invs, pays, tix] = await Promise.all([
    db
      .from("subscriptions")
      .select("id, package_id, status, change_type, starts_at, expires_at, price, billing_period, suspension_reason, ended_at, service_packages(name)")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("invoices")
      .select("id, invoice_number, issue_date, due_date, total, amount_paid, status")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("payments")
      .select("id, method, provider_reference, amount, transaction_at, status, verification_status, data_source")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("transaction_at", { ascending: false })
      .limit(50),
    db
      .from("support_tickets")
      .select("id, ticket_number, subject, status, priority, created_at")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  return {
    subscriptions: (subs.data ?? []) as unknown as CustomerHistory["subscriptions"],
    invoices: (invs.data ?? []) as CustomerHistory["invoices"],
    payments: (pays.data ?? []) as CustomerHistory["payments"],
    tickets: (tix.data ?? []) as CustomerHistory["tickets"],
  };
}

/** All customers matching the filters, for CSV export (no paging, capped at 20,000). */
export async function exportCustomers(db: SupabaseClient, tenantId: string, f: CustomerFilters) {
  const rows: (Customer & AccountSummary)[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await listCustomers(db, tenantId, { ...f, page }, 1000);
    if (!r.ok) return r;
    rows.push(...r.data.rows);
    if (r.data.rows.length < 1000) break;
  }
  return { ok: true as const, data: rows };
}
