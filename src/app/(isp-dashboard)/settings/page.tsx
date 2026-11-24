import type { Metadata } from "next";
import Link from "next/link";
import { Building2, ChevronRight, KeyRound, ReceiptText, ShieldCheck, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requireTenant } from "@/lib/auth/guards";
import { ROLE_LABELS, ROLE_PERMISSIONS } from "@/lib/auth/permissions";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requireTenant();
  const p = ctx.active.permissions;
  const links = [
    { href: "/settings/organisation", label: "Organisation", text: "ISP name, county, contact phone.", icon: Building2, show: p.has("settings:manage") },
    { href: "/settings/staff", label: "Staff and roles", text: "Invite staff, change roles, disable access.", icon: Users, show: p.has("staff:manage") },
    { href: "/settings/billing", label: "FibrePulse billing", text: "Your agreement, monthly platform fees and invoices.", icon: ReceiptText, show: p.has("platform_billing:view") },
    { href: "/settings/support-access", label: "Support access", text: "Approve or revoke FibrePulse support requests.", icon: KeyRound, show: p.has("staff:manage") },
  ].filter((l) => l.show);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-3 md:max-w-2xl">
        {links.map((l) => (
          <Link key={l.href} href={l.href}>
            <Card className="flex items-center gap-4 p-4 transition-colors hover:border-primary/50">
              <l.icon className="size-5 text-primary" aria-hidden />
              <div className="flex-1">
                <p className="font-medium">{l.label}</p>
                <p className="text-sm text-muted-foreground">{l.text}</p>
              </div>
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
            </Card>
          </Link>
        ))}
        <Card className="p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-accent" aria-hidden />
            <p className="font-medium">Your access: {ROLE_LABELS[ctx.active.role]}</p>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {ROLE_PERMISSIONS[ctx.active.role].length} permissions. Every request is checked again by the database, so data outside your role and your ISP is never returned.
          </p>
        </Card>
      </div>
    </>
  );
}
