/**
 * FibrePulse platform administration. Uses SECURITY DEFINER database
 * functions that return tenant-level facts only, never ISP customer,
 * payment or network records.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type TenantStatus = "pending" | "active" | "suspended" | "deactivated";

export type AdminTenantRow = {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  county: string | null;
  town: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  staffCount: number;
  createdAt: string;
  activatedAt: string | null;
};

export async function listTenants(db: SupabaseClient): Promise<{ ok: true; data: AdminTenantRow[] } | { ok: false; message: string }> {
  const { data, error } = await db.rpc("admin_list_tenants");
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load ISPs.") };
  return {
    ok: true,
    data: (data as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      slug: r.slug as string,
      status: r.status as TenantStatus,
      county: (r.county as string) ?? null,
      town: (r.town as string) ?? null,
      ownerName: (r.owner_name as string) ?? null,
      ownerEmail: (r.owner_email as string) ?? null,
      staffCount: Number(r.staff_count ?? 0),
      createdAt: r.created_at as string,
      activatedAt: (r.activated_at as string) ?? null,
    })),
  };
}

export async function setTenantStatus(db: SupabaseClient, tenantId: string, status: TenantStatus, reason: string) {
  const { error } = await db.rpc("admin_set_tenant_status", { p_tenant: tenantId, p_status: status, p_reason: reason });
  if (error) return { ok: false as const, message: friendlyDbError(error, "Could not change the status.") };
  return { ok: true as const };
}
