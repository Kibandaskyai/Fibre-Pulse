import type { Metadata } from "next";
import Link from "next/link";
import { Plus, PlugZap, Router as RouterIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartTable } from "@/components/charts/chart-table";
import { TrendLineChart } from "@/components/charts/trend-line-chart";
import { hourLabel } from "@/components/network/labels";
import { LoadValue, RouterStatusBadge, SeverityBadge } from "@/components/network/network-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiCard } from "@/components/shared/kpi-card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatBps, formatDateTime, formatDuration, plural, timeAgo } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { listAlerts, listRouters, networkSummary, networkTraffic, runWatchdog } from "@/modules/network/service";

export const metadata: Metadata = { title: "Network" };
export const dynamic = "force-dynamic";

export default async function NetworkPage() {
  const ctx = await requirePagePermission("network:view");
  const tenantId = ctx.active.tenantId;
  const db = await createClient();
  await runWatchdog(db, tenantId);
  const perms = ctx.active.permissions;
  const [summary, routers, traffic, alerts] = await Promise.all([
    networkSummary(db, tenantId),
    listRouters(db, tenantId),
    networkTraffic(db, tenantId, 24),
    perms.has("alerts:view") ? listAlerts(db, tenantId, { status: "active", severity: "", page: 1 }, 6) : Promise.resolve({ rows: [], total: 0 }),
  ]);
  const anySimulated = summary.simulatedRouters > 0;

  const actions = (
    <>
      <Button asChild variant="outline" size="sm"><Link href="/network/connectors"><PlugZap aria-hidden /> Connectors</Link></Button>
      {perms.has("network:edit") ? <Button asChild size="sm"><Link href="/network/routers/new"><Plus aria-hidden /> Add router</Link></Button> : null}
    </>
  );

  if (routers.length === 0) {
    return (
      <>
        <PageHeader title="Network monitoring" description="Routers, customer sessions and bandwidth, read from your MikroTik routers by the FibrePulse Connector." actions={actions} />
        <EmptyState
          icon={<RouterIcon />}
          title="No routers yet"
          description="1. Register a connector and install it on a computer inside your network. 2. Add each MikroTik router with its API user. Readings appear within a minute."
          action={perms.has("network:edit") ? <Button asChild><Link href="/network/connectors">Register a connector</Link></Button> : undefined}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Network monitoring"
        description={`Live from your routers through the FibrePulse Connector. ${summary.connectorsReporting} of ${plural(summary.connectors, "connector")} reporting.`}
        actions={actions}
      />

      <section aria-label="Network health" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Routers online"
          value={`${summary.online} of ${summary.routers}`}
          tone={summary.offline ? "danger" : summary.unknown ? "warning" : "success"}
          hint={`${summary.offline} offline · ${summary.unknown} not reporting`}
          badge={anySimulated ? <DataSourceBadge source="simulated" /> : undefined}
        />
        <KpiCard label="Active sessions" value={(summary.pppoe + summary.hotspot).toLocaleString("en-KE")} hint={`${summary.pppoe} PPPoE · ${summary.hotspot} hotspot`} />
        <KpiCard
          label="Paying customers online"
          value={`${summary.customersOnline} of ${summary.activeCustomers}`}
          hint={`${summary.customersOffline} with an active package have no session`}
          tone={summary.customersOffline ? "warning" : undefined}
        />
        <KpiCard
          label="Open alerts"
          value={String(summary.openAlerts)}
          tone={summary.critical ? "danger" : summary.warning ? "warning" : undefined}
          hint={`${summary.critical} critical · ${summary.warning} warning`}
          href={perms.has("alerts:view") ? "/alerts" : undefined}
        />
      </section>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Routers</CardTitle>
          <CardDescription>CPU or memory turns orange from 75% and red from 90%.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Router</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">CPU</TableHead>
                <TableHead className="text-right">Memory</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="hidden md:table-cell">Uptime</TableHead>
                <TableHead className="hidden md:table-cell">Last read</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routers.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/network/routers/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {r.location_name ?? r.model ?? ""}
                      {r.data_source === "simulated" ? <DataSourceBadge source="simulated" /> : null}
                    </div>
                  </TableCell>
                  <TableCell><RouterStatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-right"><LoadValue value={r.cpu_load_pct} /></TableCell>
                  <TableCell className="text-right"><LoadValue value={r.memory_used_pct} /></TableCell>
                  <TableCell className="tabular text-right">{r.sessions}</TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{formatDuration(r.uptime_seconds)}</TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{timeAgo(r.last_synced_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {([["Download", "rx_bps"], ["Upload", "tx_bps"]] as const).map(([title, key]) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle>{title} traffic, all routers</CardTitle>
              <CardDescription>Last 24 hours on physical ports, 15-minute average{anySimulated ? " · includes simulated routers" : ""}</CardDescription>
            </CardHeader>
            <CardContent>
              {traffic.length ? (
                <>
                  <TrendLineChart height={200} unit="bps" valueLabel={title} data={traffic.map((t) => ({ label: hourLabel(t.bucket), value: t[key] }))} />
                  <ChartTable caption={`${title} traffic`} headers={["Time", title]} rows={traffic.map((t) => [formatDateTime(t.bucket), formatBps(t[key])])} />
                </>
              ) : <p className="py-8 text-center text-sm text-muted-foreground">No traffic readings yet.</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {perms.has("alerts:view") ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Active alerts</CardTitle>
              <CardDescription><Link href="/alerts" className="hover:underline">{plural(alerts.total, "alert")} not yet resolved</Link></CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {alerts.rows.length ? (
                <Table>
                  <TableBody>
                    {alerts.rows.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell><SeverityBadge severity={a.severity} /></TableCell>
                        <TableCell className="text-sm">{a.title}<p className="text-xs text-muted-foreground">{a.routers?.name ? `${a.routers.name} · ` : ""}{timeAgo(a.opened_at)}</p></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <EmptyState className="m-5" title="All clear" description="No open network alerts." />}
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Wi-Fi and fibre signal</CardTitle>
            <CardDescription>Not measured yet</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Customer Wi-Fi quality and optical (ONU/ONT) power need readings from the customer&apos;s router or your OLT, which the MikroTik connector cannot see. FibrePulse shows nothing here rather than guessing. An OLT or CPE connector is planned once your OLT brand is confirmed.
          </CardContent>
        </Card>
      </div>
    </>
  );
}
