import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, KeyRound } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartTable } from "@/components/charts/chart-table";
import { TrendLineChart } from "@/components/charts/trend-line-chart";
import { hourLabel } from "@/components/network/labels";
import { LoadValue, RouterStatusBadge, SeverityBadge, AlertStatusBadge } from "@/components/network/network-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatBps, formatDateTime, formatDuration, plural, timeAgo } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { getRouter, listConnectors, networkTraffic, routerHistory, runWatchdog } from "@/modules/network/service";
import { CredentialsForm, RouterForm } from "../../router-form";

export const metadata: Metadata = { title: "Router" };

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm">{children}</dd>
    </div>
  );
}

export default async function RouterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const ctx = await requirePagePermission("network:view");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await createClient();
  await runWatchdog(db, ctx.active.tenantId);
  const perms = ctx.active.permissions;
  const [detail, history, traffic, connectors] = await Promise.all([
    getRouter(db, ctx.active.tenantId, id),
    routerHistory(db, id, 24),
    networkTraffic(db, ctx.active.tenantId, 24, id),
    perms.has("network:edit") ? listConnectors(db, ctx.active.tenantId) : Promise.resolve([]),
  ]);
  if (!detail) notFound();
  const { router: r, interfaces, sessions, alerts } = detail;
  const simulated = r.data_source === "simulated";
  const ports = interfaces.filter((i) => !i.name.startsWith("<pppoe-"));

  return (
    <>
      <PageHeader
        title={r.name}
        description={[r.identity && r.identity !== r.name ? `RouterOS identity ${r.identity}` : null, r.model, r.location_name].filter(Boolean).join(" · ") || "MikroTik router"}
        actions={<Button asChild variant="outline" size="sm"><Link href="/network"><ArrowLeft aria-hidden /> Network</Link></Button>}
      />
      <Flash success={sp.created ? "Router added. Save its API credentials below, then assign it to a connector if you have not." : null} />
      {r.last_sync_error ? (
        <Alert variant="danger" className="mb-4"><AlertDescription className="text-foreground">Last read failed: {r.last_sync_error}</AlertDescription></Alert>
      ) : null}

      <Card className="mb-6">
        <CardHeader className="flex-row flex-wrap items-center gap-2">
          <CardTitle className="mr-auto">Status</CardTitle>
          <RouterStatusBadge status={r.status} />
          <DataSourceBadge source={r.data_source} />
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Fact label="CPU"><LoadValue value={r.cpu_load_pct} /></Fact>
            <Fact label="Memory used"><LoadValue value={r.memory_used_pct} /></Fact>
            <Fact label="Uptime">{formatDuration(r.uptime_seconds)}</Fact>
            <Fact label="Active sessions"><span className="tabular">{r.sessions}</span></Fact>
            <Fact label="Last read">{timeAgo(r.last_synced_at)}</Fact>
            <Fact label="RouterOS">{r.routeros_version ?? "—"}</Fact>
            <Fact label="Address">{r.management_address ? `${r.api_scheme}://${r.management_address}${r.api_port ? `:${r.api_port}` : ""}` : "—"}</Fact>
            <Fact label="Connector">{r.connector ? `${r.connector.name} · ${timeAgo(r.connector.last_seen_at)}` : "Not assigned"}</Fact>
          </dl>
          {!r.monitoring_enabled ? <p className="mt-4 text-sm text-warning">Monitoring is off for this router, so the connector does not read it.</p> : null}
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        {([["CPU load", "cpu", "pct"], ["Memory used", "memory", "pct"], ["Active sessions", "sessions", "count"]] as const).map(([title, key, unit]) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
              <CardDescription>Last 24 hours, 15-minute average{simulated ? " · simulated" : ""}</CardDescription>
            </CardHeader>
            <CardContent>
              {history.some((h) => h[key] !== null) ? (
                <>
                  <TrendLineChart height={160} unit={unit} domainMax={unit === "pct" ? 100 : undefined} valueLabel={title} data={history.filter((h) => h[key] !== null).map((h) => ({ label: hourLabel(h.bucket), value: Math.round(h[key] as number) }))} />
                  <ChartTable caption={title} headers={["Hour", title]} rows={history.map((h) => [formatDateTime(h.bucket), h[key] === null ? "—" : `${Math.round(h[key] as number)}${unit === "pct" ? "%" : ""}`])} />
                </>
              ) : <p className="py-8 text-center text-sm text-muted-foreground">No readings yet.</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {([["Download", "rx_bps"], ["Upload", "tx_bps"]] as const).map(([title, key]) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle>{title} traffic</CardTitle>
              <CardDescription>{key === "rx_bps" ? "Received on physical ports" : "Sent on physical ports"}, 15-minute average</CardDescription>
            </CardHeader>
            <CardContent>
              {traffic.length ? (
                <>
                  <TrendLineChart height={180} unit="bps" valueLabel={title} data={traffic.map((t) => ({ label: hourLabel(t.bucket), value: t[key] }))} />
                  <ChartTable caption={`${title} traffic`} headers={["Time", title]} rows={traffic.map((t) => [formatDateTime(t.bucket), formatBps(t[key])])} />
                </>
              ) : <p className="py-8 text-center text-sm text-muted-foreground">No traffic readings yet.</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Interfaces</CardTitle>
            <CardDescription>{plural(ports.length, "interface")}, current rates</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {ports.length ? (
              <Table>
                <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>State</TableHead><TableHead className="text-right">Down</TableHead><TableHead className="text-right">Up</TableHead></TableRow></TableHeader>
                <TableBody>
                  {ports.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.name}<p className="text-xs text-muted-foreground">{i.interface_type ?? ""}</p></TableCell>
                      <TableCell className="text-sm">{i.disabled ? "Disabled" : i.running ? "Running" : "Down"}</TableCell>
                      <TableCell className="tabular text-right">{formatBps(i.rx_bps)}</TableCell>
                      <TableCell className="tabular text-right">{formatBps(i.tx_bps)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <EmptyState className="m-5" title="No interfaces reported yet" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent alerts</CardTitle>
            <CardDescription><Link className="underline-offset-2 hover:underline" href="/alerts">All alerts</Link></CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {alerts.length ? (
              <Table>
                <TableBody>
                  {alerts.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell><SeverityBadge severity={a.severity} /></TableCell>
                      <TableCell className="text-sm">{a.title}<p className="text-xs text-muted-foreground">{formatDateTime(a.opened_at)}</p></TableCell>
                      <TableCell><AlertStatusBadge status={a.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : <EmptyState className="m-5" title="No alerts for this router" />}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Connected customers</CardTitle>
          <CardDescription>{plural(sessions.length, "active session")} (PPPoE and hotspot)</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {sessions.length ? (
            <div className="max-h-[28rem] overflow-auto">
              <Table>
                <TableHeader><TableRow><TableHead>User</TableHead><TableHead>Customer</TableHead><TableHead className="hidden sm:table-cell">IP address</TableHead><TableHead>Connected</TableHead></TableRow></TableHeader>
                <TableBody>
                  {sessions.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.username}<p className="font-sans text-muted-foreground">{s.session_type === "pppoe" ? "PPPoE" : "Hotspot"}</p></TableCell>
                      <TableCell className="text-sm">{s.customers ? (perms.has("customers:view") ? <Link className="hover:underline" href={`/customers/${s.customer_id}`}>{s.customers.full_name}</Link> : s.customers.full_name) : <span className="text-muted-foreground">Not linked</span>}</TableCell>
                      <TableCell className="hidden font-mono text-xs sm:table-cell">{s.ip_address ?? "—"}</TableCell>
                      <TableCell className="text-sm">{timeAgo(s.started_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : <EmptyState className="m-5" title="No one connected" description="Sessions appear once the connector reads this router." />}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        {perms.has("network:edit") ? (
          <Card>
            <CardHeader><CardTitle>Router settings</CardTitle></CardHeader>
            <CardContent><RouterForm router={r} connectors={connectors.filter((c) => c.status !== "revoked" || c.id === r.connector_agent_id)} /></CardContent>
          </Card>
        ) : null}
        {perms.has("network:credentials") ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" aria-hidden /> API credentials</CardTitle>
              <CardDescription>
                {r.has_credentials ? `Saved for user ${r.credential_user}. The password is encrypted and never shown.` : "None saved. The connector cannot read this router until you add them, or keep them only on the connector machine."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {simulated ? <p className="text-sm text-muted-foreground">This is a simulated router, so it needs no credentials.</p> : <CredentialsForm routerId={r.id} currentUser={r.credential_user} />}
              <p className="mt-4 text-xs text-muted-foreground">Give this user the <strong>read</strong> and <strong>api</strong> policies, plus <strong>write</strong> only if your owner turns on disconnecting suspended customers. See the MikroTik guide in the handover docs.</p>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
