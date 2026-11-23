import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarList } from "@/components/charts/bar-list";
import { ChartTable } from "@/components/charts/chart-table";
import { TimeBarChart } from "@/components/charts/time-bar-chart";
import { TrendLineChart } from "@/components/charts/trend-line-chart";
import { CustomerStatusBadge, VerificationBadge } from "@/components/shared/billing-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { KpiCard } from "@/components/shared/kpi-card";
import { PageHeader } from "@/components/shared/page-header";
import { RangeFilter } from "@/components/shared/range-filter";
import { TenantStatusBadge } from "@/components/shared/status-badge";
import { requireTenant } from "@/lib/auth/guards";
import { grainFor, last12Months, resolveRange } from "@/lib/date-range";
import { formatDate, formatDateTime, formatKsh, kenyaToday, PAYMENT_METHOD_LABELS, plural } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import {
  criticalAlerts,
  customerAreas,
  customerCounts,
  customerGrowth,
  networkCounts,
  recentCustomers,
  recentPayments,
  revenueBreakdown,
  revenueKpis,
  revenueSeries,
  subscriptionDistribution,
} from "@/modules/analytics/service";
import { expireDueSubscriptions } from "@/modules/billing/service";

export const metadata: Metadata = { title: "Overview" };

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-KE", { day: "numeric", month: "short", timeZone: "UTC" });
const monthLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-KE", { month: "short", year: "2-digit", timeZone: "UTC" });

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string; area?: string }> }) {
  const ctx = await requireTenant();
  const sp = await searchParams;
  const db = await createClient();
  const perms = ctx.active.permissions;
  const tenantId = ctx.active.tenantId;
  const range = resolveRange(sp);
  const area = (sp.area ?? "").slice(0, 80);
  const today = kenyaToday();
  const can = {
    revenue: perms.has("revenue:view"),
    customers: perms.has("customers:view"),
    subscriptions: perms.has("subscriptions:view"),
    payments: perms.has("payments:view"),
    network: perms.has("network:view"),
    alerts: perms.has("alerts:view"),
  };
  if (ctx.active.tenantStatus === "active" && can.subscriptions) await expireDueSubscriptions(db, tenantId);
  const months = last12Months();
  const grain = grainFor(range);
  const none = Promise.resolve(null);

  const [kpis, series, monthly, byMethod, byArea, counts, growth, mix, net, payments, newest, alerts, areas, subs] = await Promise.all([
    can.revenue ? revenueKpis(db, tenantId, range.from, range.to, area) : none,
    can.revenue ? revenueSeries(db, tenantId, range.from, range.to, grain, area) : none,
    can.revenue ? revenueSeries(db, tenantId, months.from, months.to, "month", area) : none,
    can.revenue ? revenueBreakdown(db, tenantId, range.from, range.to, "method", area) : none,
    can.revenue ? revenueBreakdown(db, tenantId, range.from, range.to, "area", area) : none,
    can.customers ? customerCounts(db, tenantId, today) : none,
    can.customers ? customerGrowth(db, tenantId, 12, area) : none,
    can.subscriptions ? subscriptionDistribution(db, tenantId, area) : none,
    can.network || can.alerts ? networkCounts(db, tenantId) : none,
    can.payments ? recentPayments(db, tenantId) : none,
    can.customers ? recentCustomers(db, tenantId) : none,
    can.alerts ? criticalAlerts(db, tenantId) : none,
    can.customers ? customerAreas(db, tenantId) : none,
    can.subscriptions
      ? db.from("subscriptions").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "active").then((r) => r.count ?? 0)
      : none,
  ]);

  const k = kpis?.ok ? kpis.data : null;
  const setup = [
    { done: ctx.active.tenantStatus === "active", label: "FibrePulse activates your workspace", href: null, show: true },
    { done: (mix?.ok ? mix.data.length : 0) > 0 || (counts?.total ?? 0) > 0, label: "Create packages and add customers", href: "/customers/import", show: perms.has("customers:edit") },
    { done: (net?.routers ?? 0) - (net?.routersSimulated ?? 0) > 0, label: "Install the FibrePulse Connector for MikroTik (Phase 4)", href: null, show: can.network },
  ].filter((s) => s.show);
  const setupDone = setup.every((s) => s.done);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Money figures count verified payments only. Simulated test data is labelled and never included."
        actions={<TenantStatusBadge status={ctx.active.tenantStatus} />}
      />
      {can.revenue || can.customers ? (
        <RangeFilter path="/overview" range={range} area={area} areas={areas ?? undefined} />
      ) : null}

      {can.customers && counts ? (
        <Section title="Customers">
          <KpiCard label="Registered customers" value={counts.total.toLocaleString("en-KE")} href="/customers" />
          <KpiCard label="Active" value={counts.active.toLocaleString("en-KE")} href="/customers?status=active" />
          <KpiCard label="Suspended" value={counts.suspended.toLocaleString("en-KE")} tone={counts.suspended ? "danger" : undefined} href="/customers?status=suspended" />
          <KpiCard label="New today" value={counts.newToday.toLocaleString("en-KE")} hint={`${counts.pending} awaiting installation`} />
        </Section>
      ) : null}

      {can.revenue && k ? (
        <Section title="Collections (verified)">
          <KpiCard label="Today" value={formatKsh(k.collected_today)} />
          <KpiCard label="This week" value={formatKsh(k.collected_this_week)} hint="Since Monday" />
          <KpiCard label="This month" value={formatKsh(k.collected_this_month)} />
          <KpiCard
            label="Outstanding balances"
            value={formatKsh(k.outstanding)}
            tone={k.overdue > 0 ? "warning" : undefined}
            hint={`${plural(k.outstanding_customers, "customer")} · ${formatKsh(k.overdue)} overdue`}
            href="/revenue#outstanding"
          />
        </Section>
      ) : null}

      {can.subscriptions || can.network || can.alerts ? (
        <Section title="Service and network" wide>
          {can.subscriptions ? <KpiCard label="Active subscriptions" value={(subs ?? 0).toLocaleString("en-KE")} href="/subscriptions" /> : null}
          {can.network && net ? (
            <KpiCard
              label="Routers"
              value={net.routers.toLocaleString("en-KE")}
              hint={net.routersSimulated ? `${net.routersSimulated} simulated test devices` : "Registered"}
              badge={net.routersSimulated ? <DataSourceBadge source="simulated" /> : undefined}
              href="/network"
            />
          ) : null}
          {can.network ? (
            <KpiCard label="Online / offline customers" value="—" hint="Live once the MikroTik connector is installed (Phase 4)" />
          ) : null}
          {can.network ? <KpiCard label="Network uptime" value="—" hint="Measured by the connector (Phase 4)" /> : null}
          {can.alerts && net ? (
            <KpiCard
              label="Open incidents"
              value={net.openIncidents.toLocaleString("en-KE")}
              tone={net.critical ? "danger" : undefined}
              hint={net.openIncidentsSimulated ? `${net.openIncidentsSimulated} simulated` : `${net.critical} critical`}
              href="/alerts"
            />
          ) : null}
        </Section>
      ) : null}

      {can.revenue && k ? (
        <>
          {k.awaiting_verification_count || k.simulated_excluded_count ? (
            <p className="mb-4 text-xs text-muted-foreground">
              {k.awaiting_verification_count ? (
                <Link className="text-warning hover:underline" href="/payments?verification=unverified">
                  {k.awaiting_verification_count} payments ({formatKsh(k.awaiting_verification)}) are awaiting verification and not counted yet.
                </Link>
              ) : null}{" "}
              {k.simulated_excluded_count ? `${k.simulated_excluded_count} simulated payments (${formatKsh(k.simulated_excluded)}) are excluded.` : null}
            </p>
          ) : null}
          <div className="mb-6 grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{grain === "day" ? "Daily collections" : "Collections by month"}</CardTitle>
                <CardDescription>
                  {range.label} · {formatKsh(k.collected)} from {k.collected_count} verified payments
                </CardDescription>
              </CardHeader>
              <CardContent>
                {series?.ok ? (
                  <>
                    <TimeBarChart
                      valueLabel="Collected"
                      data={series.data.map((p) => ({ label: grain === "day" ? dayLabel(p.bucket) : monthLabel(p.bucket), value: p.collected, detail: `${plural(p.payments, "payment")}` }))}
                    />
                    <ChartTable caption="Collections" headers={["Period", "Collected", "Payments"]} rows={series.data.map((p) => [p.bucket, formatKsh(p.collected), p.payments])} />
                  </>
                ) : <p className="text-sm text-danger">{series?.message}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Monthly revenue trend</CardTitle>
                <CardDescription>Verified collections, last 12 months</CardDescription>
              </CardHeader>
              <CardContent>
                {monthly?.ok ? (
                  <>
                    <TimeBarChart valueLabel="Collected" data={monthly.data.map((p) => ({ label: monthLabel(p.bucket), value: p.collected, detail: `${plural(p.payments, "payment")}` }))} />
                    <ChartTable caption="Monthly collections" headers={["Month", "Collected", "Reversed"]} rows={monthly.data.map((p) => [p.bucket.slice(0, 7), formatKsh(p.collected), formatKsh(p.reversed)])} />
                  </>
                ) : <p className="text-sm text-danger">{monthly?.message}</p>}
              </CardContent>
            </Card>
          </div>
          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Payment methods</CardTitle><CardDescription>{range.label}</CardDescription></CardHeader>
              <CardContent>
                <BarList rows={byMethod?.ok ? byMethod.data.map((r) => ({ label: r.label, value: r.amount, detail: `${plural(r.payments, "payment")}` })) : []} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Revenue by area</CardTitle><CardDescription>By the customer&apos;s estate, or town if no estate · {range.label}</CardDescription></CardHeader>
              <CardContent>
                <BarList rows={byArea?.ok ? byArea.data.slice(0, 8).map((r) => ({ label: r.label, value: r.amount })) : []} total={k.collected} />
                {byArea?.ok && byArea.data.length > 8 ? <p className="mt-3 text-xs text-muted-foreground">Top 8 areas shown. <Link className="text-primary hover:underline" href="/revenue">See all</Link></p> : null}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}

      {can.customers || can.subscriptions || can.network ? (
        <div className="mb-6 grid gap-6 lg:grid-cols-3">
          {can.customers && growth?.ok ? (
            <Card>
              <CardHeader><CardTitle>Customer growth</CardTitle><CardDescription>Registered customers, last 12 months</CardDescription></CardHeader>
              <CardContent>
                <TrendLineChart valueLabel="Customers" data={growth.data.map((g) => ({ label: monthLabel(g.month), value: g.total_customers, detail: `${g.new_customers} new` }))} />
                <ChartTable caption="Customer growth" headers={["Month", "New", "Total"]} rows={growth.data.map((g) => [g.month.slice(0, 7), g.new_customers, g.total_customers])} />
              </CardContent>
            </Card>
          ) : null}
          {can.subscriptions && mix?.ok ? (
            <Card>
              <CardHeader><CardTitle>Subscriptions by package</CardTitle><CardDescription>Live subscriptions now</CardDescription></CardHeader>
              <CardContent>
                <BarList
                  format="count"
                  emptyText="No live subscriptions."
                  rows={mix.data.map((m) => ({ label: m.package, value: m.active, detail: `${formatKsh(m.monthly_value)} a month${m.suspended ? ` · ${m.suspended} suspended` : ""}` }))}
                />
              </CardContent>
            </Card>
          ) : null}
          {can.network ? (
            <Card>
              <CardHeader><CardTitle>Network availability</CardTitle><CardDescription>Router uptime and reachability</CardDescription></CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Availability is measured from real router data once the FibrePulse Connector is installed (Phase 4). No figure is shown until then.
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      <div className="mb-6 grid gap-6 xl:grid-cols-3">
        {can.payments && payments ? (
          <Card className="xl:col-span-2">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Recent transactions</CardTitle>
              <Link className="text-sm text-primary hover:underline" href="/payments">All payments</Link>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              {payments.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Reference</TableHead><TableHead>Customer</TableHead><TableHead className="hidden md:table-cell">When</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Link className="tabular hover:underline" href={`/payments/${p.id}`}>{p.provider_reference ?? "—"}</Link>
                          <p className="flex items-center gap-1 text-xs text-muted-foreground">{PAYMENT_METHOD_LABELS[p.method]} {p.data_source === "simulated" ? <DataSourceBadge source="simulated" /> : null}</p>
                        </TableCell>
                        <TableCell>{p.customers?.full_name ?? <span className="text-warning">Not linked</span>}</TableCell>
                        <TableCell className="hidden text-xs md:table-cell">{formatDateTime(p.transaction_at)}</TableCell>
                        <TableCell className="tabular text-right">{formatKsh(p.amount)}</TableCell>
                        <TableCell><VerificationBadge status={p.status === "successful" ? p.verification_status : p.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="px-5 pb-3 text-sm text-muted-foreground">No payments yet.</p>}
            </CardContent>
          </Card>
        ) : null}
        {can.customers && newest ? (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>New customers</CardTitle>
              <Link className="text-sm text-primary hover:underline" href="/customers">All</Link>
            </CardHeader>
            <CardContent className="grid gap-3">
              {newest.length ? newest.map((c) => (
                <Link key={c.id} href={`/customers/${c.id}`} className="flex items-center justify-between gap-2 text-sm hover:underline">
                  <span className="min-w-0">
                    <span className="block truncate">{c.full_name}</span>
                    <span className="block text-xs text-muted-foreground">{[c.estate, c.town].filter(Boolean).join(", ") || c.customer_number} · {formatDate(c.registered_on)}</span>
                  </span>
                  <CustomerStatusBadge status={c.status} />
                </Link>
              )) : <p className="text-sm text-muted-foreground">No customers yet.</p>}
            </CardContent>
          </Card>
        ) : null}
        {can.alerts && alerts ? (
          <Card className={can.payments ? "xl:col-span-3" : undefined}>
            <CardHeader><CardTitle>Network alerts</CardTitle><CardDescription>Open alerts, newest first</CardDescription></CardHeader>
            <CardContent className="grid gap-2">
              {alerts.length ? alerts.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className={a.severity === "critical" ? "font-medium text-danger" : a.severity === "warning" ? "text-warning" : ""}>
                    {a.severity === "critical" ? "Critical" : a.severity === "warning" ? "Warning" : "Info"}
                  </span>
                  <span>{a.title}</span>
                  {a.data_source === "simulated" ? <DataSourceBadge source="simulated" /> : null}
                  <span className="text-xs text-muted-foreground">{formatDateTime(a.created_at)}</span>
                </div>
              )) : <p className="text-sm text-muted-foreground">No open alerts.</p>}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {!setupDone ? (
        <Card>
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
                    <Button asChild size="sm" variant="link" className="h-auto p-0"><Link href={s.href}>Open</Link></Button>
                  ) : null}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function Section({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className="mb-6" aria-label={title}>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className={`grid gap-4 sm:grid-cols-2 ${wide ? "lg:grid-cols-3 xl:grid-cols-5" : "xl:grid-cols-4"}`}>{children}</div>
    </section>
  );
}
