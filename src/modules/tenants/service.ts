/**
 * Tenant (ISP) and staff management.
 *
 * Every function takes a Supabase client that acts as the signed-in user, so
 * Postgres RLS enforces tenant isolation and role permissions on each call.
 * Callers (server actions) check permissions first to give clear messages.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantRole } from "@/lib/auth/permissions";
import type { RegisterTenantInput } from "@/lib/validation/tenants";
import { friendlyDbError } from "@/lib/validation/db-errors";

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export async function registerTenant(db: SupabaseClient, input: RegisterTenantInput): Promise<Result<{ tenantId: string }>> {
  const { data, error } = await db.rpc("register_tenant", {
    p_name: input.name,
    p_slug: input.slug,
    p_county: input.county,
    p_town: input.town || null,
    p_contact_phone: input.contactPhone,
    p_owner_name: input.ownerName || null,
  });
  if (error) {
    if (error.code === "23505" || /already taken/.test(error.message)) {
      return { ok: false, message: "That workspace address is already taken. Try another." };
    }
    return { ok: false, message: friendlyDbError(error, "Could not register the ISP.") };
  }
  return { ok: true, data: { tenantId: data as string } };
}

export type StaffMember = {
  id: string;
  profileId: string;
  fullName: string;
  email: string;
  role: TenantRole;
  status: "active" | "disabled";
  joinedAt: string;
};

export async function listStaff(db: SupabaseClient, tenantId: string): Promise<Result<StaffMember[]>> {
  const { data, error } = await db
    .from("tenant_members")
    .select("id, role, status, created_at, profile:profiles!tenant_members_profile_id_fkey(id, full_name, email)")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load staff.") };
  return {
    ok: true,
    data: (data ?? []).map((row) => {
      const p = Array.isArray(row.profile) ? row.profile[0] : row.profile;
      return {
        id: row.id,
        profileId: p?.id ?? "",
        fullName: p?.full_name ?? "",
        email: p?.email ?? "",
        role: row.role as TenantRole,
        status: row.status as "active" | "disabled",
        joinedAt: row.created_at,
      };
    }),
  };
}

export type Invitation = { id: string; email: string; role: TenantRole; expiresAt: string; createdAt: string };

export async function listOpenInvitations(db: SupabaseClient, tenantId: string): Promise<Result<Invitation[]>> {
  const { data, error } = await db
    .from("tenant_invitations")
    .select("id, email, role, expires_at, created_at")
    .eq("tenant_id", tenantId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not load invitations.") };
  return {
    ok: true,
    data: (data ?? []).map((r) => ({ id: r.id, email: r.email, role: r.role as TenantRole, expiresAt: r.expires_at, createdAt: r.created_at })),
  };
}

export async function inviteStaff(
  db: SupabaseClient,
  args: { tenantId: string; invitedBy: string; email: string; role: TenantRole },
): Promise<Result<{ invitationId: string }>> {
  const { data, error } = await db
    .from("tenant_invitations")
    .insert({ tenant_id: args.tenantId, email: args.email, role: args.role, invited_by: args.invitedBy })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, message: "There is already an open invitation for that email." };
    return { ok: false, message: friendlyDbError(error, "Could not create the invitation.") };
  }
  return { ok: true, data: { invitationId: data.id } };
}

export async function revokeInvitation(db: SupabaseClient, tenantId: string, invitationId: string): Promise<Result<null>> {
  const { error, count } = await db
    .from("tenant_invitations")
    .update({ revoked_at: new Date().toISOString() }, { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("id", invitationId);
  if (error) return { ok: false, message: friendlyDbError(error) };
  if (!count) return { ok: false, message: "Invitation not found." };
  return { ok: true, data: null };
}

export async function updateMember(
  db: SupabaseClient,
  tenantId: string,
  memberId: string,
  patch: { role?: TenantRole; status?: "active" | "disabled" },
): Promise<Result<null>> {
  const { error, count } = await db
    .from("tenant_members")
    .update(patch, { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("id", memberId);
  if (error) {
    if (/at least one active owner/.test(error.message)) return { ok: false, message: "An ISP must keep at least one active owner." };
    return { ok: false, message: friendlyDbError(error) };
  }
  if (!count) return { ok: false, message: "Staff member not found." };
  return { ok: true, data: null };
}

export type MyInvitation = { id: string; tenantName: string; role: TenantRole; expiresAt: string };

/** Open invitations addressed to the signed-in user's own email. */
export async function listMyInvitations(db: SupabaseClient): Promise<Result<MyInvitation[]>> {
  const { data, error } = await db.rpc("my_invitations");
  if (error) return { ok: false, message: friendlyDbError(error) };
  return {
    ok: true,
    data: ((data ?? []) as { id: string; tenant_name: string; role: TenantRole; expires_at: string }[]).map((r) => ({
      id: r.id,
      tenantName: r.tenant_name,
      role: r.role,
      expiresAt: r.expires_at,
    })),
  };
}

export async function acceptInvitation(db: SupabaseClient, invitationId: string): Promise<Result<{ tenantId: string }>> {
  const { data, error } = await db.rpc("accept_invitation", { p_invitation_id: invitationId });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not accept the invitation.") };
  return { ok: true, data: { tenantId: data as string } };
}
