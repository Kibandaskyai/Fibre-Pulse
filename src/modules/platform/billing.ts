/**
 * FibrePulse commercial platform: agreements, fee calculations, platform
 * invoices and analytics. Reads go through RLS (super admins and the ISP's
 * owner/finance can read commercial rows); every write and every cross-ISP
 * figure goes through the SECURITY DEFINER functions in migration
 * 20261128000100, which check the caller themselves.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const nOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export type Agreement = {
  id: string;
  tenant_id: string;
  version: number;
  status: "draft" | "active" | "superseded" | "terminated";
  fee_rate: number;
  fee_basis: "gross" | "net_of_vat";
  excluded_categories: string[];
  effective_from: string;
  effective_to: string | null;
  signed_at: string | null;
  signed_by_name: string | null;
  notes: string | null;
  created_at: string;
};

export type FeeRecord = {
  id: string;
  tenant_id: string;
  agreement_id: string;
  period_start: string;
  period_end: string;
  eligible_amount: number;
  fee_rate: number;
  fee_amount: number;
  payment_count: number;
  adjustment_of: string | null;
  reason: string | null;
  status: "calculated" | "invoiced" | "void";
  platform_invoice_id: string | null;
  calculated_at: string;
};

export type PlatformInvoice = {
  id: string;
  tenant_id: string;
  invoice_number: string;
  period_start: string;
  period_end: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  status: "draft" | "issued" | "paid" | "overdue" | "void";
  issued_at: string | null;
  due_date: string | null;
  paid_at: string | null;
  payment_reference: string | null;
  notes: string | null;
  void_reason: string | null;
  tenant_name?: string;
};

export const REVENUE_CATEGORY_LABELS: Record<string, string> = {
  subscription: "Internet subscriptions",
  installation: "Installation fees",
  equipment: "Equipment and router sales",
  other: "Other charges",
};

export const FEE_BASIS_LABELS: Record<string, string> = {
  gross: "Gross collections",
  net_of_vat: "Collections less 16% VAT",
};

/** Display status: an issued invoice past its due date is overdue. */
export function invoiceState(inv: Pick<PlatformInvoice, "status" | "due_date">, today: string): "issued" | "overdue" | "paid" | "void" | "draft" {
  if ((inv.status === "issued" || inv.status === "overdue") && inv.due_date && inv.due_date < today) return "overdue";
  return inv.status === "overdue" ? "issued" : inv.status;
}

/** 0.0275 -> "2.75%" */
export const ratePct = (rate: number) => `${(rate * 100).toLocaleString("en-KE", { maximumFractionDigits: 2 })}%`;

function agreementRow(r: Record<string, unknown>): Agreement {
  return { ...(r as Agreement), fee_rate: n(r.fee_rate), excluded_categories: (r.excluded_categories as string[]) ?? [] };
}
function feeRow(r: Record<string, unknown>): FeeRecord {
  return { ...(r as FeeRecord), eligible_amount: n(r.eligible_amount), fee_rate: n(r.fee_rate), fee_amount: n(r.fee_amount), payment_count: n(r.payment_count) };
}
function invoiceRow(r: Record<string, unknown>): PlatformInvoice {
  const t = r.tenants as { name?: string } | null | undefined;
  return {
    ...(r as PlatformInvoice),
    subtotal: n(r.subtotal),
    tax_rate: n(r.tax_rate),
    tax_amount: n(r.tax_amount),
    total: n(r.total),
    tenant_name: t?.name,
  };
}

export async function agreementsFor(db: SupabaseClient, tenantId: string): Promise<Result<Agreement[]>> {
  const { data, error } = await db.from("commercial_agreements").select("*").eq("tenant_id", tenantId).order("version", { ascending: false });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load agreements.") };
  return { ok: true, data: (data ?? []).map(agreementRow) };
}

export async function allAgreements(db: SupabaseClient): Promise<Result<(Agreement & { tenant_name: string })[]>> {
  const { data, error } = await db
    .from("commercial_agreements")
    .select("*, tenants(name)")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load agreements.") };
  return {
    ok: true,
    data: (data ?? []).map((r) => ({ ...agreementRow(r), tenant_name: (r.tenants as { name: string } | null)?.name ?? "" })),
  };
}

export async function feeRecordsFor(db: SupabaseClient, tenantId: string): Promise<Result<FeeRecord[]>> {
  const { data, error } = await db
    .from("platform_fee_records")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("period_start", { ascending: false })
    .order("calculated_at", { ascending: true })
    .limit(240);
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load fee calculations.") };
  return { ok: true, data: (data ?? []).map(feeRow) };
}

export async function invoicesFor(db: SupabaseClient, tenantId?: string, status?: string): Promise<Result<PlatformInvoice[]>> {
  let query = db.from("platform_invoices").select("*, tenants(name)").order("issued_at", { ascending: false, nullsFirst: false }).limit(300);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  if (status === "unpaid") query = query.in("status", ["issued", "overdue"]);
  else if (status && ["paid", "void"].includes(status)) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load invoices.") };
  return { ok: true, data: (data ?? []).map(invoiceRow) };
}

export async function getInvoice(db: SupabaseClient, id: string): Promise<Result<{ invoice: PlatformInvoice; lines: FeeRecord[] } | null>> {
  const { data, error } = await db.from("platform_invoices").select("*, tenants(name)").eq("id", id).maybeSingle();
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load the invoice.") };
  if (!data) return { ok: true, data: null };
  const { data: lines, error: e2 } = await db
    .from("platform_fee_records")
    .select("*")
    .eq("platform_invoice_id", id)
    .order("period_start")
    .order("calculated_at");
  if (e2) return { ok: false, message: friendlyDbError(e2, "Could not load the invoice lines.") };
  return { ok: true, data: { invoice: invoiceRow(data), lines: (lines ?? []).map(feeRow) } };
}

export type PlatformSummary = {
  tenants: number;
  active: number;
  pending: number;
  suspended: number;
  deactivated: number;
  signed_agreements: number;
  eligible_total: number;
  fees_total: number;
  fees_uninvoiced: number;
  invoiced_total: number;
  paid_total: number;
  unpaid_total: number;
  unpaid_count: number;
  overdue_total: number;
  overdue_count: number;
  customers: number;
  mtd_eligible: number;
  mtd_fee: number;
  month: string;
};

export async function platformSummary(db: SupabaseClient): Promise<Result<PlatformSummary>> {
  const { data, error } = await db.rpc("admin_platform_summary");
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load platform figures.") };
  const raw = data as Record<string, unknown>;
  return { ok: true, data: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, k === "month" ? v : n(v)])) as PlatformSummary };
}

export type MonthlyRow = { month: string; eligible: number; fees: number; invoiced: number; paid: number; new_isps: number; activated_isps: number; new_customers: number };

export async function platformMonthly(db: SupabaseClient, months = 12): Promise<Result<MonthlyRow[]>> {
  const { data, error } = await db.rpc("admin_platform_monthly", { p_months: months });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load the monthly trend.") };
  return {
    ok: true,
    data: (data as Record<string, unknown>[]).map((r) => ({
      month: String(r.month),
      eligible: n(r.eligible),
      fees: n(r.fees),
      invoiced: n(r.invoiced),
      paid: n(r.paid),
      new_isps: n(r.new_isps),
      activated_isps: n(r.activated_isps),
      new_customers: n(r.new_customers),
    })),
  };
}

export type IspRevenueRow = {
  tenant_id: string;
  name: string;
  status: string;
  agreement_state: "signed" | "draft" | "none";
  fee_rate: number | null;
  fee_basis: string | null;
  customers: number;
  active_subscriptions: number;
  mtd_eligible: number | null;
  mtd_fee: number | null;
  fees_total: number;
  fees_uninvoiced: number;
  unpaid: number;
  overdue: number;
  last_calculated: string | null;
};

export async function ispRevenue(db: SupabaseClient): Promise<Result<IspRevenueRow[]>> {
  const { data, error } = await db.rpc("admin_isp_revenue");
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load revenue per ISP.") };
  return {
    ok: true,
    data: (data as Record<string, unknown>[]).map((r) => ({
      tenant_id: String(r.tenant_id),
      name: String(r.name),
      status: String(r.status),
      agreement_state: r.agreement_state as IspRevenueRow["agreement_state"],
      fee_rate: nOrNull(r.fee_rate),
      fee_basis: (r.fee_basis as string) ?? null,
      customers: n(r.customers),
      active_subscriptions: n(r.active_subscriptions),
      mtd_eligible: nOrNull(r.mtd_eligible),
      mtd_fee: nOrNull(r.mtd_fee),
      fees_total: n(r.fees_total),
      fees_uninvoiced: n(r.fees_uninvoiced),
      unpaid: n(r.unpaid),
      overdue: n(r.overdue),
      last_calculated: (r.last_calculated as string) ?? null,
    })),
  };
}

export type SupportGrant = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  requested_by: string;
  reason: string;
  state: "waiting" | "active" | "expired" | "revoked" | "declined";
  created_at: string;
  approved_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  /** Requested by the signed-in staff member. */
  mine: boolean;
};

export async function supportGrants(db: SupabaseClient): Promise<Result<SupportGrant[]>> {
  const { data, error } = await db.rpc("admin_support_grants");
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load support access requests.") };
  return { ok: true, data: data as SupportGrant[] };
}

/** Requests for one ISP, read as its owner through RLS. */
export async function ispSupportGrants(db: SupabaseClient, tenantId: string) {
  const { data, error } = await db
    .from("support_access_grants")
    .select("id, requested_reason, created_at, approved_at, expires_at, revoked_at, granted_to")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return { ok: false as const, message: friendlyDbError(error, "Could not load support access requests.") };
  return { ok: true as const, data: data ?? [] };
}

export function grantState(g: { approved_at: string | null; expires_at: string | null; revoked_at: string | null }, now = Date.now()): SupportGrant["state"] {
  if (g.revoked_at && !g.approved_at) return "declined";
  if (g.revoked_at) return "revoked";
  if (!g.approved_at) return "waiting";
  if (g.expires_at && Date.parse(g.expires_at) <= now) return "expired";
  return "active";
}

/** Recent platform audit entries (RLS limits super admins to platform tables). */
export async function platformAudit(db: SupabaseClient, entity?: string) {
  let query = db
    .from("audit_logs")
    .select("id, tenant_id, actor_id, action, entity_type, entity_id, before_data, after_data, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (entity) query = query.eq("entity_type", entity);
  const { data, error } = await query;
  if (error) return { ok: false as const, message: friendlyDbError(error, "Could not load the audit log.") };
  return { ok: true as const, data: data ?? [] };
}

/** Fee records grouped by month: base, adjustments and the month's net. */
export function feeMonths(records: FeeRecord[]) {
  const by = new Map<string, { period_start: string; base: FeeRecord | null; adjustments: FeeRecord[]; eligible: number; fee: number; status: string }>();
  for (const r of records) {
    if (r.status === "void") continue;
    const m = by.get(r.period_start) ?? { period_start: r.period_start, base: null, adjustments: [], eligible: 0, fee: 0, status: "invoiced" };
    if (r.adjustment_of) m.adjustments.push(r);
    else m.base = r;
    m.eligible += r.eligible_amount;
    m.fee += r.fee_amount;
    if (r.status === "calculated") m.status = "calculated";
    by.set(r.period_start, m);
  }
  return [...by.values()]
    .map((m) => ({ ...m, eligible: Math.round(m.eligible * 100) / 100, fee: Math.round(m.fee * 100) / 100 }))
    .sort((a, b) => b.period_start.localeCompare(a.period_start));
}
