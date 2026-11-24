import { redirect } from "next/navigation";
import { requireTenant } from "@/lib/auth/guards";

/** Supervisors (jobs:view) see every job; technicians (jobs:update_own) see their own. */
export async function requireFieldAccess() {
  const ctx = await requireTenant();
  const perms = ctx.active.permissions;
  if (!perms.has("jobs:view") && !perms.has("jobs:update_own")) redirect("/not-allowed");
  return { ctx, supervisor: perms.has("jobs:view"), canPlan: perms.has("jobs:edit") };
}
