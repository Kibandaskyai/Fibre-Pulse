import type { Metadata } from "next";
import Link from "next/link";
import { Package, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { PackageStatusBadge } from "@/components/shared/billing-badges";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatKsh, periodLabel } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { listPackages } from "@/modules/packages/service";

export const metadata: Metadata = { title: "PPPoE plans" };

export default async function PackagesPage({ searchParams }: { searchParams: Promise<{ archived?: string; created?: string; error?: string }> }) {
  const ctx = await requirePagePermission("packages:view");
  const sp = await searchParams;
  const canEdit = ctx.active.permissions.has("packages:edit");
  const showArchived = sp.archived === "1";
  const result = await listPackages(await createClient(), ctx.active.tenantId, { includeArchived: showArchived });

  return (
    <>
      <PageHeader
        title="PPPoE plans"
        description="Monthly plans for households on PPPoE with their own router. Changing a price applies to new purchases only; current subscriptions keep their price. Hotspot time plans are under Hotspot."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={showArchived ? "/packages" : "/packages?archived=1"}>{showArchived ? "Hide archived" : "Show archived"}</Link>
            </Button>
            {canEdit ? (
              <Button asChild size="sm">
                <Link href="/packages/new"><Plus aria-hidden /> New package</Link>
              </Button>
            ) : null}
          </>
        }
      />
      <Flash error={sp.error} success={sp.created ? "Package created." : null} />
      {!result.ok ? (
        <Flash error={result.message} />
      ) : result.data.length === 0 ? (
        <EmptyState
          icon={<Package />}
          title="No PPPoE plans yet"
          description="Add the monthly plans households pay for their own router: speed, price and billing period."
          action={canEdit ? <Button asChild><Link href="/packages/new">Create a package</Link></Button> : null}
        />
      ) : (
        <Card>
          <CardContent className="p-0 pb-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead>Speed</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="hidden sm:table-cell">Period</TableHead>
                  <TableHead className="hidden md:table-cell text-right">Live subscribers</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Link href={`/packages/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                      <p className="text-xs text-muted-foreground">{p.connection_type === "static" ? "Static IP" : "PPPoE"}{p.data_limit_gb ? ` · ${p.data_limit_gb} GB cap` : ""}</p>
                    </TableCell>
                    <TableCell className="tabular">{Number(p.download_mbps)}/{Number(p.upload_mbps)} Mbps</TableCell>
                    <TableCell className="tabular text-right">{formatKsh(p.price)}</TableCell>
                    <TableCell className="hidden sm:table-cell">{periodLabel(p.billing_period, p.duration_days)}</TableCell>
                    <TableCell className="hidden md:table-cell tabular text-right">{p.live_subscriptions}</TableCell>
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
