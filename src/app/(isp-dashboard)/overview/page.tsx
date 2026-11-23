import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Circle, Package, Router, UserPlus, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { TenantStatusBadge } from "@/components/shared/status-badge";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { requireTenant } from "@/lib/auth/guards";
import type { Permission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Overview" };

type Counter = { label: string; table: string; permission: Permission; icon: React.ReactNode; href: string; filter?: [string, string] };

const COUNTERS: Counter[] = [
  { label: "Registered customers", table: "customers", permission: "customers:view", icon: <Users />, href: "/customers" },
  { label: "Active packages", table: "service_packages", permission: "packages:view", icon: <Package />, href: "/packages", filter: ["status", "active"] },
  { label: "Registered routers", table: "routers", permission: "network:view", icon: <Router />, href: "/network" },
  { label: "Staff members", table: "tenant_members", permission: "staff:manage", icon: <UserPlus />, href: "/settings/staff", filter: ["status", "active"] },
];

export default async function OverviewPage() {
  const ctx = await requireTenant();
  const db = await createClient();
  const perms = ctx.active.permissions;
  const visible = COUNTERS.filter((c) => perms.has(c.permission));

  // Real counts straight from the database (RLS-filtered). No sample figures.
  const counts = await Promise.all(
    visible.map(async (c) => {
      let q = db.from(c.table).select("*", { count: "exact", head: true }).eq("tenant_id", ctx.active.tenantId);
      if (c.filter) q = q.eq(c.filter[0], c.filter[1]);
      const { count, error } = await q;
      if (error) return { total: null, simulated: 0 };
      // Routers can be simulated test devices: count and label them.
      let simulated = 0;
      if (c.table === "routers") {
        const r = await db.from("routers").select("*", { count: "exact", head: true }).eq("tenant_id", ctx.active.tenantId).eq("data_source", "simulated");
        simulated = r.count ?? 0;
      }
      return { total: count ?? 0, simulated };
    }),
  );

  const setup = [
    { done: ctx.active.tenantStatus === "active", label: "FibrePulse activates your workspace", href: null },
    { done: (counts[visible.findIndex((c) => c.table === "tenant_members")]?.total ?? 0) > 1, label: "Invite your staff", href: "/settings/staff", show: perms.has("staff:manage") },
    { done: (counts[visible.findIndex((c) => c.table === "service_packages")]?.total ?? 0) > 0, label: "Create your internet packages", href: "/packages", show: perms.has("packages:edit") },
    { done: (counts[visible.findIndex((c) => c.table === "customers")]?.total ?? 0) > 0, label: "Import or add customers", href: "/customers/import", show: perms.has("customers:edit") },
    { done: false, label: "Install the FibrePulse Connector for MikroTik (Phase 4)", href: null },
  ].filter((s) => s.show !== false);

  return (
    <>
      <PageHeader
        title="Overview"
        description="The full executive dashboard with revenue and network charts arrives in Phase 3, built on verified records only."
        actions={<TenantStatusBadge status={ctx.active.tenantStatus} />}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {visible.map((c, i) => (
          <Link key={c.table} href={c.href} className="group">
            <Card className="h-full transition-colors group-hover:border-primary/50">
              <CardHeader className="flex-row items-center justify-between pb-2">
                <CardDescription>{c.label}</CardDescription>
                <span className="text-muted-foreground [&_svg]:size-4">{c.icon}</span>
              </CardHeader>
              <CardContent>
                <p className="tabular text-3xl font-semibold">{counts[i]!.total === null ? "–" : counts[i]!.total!.toLocaleString("en-KE")}</p>
                {counts[i]!.simulated > 0 ? (
                  <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <DataSourceBadge source="simulated" /> {counts[i]!.simulated} of {counts[i]!.total} are test devices
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Getting started</CardTitle>
          <CardDescription>Steps to bring {ctx.active.tenantName} onto FibrePulse.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-2">
            {setup.map((s) => (
              <li key={s.label} className="flex items-center gap-3 text-sm">
                {s.done ? <CheckCircle2 className="size-4 text-success" aria-label="Done" /> : <Circle className="size-4 text-muted-foreground" aria-label="Not done" />}
                <span className={s.done ? "text-muted-foreground line-through" : ""}>{s.label}</span>
                {s.href && !s.done ? (
                  <Button asChild size="sm" variant="link" className="h-auto p-0">
                    <Link href={s.href}>Open</Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </>
  );
}
