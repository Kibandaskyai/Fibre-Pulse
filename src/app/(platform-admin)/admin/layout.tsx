import { ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { PLATFORM_NAV } from "@/components/layout/nav-config";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { PLATFORM_ROLE_LABELS } from "@/lib/auth/permissions";

const SUPER_ONLY = new Set(["/admin/agreements", "/admin/invoices", "/admin/audit"]);

export default async function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requirePlatformStaff();
  const roleLabel = PLATFORM_ROLE_LABELS[ctx.platformRole!];
  // Fees, agreements, invoices and the audit log are for super administrators only.
  const nav = ctx.platformRole === "super_admin" ? PLATFORM_NAV : PLATFORM_NAV.filter((i) => !SUPER_ONLY.has(i.href));
  return (
    <AppShell
      nav={nav}
      subtitle="Platform administration"
      areaLabel={`FibrePulse ${roleLabel}`}
      unreadCount={0}
      banner={
        <div className="flex items-center gap-2 border-b border-accent/30 bg-accent/10 px-4 py-2 text-xs sm:px-6">
          <ShieldCheck className="size-3.5 text-accent" aria-hidden />
          FibrePulse administration. ISP customer, payment and network records are not visible here without an owner-approved support grant.
        </div>
      }
      user={{
        fullName: ctx.fullName,
        email: ctx.email,
        roleLabel,
        memberships: [],
        activeTenantId: null,
        showAdminLink: false,
        showIspLink: Boolean(ctx.active),
      }}
    >
      {children}
    </AppShell>
  );
}
