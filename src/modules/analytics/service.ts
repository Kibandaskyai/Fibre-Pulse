/**
 * Revenue and dashboard analytics. Everything is read through the signed-in
 * user's client: the database functions (migration 20261125000100) check
 * revenue:view and RLS filters every row, so a role without access gets an
 * error or zero rows, never another ISP's data.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export type RevenueKpis = {
  from: string;
  to: string;
  today: string;
  collected: number;
  collected_count: number;
  collected_mpesa: number;
  collected_bank: number;
  collected_other: number;
  recognised: number;
  unapplied_credit: number;
  paying_customers: number;
  awaiting_verification: number;
  awaiting_verification_count: number;
  simulated_excluded: number;
  simulated_excluded_count: number;
  reversed: number;
  reversed_count: number;
  refunded: number;
  refunded_count: number;
  outstanding: number;
  outstanding_customers: number;
  overdue: number;
  invoiced: number;
  new_subscriptions: number;
  renewals: number;
  upgrades: number;
  downgrades: number;
  collected_today: number;
  collected_this_week: number;
  collected_this_month: number;
};

export type SeriesPoint = { bucket: string; collected: number; payments: number; reversed: number };
export type BreakdownRow = { label: string; amount: number; payments: number };
export type AgeingRow = { bucket: string; sort_order: number; invoices: number; customers: number; amount: number };
export type DistributionRow = { package: string; active: number; suspended: number; monthly_value: number };
export type GrowthRow = { month: string; new_customers: number; total_customers: number };

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const area = (a: string | null | undefined) => (a && a.trim() ? a.trim().slice(0, 80) : null);

export async function revenueKpis(db: SupabaseClient, tenantId: string, from: string, to: string, areaFilter?: string | null): Promise<Result<RevenueKpis>> {
  const { data, error } = await db.rpc("revenue_kpis", { p_tenant: tenantId, p_from: from, p_to: to, p_area: area(areaFilter) });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load revenue figures.") };
  const raw = data as Record<string, unknown>;
  const out = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, ["from", "to", "today"].includes(k) ? v : num(v)]));
  return { ok: true, data: out as RevenueKpis };
}

export async function revenueSeries(
  db: SupabaseClient,
  tenantId: string,
  from: string,
  to: string,
  grain: "day" | "month",
  areaFilter?: string | null,
): Promise<Result<SeriesPoint[]>> {
  const { data, error } = await db.rpc("revenue_series", { p_tenant: tenantId, p_from: from, p_to: to, p_grain: grain, p_area: area(areaFilter) });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load the revenue trend.") };
  return {
    ok: true,
    data: (data as SeriesPoint[]).map((r) => ({ bucket: r.bucket, collected: num(r.collected), payments: num(r.payments), reversed: num(r.reversed) })),
  };
}

export async function revenueBreakdown(
  db: SupabaseClient,
  tenantId: string,
  from: string,
  to: string,
  dimension: "package" | "area" | "method",
  areaFilter?: string | null,
): Promise<Result<BreakdownRow[]>> {
  const { data, error } = await db.rpc("revenue_breakdown", { p_tenant: tenantId, p_from: from, p_to: to, p_dimension: dimension, p_area: area(areaFilter) });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load the breakdown.") };
  return { ok: true, data: (data as BreakdownRow[]).map((r) => ({ label: r.label, amount: num(r.amount), payments: num(r.payments) })) };
}

export async function outstandingAgeing(db: SupabaseClient, tenantId: string, areaFilter?: string | null): Promise<Result<AgeingRow[]>> {
  const { data, error } = await db.rpc("outstanding_ageing", { p_tenant: tenantId, p_area: area(areaFilter) });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load outstanding balances.") };
  return {
    ok: true,
    data: (data as AgeingRow[]).map((r) => ({ ...r, invoices: num(r.invoices), customers: num(r.customers), amount: num(r.amount) })),
  };
}

export async function subscriptionDistribution(db: SupabaseClient, tenantId: string, areaFilter?: string | null): Promise<Result<DistributionRow[]>> {
  const { data, error } = await db.rpc("subscription_distribution", { p_tenant: tenantId, p_area: area(areaFilter) });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load the package mix.") };
  return {
    ok: true,
    data: (data as DistributionRow[]).map((r) => ({ package: r.package, active: num(r.active), suspended: num(r.suspended), monthly_value: num(r.monthly_value) })),
  };
}

export async function customerGrowth(db: SupabaseClient, tenantId: string, months = 12, areaFilter?: string | null): Promise<Result<GrowthRow[]>> {
  const { data, error } = await db.rpc("customer_growth", { p_tenant: tenantId, p_months: months, p_area: area(areaFilter) });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load customer growth.") };
  return {
    ok: true,
    data: (data as GrowthRow[]).map((r) => ({ month: r.month, new_customers: num(r.new_customers), total_customers: num(r.total_customers) })),
  };
}

/** Distinct estates, towns and counties for the area filter. */
export async function customerAreas(db: SupabaseClient, tenantId: string): Promise<{ area: string; kind: string; customers: number }[]> {
  const { data } = await db.rpc("customer_areas", { p_tenant: tenantId });
  return ((data ?? []) as { area: string; kind: string; customers: number }[]).map((r) => ({ ...r, customers: num(r.customers) }));
}

/** Customer counts by status and new registrations today (needs customers:view). */
export async function customerCounts(db: SupabaseClient, tenantId: string, today: string) {
  const head = () => db.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  const [total, active, suspended, pending, newToday] = await Promise.all([
    head().neq("status", "terminated"),
    head().eq("status", "active"),
    head().eq("status", "suspended"),
    head().eq("status", "pending_installation"),
    head().eq("registered_on", today),
  ]);
  return {
    total: total.count ?? 0,
    active: active.count ?? 0,
    suspended: suspended.count ?? 0,
    pending: pending.count ?? 0,
    newToday: newToday.count ?? 0,
  };
}

/** Router and alert counts (needs network:view / alerts:view). Simulated rows are counted separately. */
export async function networkCounts(db: SupabaseClient, tenantId: string) {
  const routers = await db.from("routers").select("status, data_source").eq("tenant_id", tenantId);
  const alerts = await db.from("network_alerts").select("severity, data_source").eq("tenant_id", tenantId).neq("status", "resolved");
  const r = routers.data ?? [];
  const a = alerts.data ?? [];
  return {
    routers: r.length,
    routersSimulated: r.filter((x) => x.data_source === "simulated").length,
    routersOnline: r.filter((x) => x.status === "online" && x.data_source !== "simulated").length,
    openIncidents: a.length,
    openIncidentsSimulated: a.filter((x) => x.data_source === "simulated").length,
    critical: a.filter((x) => x.severity === "critical").length,
  };
}

export async function recentPayments(db: SupabaseClient, tenantId: string, limit = 6) {
  const { data } = await db
    .from("payments")
    .select("id, method, provider_reference, amount, transaction_at, status, verification_status, data_source, customer_id, customers(full_name)")
    .eq("tenant_id", tenantId)
    .order("transaction_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as unknown as {
    id: string; method: string; provider_reference: string | null; amount: number; transaction_at: string; status: string;
    verification_status: string; data_source: "simulated" | "manual" | "connector" | "provider"; customer_id: string | null;
    customers: { full_name: string } | null;
  }[];
}

export async function recentCustomers(db: SupabaseClient, tenantId: string, limit = 6) {
  const { data } = await db
    .from("customers")
    .select("id, full_name, customer_number, estate, town, status, registered_on, data_source")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function criticalAlerts(db: SupabaseClient, tenantId: string, limit = 5) {
  const { data } = await db
    .from("network_alerts")
    .select("id, title, severity, status, data_source, created_at")
    .eq("tenant_id", tenantId)
    .neq("status", "resolved")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as { id: string; title: string; severity: string; status: string; data_source: "simulated" | "manual" | "connector" | "provider"; created_at: string }[];
}

export type BalanceRow = {
  id: string; customer_number: string | null; full_name: string; estate: string | null; town: string | null;
  status: string; outstanding: number; credit: number; last_payment_at: string | null;
};

/** Customers owing the most (needs customers:view). Area matches county, town or estate exactly. */
export async function topBalances(db: SupabaseClient, tenantId: string, areaFilter?: string | null, limit = 10): Promise<BalanceRow[]> {
  let q = db
    .from("customer_directory")
    .select("id, customer_number, full_name, estate, town, status, outstanding, credit, last_payment_at")
    .eq("tenant_id", tenantId)
    .gt("outstanding", 0)
    .order("outstanding", { ascending: false })
    .limit(limit);
  const a = area(areaFilter)?.replace(/[%_*,()\\:"']/g, " ").trim();
  if (a) q = q.or(`county.ilike."${a}",town.ilike."${a}",estate.ilike."${a}"`);
  const { data } = await q;
  return ((data ?? []) as BalanceRow[]).map((r) => ({ ...r, outstanding: num(r.outstanding), credit: num(r.credit) }));
}

export type DayPayment = {
  id: string; provider_reference: string | null; method: string; amount: number; transaction_at: string;
  customer_number: string | null; full_name: string | null; revenue_category: string;
};

/** Verified, successful payments in a range (for the daily report). Simulated payments can never be verified. */
export async function verifiedPayments(db: SupabaseClient, tenantId: string, fromIso: string, toIso: string, limit = 2000): Promise<DayPayment[]> {
  const { data } = await db
    .from("payments")
    .select("id, provider_reference, method, amount, transaction_at, revenue_category, customers(customer_number, full_name)")
    .eq("tenant_id", tenantId)
    .eq("status", "successful")
    .eq("verification_status", "verified")
    .gte("transaction_at", fromIso)
    .lt("transaction_at", toIso)
    .order("transaction_at")
    .limit(limit);
  return ((data ?? []) as unknown as (Omit<DayPayment, "customer_number" | "full_name"> & { customers: { customer_number: string | null; full_name: string } | null })[]).map(
    ({ customers, ...p }) => ({ ...p, amount: num(p.amount), customer_number: customers?.customer_number ?? null, full_name: customers?.full_name ?? null }),
  );
}
