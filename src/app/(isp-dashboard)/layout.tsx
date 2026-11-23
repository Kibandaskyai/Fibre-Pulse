import { Clock } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { visibleIspNav } from "@/components/layout/nav-config";
import { requireTenant } from "@/lib/auth/guards";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

export default async function IspDashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireTenant();
  const db = await createClient();
  const { count } = await db
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_id", ctx.userId)
    .is("read_at", null);

  const banner =
    ctx.active.tenantStatus === "pending" ? (
      <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-foreground sm:px-6">
        <Clock className="size-3.5 text-warning" aria-hidden />
        <span>
          <strong>{ctx.active.tenantName}</strong> is awaiting activation by FibrePulse. You can set up staff and settings meanwhile.
        </span>
      </div>
    ) : null;

  return (
    <AppShell
      nav={visibleIspNav(ctx.active.permissions)}
      subtitle={ctx.active.tenantName}
      banner={banner}
      unreadCount={count ?? 0}
      areaLabel={`${ROLE_LABELS[ctx.active.role]} · KES · Africa/Nairobi`}
      user={{
        fullName: ctx.fullName,
        email: ctx.email,
        roleLabel: ROLE_LABELS[ctx.active.role],
        memberships: ctx.memberships
          .filter((m) => m.tenantStatus === "active" || m.tenantStatus === "pending")
          .map((m) => ({ tenantId: m.tenantId, tenantName: m.tenantName })),
        activeTenantId: ctx.active.tenantId,
        showAdminLink: Boolean(ctx.platformRole),
        showIspLink: false,
      }}
    >
      {children}
    </AppShell>
  );
}
