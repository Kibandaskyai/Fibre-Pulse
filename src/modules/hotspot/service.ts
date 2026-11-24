/**
 * Hotspot (pilot client, 24 Nov 2026): plans people buy for one phone or
 * gadget at a time, the access codes those purchases create, and the
 * network-status and money figures the owner watches. Reads and writes use
 * the signed-in user's Supabase client; the database checks permissions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError } from "@/lib/validation/db-errors";
import type { HotspotPlanInput } from "@/lib/validation/hotspot";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export type HotspotPlan = {
  id: string;
  name: string;
  duration_minutes: number;
  price: number;
  download_mbps: number;
  upload_mbps: number;
  usage_type: "limited" | "unlimited";
  data_limit_mb: number | null;
  network_profile: string | null;
  status: "active" | "inactive" | "archived";
  sort_order: number;
};

export type VoucherStatus = "awaiting_payment" | "unused" | "active" | "expired" | "cancelled" | "payment_failed";
export type VoucherSource = "portal" | "paybill" | "staff" | "complimentary";

export type HotspotCode = {
  id: string;
  code: string;
  plan_name: string;
  price: number;
  duration_minutes: number;
  /** Limited plans: data for the period, and data used so far (MB). */
  data_limit_mb: number | null;
  used_mb: number;
  source: VoucherSource;
  status: VoucherStatus;
  phone: string | null;
  mac_address: string | null;
  activated_at: string | null;
  expires_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  reason: string | null;
  data_source: "simulated" | "manual" | "connector" | "provider";
  created_at: string;
};

export type HotspotSummary = {
  active_codes: number;
  unused_codes: number;
  awaiting_payment: number;
  sold_today: number;
  sales_today: number;
  free_today: number;
  expiring_hour: number;
  simulated: boolean;
  devices: number;
  devices_30d: number;
  plans: number;
  plans_unlimited: number;
  by_plan_today: { plan: string; count: number; amount: number }[];
  active_by_plan: Record<string, number>;
};

export type NetworkState = "ok" | "upstream_down" | "site_unreachable" | "not_monitored";

export type NetworkStatus = {
  state: NetworkState;
  since: string | null;
  provider: string;
  provider_phone: string | null;
  routers: number;
  routers_upstream_down: number;
  simulated: boolean;
  online_hotspot: number | null;
  online_pppoe: number | null;
  online_total: number | null;
  online_simulated: boolean;
};

export type ServiceRow = { bucket: string; hotspot: number; monthly: number; unlinked: number; hotspot_sales: number; awaiting_verification: number };

const PLAN_COLUMNS = "id, name, duration_minutes, price, download_mbps, upload_mbps, usage_type, data_limit_mb, network_profile, status, sort_order";
const CODE_COLUMNS =
  "id, code, plan_name, price, duration_minutes, data_limit_mb, source, status, phone, mac_address, activated_at, expires_at, ended_at, end_reason, reason, data_source, created_at, hotspot_voucher_usage(used_bytes)";

const num = (v: unknown) => Number(v ?? 0);

export async function listPlans(db: SupabaseClient, tenantId: string, opts: { includeArchived?: boolean; onSaleOnly?: boolean } = {}): Promise<Result<HotspotPlan[]>> {
  let q = db.from("hotspot_plans").select(PLAN_COLUMNS).eq("tenant_id", tenantId);
  if (opts.onSaleOnly) q = q.eq("status", "active");
  else if (!opts.includeArchived) q = q.neq("status", "archived");
  const { data, error } = await q.order("sort_order").order("duration_minutes").order("price");
  if (error) return { ok: false, message: friendlyDbError(error) };
  return { ok: true, data: (data ?? []).map((p) => ({ ...p, price: num(p.price), download_mbps: num(p.download_mbps), upload_mbps: num(p.upload_mbps) })) as HotspotPlan[] };
}

export async function getPlan(db: SupabaseClient, tenantId: string, id: string): Promise<HotspotPlan | null> {
  const { data } = await db.from("hotspot_plans").select(PLAN_COLUMNS).eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  return (data as HotspotPlan | null) ?? null;
}

export async function savePlan(db: SupabaseClient, tenantId: string, id: string | null, input: HotspotPlanInput): Promise<Result<string>> {
  const { data, error } = await db.rpc("save_hotspot_plan", {
    p_tenant: tenantId,
    p_plan: id,
    p_name: input.name,
    p_duration_minutes: input.durationMinutes,
    p_price: input.price,
    p_download_mbps: input.downloadMbps,
    p_upload_mbps: input.uploadMbps ?? input.downloadMbps,
    p_usage_type: input.usageType,
    p_data_limit_mb: input.dataLimitMb,
    p_network_profile: input.networkProfile,
    p_sort_order: input.sortOrder ?? 0,
  });
  if (error) return { ok: false, message: error.code === "23505" ? "A plan with that name already exists." : friendlyDbError(error) };
  return { ok: true, data: data as string };
}

export async function setPlanStatus(db: SupabaseClient, id: string, status: HotspotPlan["status"]): Promise<Result<null>> {
  const { error } = await db.rpc("set_hotspot_plan_status", { p_plan: id, p_status: status });
  return error ? { ok: false, message: friendlyDbError(error) } : { ok: true, data: null };
}

export async function hotspotSummary(db: SupabaseClient, tenantId: string): Promise<HotspotSummary | null> {
  const { data, error } = await db.rpc("hotspot_summary", { p_tenant: tenantId });
  if (error || !data) return null;
  const s = data as HotspotSummary;
  return { ...s, sales_today: num(s.sales_today), by_plan_today: (s.by_plan_today ?? []).map((r) => ({ ...r, amount: num(r.amount) })) };
}

export async function networkStatus(db: SupabaseClient, tenantId: string): Promise<NetworkStatus | null> {
  const { data, error } = await db.rpc("network_status", { p_tenant: tenantId });
  if (error || !data) return null;
  return data as NetworkStatus;
}

export const PAGE_SIZE = 25;

/** Codes, newest first. Search by code or phone; filter by status. */
export async function listCodes(
  db: SupabaseClient,
  tenantId: string,
  opts: { q?: string; status?: string; page?: number },
): Promise<Result<{ rows: HotspotCode[]; total: number }>> {
  const page = Math.max(1, opts.page ?? 1);
  let q = db.from("hotspot_vouchers").select(CODE_COLUMNS, { count: "estimated" }).eq("tenant_id", tenantId);
  const search = (opts.q ?? "").trim();
  if (search) {
    const digits = search.replace(/[\s()-]/g, "");
    const phone = /^0[17]\d{8}$/.test(digits) ? `+254${digits.slice(1)}` : /^\+?254[17]\d{8}$/.test(digits) ? `+${digits.replace(/^\+/, "")}` : null;
    if (phone) q = q.eq("phone", phone);
    else if (/^[A-Za-z0-9]{4,12}$/.test(search)) q = q.eq("code", search.toUpperCase());
    else return { ok: true, data: { rows: [], total: 0 } };
  }
  if (opts.status === "live") q = q.in("status", ["unused", "active"]);
  else if (opts.status) q = q.eq("status", opts.status);
  else q = q.neq("status", "awaiting_payment");
  const { data, error, count } = await q.order("created_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error) return { ok: false, message: friendlyDbError(error) };
  const rows = (data ?? []).map(({ hotspot_voucher_usage: u, ...r }) => {
    const usage = (Array.isArray(u) ? u[0] : u) as { used_bytes: number | string } | null | undefined;
    return { ...r, price: num(r.price), used_mb: num(usage?.used_bytes) / 1048576 };
  });
  return { ok: true, data: { rows: rows as HotspotCode[], total: count ?? 0 } };
}

type Issued = { voucher_id: string; code: string };

export async function sellCode(db: SupabaseClient, tenantId: string, planId: string, phone: string | null, mpesaReference: string): Promise<Result<Issued>> {
  const { data, error } = await db.rpc("sell_hotspot_voucher", { p_tenant: tenantId, p_plan: planId, p_phone: phone, p_mpesa_reference: mpesaReference });
  if (error) {
    if (error.code === "23505") return { ok: false, message: "That M-Pesa transaction code is already recorded. Check for a duplicate." };
    return { ok: false, message: friendlyDbError(error) };
  }
  return { ok: true, data: (data as Issued[])[0] };
}

export async function giveFreeCode(db: SupabaseClient, tenantId: string, planId: string, phone: string | null, reason: string): Promise<Result<Issued>> {
  const { data, error } = await db.rpc("give_free_hotspot_voucher", { p_tenant: tenantId, p_plan: planId, p_phone: phone, p_reason: reason });
  if (error) return { ok: false, message: friendlyDbError(error) };
  return { ok: true, data: (data as Issued[])[0] };
}

export async function resendCode(db: SupabaseClient, id: string, phone: string | null): Promise<Result<null>> {
  const { error } = await db.rpc("resend_hotspot_code_sms", { p_voucher: id, p_phone: phone });
  return error ? { ok: false, message: friendlyDbError(error) } : { ok: true, data: null };
}

export async function cancelCode(db: SupabaseClient, id: string, reason: string): Promise<Result<null>> {
  const { error } = await db.rpc("cancel_hotspot_voucher", { p_voucher: id, p_reason: reason });
  return error ? { ok: false, message: friendlyDbError(error) } : { ok: true, data: null };
}

export async function compensateOutage(db: SupabaseClient, tenantId: string, minutes: number, reason: string): Promise<Result<number>> {
  const { data, error } = await db.rpc("compensate_hotspot_outage", { p_tenant: tenantId, p_minutes: minutes, p_reason: reason });
  return error ? { ok: false, message: friendlyDbError(error) } : { ok: true, data: Number(data ?? 0) };
}

export async function revenueByService(db: SupabaseClient, tenantId: string, from: string, to: string, grain: "day" | "month"): Promise<Result<ServiceRow[]>> {
  const { data, error } = await db.rpc("revenue_by_service", { p_tenant: tenantId, p_from: from, p_to: to, p_grain: grain });
  if (error) return { ok: false, message: friendlyDbError(error) };
  return {
    ok: true,
    data: ((data ?? []) as ServiceRow[]).map((r) => ({
      bucket: r.bucket,
      hotspot: num(r.hotspot),
      monthly: num(r.monthly),
      unlinked: num(r.unlinked),
      hotspot_sales: num(r.hotspot_sales),
      awaiting_verification: num(r.awaiting_verification),
    })),
  };
}

export type ServiceSettings = {
  methods: ("mpesa" | "bank_transfer" | "other")[];
  paybill: string | null;
  /** The account number buyers enter when paying the paybill. */
  accountNumber: string | null;
  upstreamProvider: string;
  upstreamPhone: string | null;
  upstreamCheckTarget: string;
  /** When a hotspot code's time starts: at payment (default) or at first login. */
  hotspotClockStart: "payment" | "first_login";
};

export function readServiceSettings(settings: Record<string, unknown> | null | undefined): ServiceSettings {
  const s = settings ?? {};
  const methods = Array.isArray(s.payment_methods) ? (s.payment_methods as ServiceSettings["methods"]) : ["mpesa", "bank_transfer", "other"];
  return {
    methods: methods as ServiceSettings["methods"],
    paybill: typeof s.mpesa_paybill === "string" ? s.mpesa_paybill : null,
    accountNumber: typeof s.mpesa_account_number === "string" ? s.mpesa_account_number : null,
    upstreamProvider: typeof s.upstream_provider === "string" ? s.upstream_provider : "Safaricom",
    upstreamPhone: typeof s.upstream_support_phone === "string" ? s.upstream_support_phone : null,
    upstreamCheckTarget: typeof s.upstream_check_target === "string" ? s.upstream_check_target : "8.8.8.8",
    hotspotClockStart: s.hotspot_clock_start === "first_login" ? "first_login" : "payment",
  };
}

export async function saveServiceSettings(db: SupabaseClient, tenantId: string, s: Omit<ServiceSettings, "upstreamCheckTarget"> & { upstreamCheckTarget: string | null }): Promise<Result<null>> {
  const { error } = await db.rpc("save_service_settings", {
    p_tenant: tenantId,
    p_methods: s.methods,
    p_paybill: s.paybill,
    p_upstream_provider: s.upstreamProvider,
    p_upstream_phone: s.upstreamPhone,
    p_upstream_check_target: s.upstreamCheckTarget,
    p_hotspot_clock_start: s.hotspotClockStart,
    p_account_number: s.accountNumber,
  });
  return error ? { ok: false, message: friendlyDbError(error) } : { ok: true, data: null };
}

/** Accepted payment methods for the record-payment form. */
export async function acceptedMethods(db: SupabaseClient, tenantId: string): Promise<ServiceSettings["methods"]> {
  const { data } = await db.from("tenants").select("settings").eq("id", tenantId).maybeSingle();
  return readServiceSettings((data?.settings ?? null) as Record<string, unknown> | null).methods;
}

export const VOUCHER_STATUS_LABELS: Record<VoucherStatus, string> = {
  awaiting_payment: "Waiting for M-Pesa",
  unused: "Not used yet",
  active: "Running",
  expired: "Time used up",
  cancelled: "Cancelled",
  payment_failed: "Payment failed",
};

export const VOUCHER_SOURCE_LABELS: Record<VoucherSource, string> = {
  portal: "Bought on WiFi page",
  paybill: "Paid to paybill",
  staff: "Sold by owner",
  complimentary: "Free (owner)",
};
