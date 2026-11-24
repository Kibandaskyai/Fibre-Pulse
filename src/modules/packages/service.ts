/**
 * Service packages. Reads and writes go through the signed-in user's
 * Supabase client, so RLS checks packages:view / packages:edit.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PackageInput } from "@/lib/validation/billing";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export type ServicePackage = {
  id: string;
  name: string;
  description: string | null;
  download_mbps: number;
  upload_mbps: number;
  price: number;
  billing_period: "daily" | "weekly" | "monthly" | "custom";
  connection_type: "pppoe" | "static";
  duration_days: number | null;
  data_limit_gb: number | null;
  fair_usage_policy: string | null;
  network_profile: string | null;
  status: "active" | "inactive" | "archived";
  revenue_category: string;
  created_at: string;
};

const COLUMNS =
  "id, name, description, download_mbps, upload_mbps, price, billing_period, connection_type, duration_days, data_limit_gb, fair_usage_policy, network_profile, status, revenue_category, created_at";

function toRow(input: PackageInput) {
  return {
    name: input.name,
    description: input.description,
    download_mbps: input.downloadMbps,
    upload_mbps: input.uploadMbps,
    price: input.price,
    billing_period: input.billingPeriod,
    connection_type: input.connectionType,
    duration_days: input.durationDays,
    data_limit_gb: input.dataLimitGb,
    fair_usage_policy: input.fairUsagePolicy,
    network_profile: input.networkProfile,
    revenue_category: input.revenueCategory,
  };
}

export async function listPackages(
  db: SupabaseClient,
  tenantId: string,
  opts: { includeArchived?: boolean; activeOnly?: boolean } = {},
): Promise<Result<(ServicePackage & { live_subscriptions: number })[]>> {
  let q = db.from("service_packages").select(COLUMNS).eq("tenant_id", tenantId).order("status").order("price");
  if (opts.activeOnly) q = q.eq("status", "active");
  else if (!opts.includeArchived) q = q.neq("status", "archived");
  const { data, error } = await q;
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load packages.") };

  const { data: subs } = await db
    .from("subscriptions")
    .select("package_id")
    .eq("tenant_id", tenantId)
    .in("status", ["active", "suspended"]);
  const counts = new Map<string, number>();
  for (const s of subs ?? []) counts.set(s.package_id, (counts.get(s.package_id) ?? 0) + 1);
  return { ok: true, data: (data as ServicePackage[]).map((p) => ({ ...p, live_subscriptions: counts.get(p.id) ?? 0 })) };
}

export async function getPackage(db: SupabaseClient, tenantId: string, id: string): Promise<Result<ServicePackage>> {
  const { data, error } = await db.from("service_packages").select(COLUMNS).eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load the package.") };
  if (!data) return { ok: false, message: "Package not found." };
  return { ok: true, data: data as ServicePackage };
}

export async function createPackage(db: SupabaseClient, tenantId: string, input: PackageInput): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("service_packages")
    .insert({ tenant_id: tenantId, ...toRow(input) })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, message: "A package with that name already exists." };
    return { ok: false, message: friendlyDbError(error, "Could not create the package.") };
  }
  return { ok: true, data: { id: data.id } };
}

/**
 * Editing a package never changes existing subscriptions: each subscription
 * keeps the price and period it was bought at.
 */
export async function updatePackage(db: SupabaseClient, tenantId: string, id: string, input: PackageInput): Promise<Result<null>> {
  const { data, error } = await db.from("service_packages").update(toRow(input)).eq("tenant_id", tenantId).eq("id", id).select("id");
  if (error) {
    if (error.code === "23505") return { ok: false, message: "A package with that name already exists." };
    return { ok: false, message: friendlyDbError(error, "Could not save the package.") };
  }
  if (!data?.length) return { ok: false, message: "Package not found." };
  return { ok: true, data: null };
}

export async function setPackageStatus(
  db: SupabaseClient,
  tenantId: string,
  id: string,
  status: ServicePackage["status"],
): Promise<Result<null>> {
  const { data, error } = await db.from("service_packages").update({ status }).eq("tenant_id", tenantId).eq("id", id).select("id");
  if (error) return { ok: false, message: friendlyDbError(error, "Could not change the package status.") };
  if (!data?.length) return { ok: false, message: "Package not found." };
  return { ok: true, data: null };
}
