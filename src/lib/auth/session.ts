import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isTenantRole, permissionsForRole, type Permission, type PlatformRole, type TenantRole } from "./permissions";

export const ACTIVE_TENANT_COOKIE = "fp_tenant";

export type TenantStatus = "pending" | "active" | "suspended" | "deactivated";

export type Membership = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: TenantStatus;
  role: TenantRole;
};

export type SessionContext = {
  userId: string;
  email: string;
  fullName: string;
  platformRole: PlatformRole | null;
  memberships: Membership[];
  /** The ISP the user is currently working in, if any. */
  active: (Membership & { permissions: ReadonlySet<Permission> }) | null;
};

/**
 * Loads the signed-in user, their profile and ISP memberships once per
 * request. Returns null when nobody is signed in.
 *
 * Note: permissions here drive the UI and give early, friendly errors.
 * Postgres RLS re-checks every query, so a bug here cannot leak data.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (!userId) return null;

  const [{ data: profile }, { data: rows }] = await Promise.all([
    supabase.from("profiles").select("full_name, email, platform_role").eq("id", userId).maybeSingle(),
    supabase
      .from("tenant_members")
      .select("role, status, tenant:tenants(id, name, slug, status)")
      .eq("profile_id", userId)
      .eq("status", "active"),
  ]);

  const memberships: Membership[] = [];
  for (const row of rows ?? []) {
    const tenant = Array.isArray(row.tenant) ? row.tenant[0] : row.tenant;
    if (!tenant || !isTenantRole(row.role)) continue;
    memberships.push({
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      tenantStatus: tenant.status as TenantStatus,
      role: row.role,
    });
  }
  memberships.sort((a, b) => a.tenantName.localeCompare(b.tenantName));

  const usable = memberships.filter((m) => m.tenantStatus === "active" || m.tenantStatus === "pending");
  const cookieStore = await cookies();
  const wanted = cookieStore.get(ACTIVE_TENANT_COOKIE)?.value;
  const chosen = usable.find((m) => m.tenantId === wanted) ?? usable[0] ?? null;

  return {
    userId,
    email: (profile?.email as string | null) ?? String(claimsData?.claims?.email ?? ""),
    fullName: profile?.full_name ?? "",
    platformRole: (profile?.platform_role as PlatformRole | null) ?? null,
    memberships,
    active: chosen ? { ...chosen, permissions: permissionsForRole(chosen.role) } : null,
  };
});
