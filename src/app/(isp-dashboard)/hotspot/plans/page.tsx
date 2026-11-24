import type { Metadata } from "next";
import Link from "next/link";
import { Plus, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PackageStatusBadge } from "@/components/shared/billing-badges";
import { EmptyState } from "@/components/shared/empty-state";
import { Flash } from "@/components/shared/flash";
import { KpiCard } from "@/components/shared/kpi-card";
import { PageHeader } from "@/components/shared/page-header";
import { UsageTypeBadge } from "@/components/hotspot/badges";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatData, formatKsh, formatPlanDuration } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { hotspotSummary, listPlans } from "@/modules/hotspot/service";

export const metadata: Metadata = { title: "Hotspot plans" };

export default async function HotspotPlansPage({ searchParams }: { searchParams: Promise<{ created?: string; saved?: string; error?: string; archived?: string }> }) {
  const ctx = await requirePagePermission("packages:view");
  const sp = await searchParams;
  const db = await createClient();
  const canEdit = ctx.active.permissions.has("packages:edit");
  const showArchived = sp.archived === "1";
  const [plans, summary] = await Promise.all([
    listPlans(db, ctx.active.tenantId, { includeArchived: showArchived }),
    ctx.active.permissions.has("subscriptions:view") ? hotspotSummary(db, ctx.active.tenantId) : Promise.resolve(null),
  ]);
  const rows = plans.ok ? plans.data : [];
  const running = summary?.active_by_plan ?? {};
  const totalRunning = Object.values(running).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title="Hotspot plans"
        description="Time people buy for one device. A price change applies to new purchases only."
        actions={
          <>
            <Button asChild variant="outline" size="sm"><Link href={showArchived ? "/hotspot/plans" : "/hotspot/plans?archived=1"}>{showArchived ? "Hide archived" : "Show archived"}</Link></Button>
            {canEdit ? <Button asChild size="sm"><Link href="/hotspot/plans/new"><Plus aria-hidden /> New hotspot plan</Link></Button> : null}
          </>
        }
      />
      <Flash error={sp.error} success={sp.created ? "Plan created." : sp.saved ? `Plan ${sp.saved === "active" ? "back on sale" : sp.saved === "inactive" ? "taken off sale" : "archived"}.` : null} />
      <section aria-label="Plan totals" className="mb-6 grid gap-4 sm:grid-cols-3">
        <KpiCard label="Total plans" value={String(rows.filter((p) => p.status !== "archived").length)} />
        <KpiCard label="Active customers" value={totalRunning.toLocaleString("en-KE")} hint="Codes running now" />
        <KpiCard label="Unlimited plans" value={String(rows.filter((p) => p.status !== "archived" && p.usage_type === "unlimited").length)} />
      </section>
      {!plans.ok ? (
        <Flash error={plans.message} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Wifi />} title="No hotspot plans yet" description="Create the time plans people buy, e.g. 1 hour for Ksh 10." action={canEdit ? <Button asChild><Link href="/hotspot/plans/new">Create a plan</Link></Button> : null} />
      ) : (
        <Card>
          <CardContent className="p-0 pb-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="hidden sm:table-cell">Speed</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="hidden md:table-cell text-right">Running now</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      {canEdit ? <Link href={`/hotspot/plans/${p.id}`} className="font-medium hover:underline">{p.name}</Link> : <span className="font-medium">{p.name}</span>}
                      <p className="text-xs text-muted-foreground">
                        {formatPlanDuration(p.duration_minutes)}
                        {p.usage_type === "limited" ? (p.data_limit_mb ? ` · ${formatData(p.data_limit_mb)}` : null) : " · no data limit"}
                      </p>
                      {p.usage_type === "limited" && !p.data_limit_mb ? (
                        <p className="text-xs text-warning" data-testid="cap-missing">Data amount not set yet: works like Unlimited until you add it.</p>
                      ) : null}
                    </TableCell>
                    <TableCell><UsageTypeBadge type={p.usage_type} /></TableCell>
                    <TableCell className="hidden sm:table-cell tabular">{Number(p.download_mbps)} Mbps</TableCell>
                    <TableCell className="tabular text-right">{formatKsh(p.price)}</TableCell>
                    <TableCell className="hidden md:table-cell tabular text-right">{(running[p.id] ?? 0).toLocaleString("en-KE")}</TableCell>
                    <TableCell><PackageStatusBadge status={p.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
