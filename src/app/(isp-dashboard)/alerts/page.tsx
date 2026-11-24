import type { Metadata } from "next";
import Link from "next/link";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertStatusBadge, SeverityBadge } from "@/components/network/network-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { listAlerts, runWatchdog } from "@/modules/network/service";
import { AlertActions } from "./alert-actions";

export const metadata: Metadata = { title: "Alerts" };
const PAGE_SIZE = 25;

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ status?: string; severity?: string; page?: string }> }) {
  const ctx = await requirePagePermission("alerts:view");
  const sp = await searchParams;
  const f = {
    status: ["active", "open", "acknowledged", "resolved", "all"].includes(sp.status ?? "") ? sp.status! : "active",
    severity: ["info", "warning", "critical"].includes(sp.severity ?? "") ? sp.severity! : "",
    page: Math.max(1, Math.min(1000, Number.parseInt(sp.page ?? "1", 10) || 1)),
  };
  const db = await createClient();
  await runWatchdog(db, ctx.active.tenantId);
  const { rows, total } = await listAlerts(db, ctx.active.tenantId, f, PAGE_SIZE);
  const canManage = ctx.active.permissions.has("alerts:manage");

  return (
    <>
      <PageHeader title="Alerts" description="Raised automatically when a router stops answering, a connector stops reporting, a router is overloaded or a disconnect fails. Alerts clear themselves when the problem goes away." />
      <form className="mb-4 grid gap-2 sm:grid-cols-[12rem_12rem_auto] sm:justify-start" role="search">
        <NativeSelect name="status" defaultValue={f.status} aria-label="Status">
          <option value="active">Not resolved</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </NativeSelect>
        <NativeSelect name="severity" defaultValue={f.severity} aria-label="Severity">
          <option value="">Any severity</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </NativeSelect>
        <Button type="submit" variant="outline">Filter</Button>
      </form>
      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState className="m-5" icon={<BellRing />} title={f.status === "active" ? "No open alerts" : "No alerts match"} description="Alerts appear here when the connector reports a problem." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Alert</TableHead>
                  <TableHead className="hidden md:table-cell">Opened</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage ? <TableHead className="w-56"><span className="sr-only">Actions</span></TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id} data-testid="alert-row">
                    <TableCell className="align-top"><SeverityBadge severity={a.severity} /></TableCell>
                    <TableCell className="align-top">
                      <p className="text-sm font-medium">{a.title}</p>
                      {a.message ? <p className="text-xs text-muted-foreground">{a.message}</p> : null}
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        {a.router_id && a.routers ? <Link className="hover:underline" href={`/network/routers/${a.router_id}`}>{a.routers.name}</Link> : null}
                        <span className="md:hidden">· {formatDateTime(a.opened_at)}</span>
                        {a.data_source === "simulated" ? <DataSourceBadge source="simulated" /> : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden align-top text-sm md:table-cell">
                      {formatDateTime(a.opened_at)}
                      {a.resolved_at ? <p className="text-xs text-muted-foreground">Resolved {formatDateTime(a.resolved_at)}</p> : null}
                    </TableCell>
                    <TableCell className="align-top"><AlertStatusBadge status={a.status} /></TableCell>
                    {canManage ? <TableCell className="align-top"><AlertActions alertId={a.id} status={a.status} /></TableCell> : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pagination path="/alerts" params={{ status: f.status, severity: f.severity }} page={f.page} pageSize={PAGE_SIZE} total={total} />
        </CardContent>
      </Card>
    </>
  );
}
