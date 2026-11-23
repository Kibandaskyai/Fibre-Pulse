import "server-only";
import { redirect } from "next/navigation";
import { getSessionContext, type SessionContext } from "./session";
import type { Permission } from "./permissions";

export class AuthorizationError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** For pages: signed-in user or redirect to login. */
export async function requireUser(): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login");
  return ctx;
}

/** For ISP pages: user with an active ISP, or send them to onboarding. */
export async function requireTenant(): Promise<SessionContext & { active: NonNullable<SessionContext["active"]> }> {
  const ctx = await requireUser();
  if (!ctx.active) redirect(ctx.platformRole ? "/admin" : "/onboarding");
  return ctx as SessionContext & { active: NonNullable<SessionContext["active"]> };
}

/** For ISP pages that need a permission: otherwise show the not-allowed page. */
export async function requirePagePermission(permission: Permission) {
  const ctx = await requireTenant();
  if (!ctx.active.permissions.has(permission)) redirect("/not-allowed");
  return ctx;
}

/** For server actions: throws instead of redirecting. */
export async function assertPermission(permission: Permission) {
  const ctx = await getSessionContext();
  if (!ctx?.active) throw new AuthorizationError("Sign in to an ISP account first.");
  if (!ctx.active.permissions.has(permission)) throw new AuthorizationError();
  return ctx as SessionContext & { active: NonNullable<SessionContext["active"]> };
}

/** For platform admin pages. */
export async function requirePlatformStaff(): Promise<SessionContext> {
  const ctx = await requireUser();
  if (!ctx.platformRole) redirect("/not-allowed");
  return ctx;
}

export async function assertPlatformAdmin(): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (ctx?.platformRole !== "super_admin") throw new AuthorizationError("Only FibrePulse super administrators can do that.");
  return ctx;
}
