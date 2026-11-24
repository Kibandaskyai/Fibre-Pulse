import type { Metadata } from "next";
import Link from "next/link";
import { Download, FileCheck2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarList } from "@/components/charts/bar-list";
import { ChartTable } from "@/components/charts/chart-table";
import { TimeBarChart } from "@/components/charts/time-bar-chart";
import { CustomerStatusBadge } from "@/components/shared/billing-badges";
import { KpiCard } from "@/components/shared/kpi-card";
import { PageHeader } from "@/components/shared/page-header";
import { RangeFilter } from "@/components/shared/range-filter";
import { requirePagePermission } from "@/lib/auth/guards";
import { resolveRange } from "@/lib/date-range";
import { formatDate, formatKsh, PAYMENT_METHOD_LABELS, plural } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { change, loadRevenueReport } from "@/modules/analytics/report";
import { customerAreas } from "@/modules/analytics/service";
import { ServiceMoneyTable } from "@/components/hotspot/service-money";
import { revenueByService } from "@/modules/hotspot/service";

export const metadata: Metadata = { title: "Revenue" };

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-KE", { day: "numeric", month: "short", timeZone: "UTC" });
const monthLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-KE", { month: "short", year: "2-digit", timeZone: "UTC" });

export default async function RevenuePage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string; area?: string }> }) {
  const ctx = await requirePagePermission("revenue:view");
  const sp = await searchParams;
  const db = await createClient();
  const perms = ctx.active.permissions;
  const range = resolveRange(sp);
  const area = (sp.area ?? "").trim().slice(0, 80);
  const canSeeCustomers = perms.has("customers:view");
  const [report, areas] = await Promise.all([
    loadRevenueReport(db, { tenantId: ctx.active.tenantId, tenantName: ctx.active.tenantName, range, area, canSeeCustomers }),
    canSeeCustomers ? customerAreas(db, ctx.active.tenantId) : Promise.resolve(undefined),
  ]);
  const byService = report.ok && !area ? await revenueByService(db, ctx.active.tenantId, range.from, range.to, report.data.grain) : null;

  const qs = new URLSearchParams({ kind: "range", range: range.key, from: range.from, to: range.to, ...(area ? { area } : {}) }).toString();
  const header = (
    <PageHeader
      title="Revenue"
      description="Verified collections only: a payment counts once it is checked against your M-Pesa or bank statement. Simulated test data never counts."
      actions={
        <>
          {perms.has("payments:reconcile") ? (
            <Button asChild variant="outline" size="sm"><Link href="/payments/reconcile"><FileCheck2 aria-hidden /> Reconcile statement</Link></Button>
          ) : null}
          <Button asChild variant="outline" size="sm"><Link href={`/reports/export?${qs}&format=csv`} prefetch={false}><Download aria-hidden /> CSV</Link></Button>
          <Button asChild variant="outline" size="sm"><Link href={`/reports/export?${qs}&format=pdf`} prefetch={false}><FileText aria-hidden /> PDF</Link></Button>
        </>
      }
    />
  );

  if (!report.ok) {
    return (
      <>
        {header}
        <p className="text-sm text-danger">{report.message}</p>
      </>
    );
  }
  const r = report.data;
  const k = r.kpis;
  const delta = change(k.collected, r.previous?.collected);
  const digital = k.collected_mpesa + k.collected_bank + k.collected_other;
  const ageingTotal = r.ageing.reduce((s, a) => s + a.amount, 0);

  return (
    <>
      {header}
      <RangeFilter path="/revenue" range={range} area={area} areas={areas} />

      <section aria-label="Collections" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Collected (verified)"
          value={formatKsh(k.collected)}
          hint={`${plural(k.collected_count, "payment")}${delta === null ? "" : ` · ${delta > 0 ? "+" : ""}${delta}% vs previous ${r.range.from === r.range.to ? "day" : "period"}`}`}
        />
        <KpiCard label="Applied to invoices" value={formatKsh(k.recognised)} hint={`${formatKsh(k.unapplied_credit)} held as credit`} />
        <KpiCard label="Invoiced" value={formatKsh(k.invoiced)} hint={plural(k.paying_customers, "paying customer")} />
        <KpiCard
          label="Awaiting verification"
          value={formatKsh(k.awaiting_verification)}
          tone={k.awaiting_verification_count ? "warning" : undefined}
          hint={`${plural(k.awaiting_verification_count, "payment")}, not counted yet`}
          href={k.awaiting_verification_count ? "/payments?verification=unverified" : undefined}
        />
        <KpiCard
          label="Outstanding balances"
          value={formatKsh(k.outstanding)}
          hint={`${plural(k.outstanding_customers, "customer")} · ${formatKsh(k.overdue)} overdue`}
          tone={k.overdue ? "warning" : undefined}
          href="#outstanding"
        />
        <KpiCard label="Reversed and refunded" value={formatKsh(k.reversed + k.refunded)} hint={`${k.reversed_count} reversed · ${k.refunded_count} refunded`} />
        <KpiCard label="Packages sold" value={String(k.new_subscriptions + k.renewals + k.upgrades + k.downgrades)} hint={`${k.new_subscriptions} new · ${k.renewals} renewals · ${k.upgrades} upgrades · ${k.downgrades} downgrades`} />
        <KpiCard label="Simulated payments excluded" value={formatKsh(k.simulated_excluded)} hint={`${k.simulated_excluded_count} test payments, never revenue`} />
      </section>

      {byService?.ok ? (
        <div className="mb-6">
          <ServiceMoneyTable
            rows={byService.data}
            grain={r.grain}
            title={r.grain === "day" ? "Hotspot and monthly money by day" : "Hotspot and monthly money by month"}
            description={`${range.label}. Hotspot codes and monthly customers counted apart, verified money only.`}
          />
        </div>
      ) : null}

      <div className="mb-6 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{r.grain === "day" ? "Collections by day" : "Collections by month"}</CardTitle>
            <CardDescription>{range.label}{area ? ` · ${area}` : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <TimeBarChart
              valueLabel="Collected"
              data={r.series.map((p) => ({ label: r.grain === "day" ? dayLabel(p.bucket) : monthLabel(p.bucket), value: p.collected, detail: `${plural(p.payments, "payment")}` }))}
            />
            <ChartTable
              caption="Collections"
              headers={["Period", "Collected", "Payments", "Reversed"]}
              rows={r.series.map((p) => [r.grain === "day" ? p.bucket : p.bucket.slice(0, 7), formatKsh(p.collected), p.payments, formatKsh(p.reversed)])}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>How customers paid</CardTitle>
            <CardDescription>Digital {digital > 0 ? "100%" : "only"} · cash is not accepted</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <BarList rows={r.byMethod.map((b) => ({ label: PAYMENT_METHOD_LABELS[b.label] ?? b.label, value: b.amount, detail: `${plural(b.payments, "payment")}` }))} />
            <p className="border-t pt-3 text-xs text-muted-foreground">
              Cash: not used. FibrePulse records M-Pesa and bank payments only, so every shilling here can be traced to a statement.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By package</CardTitle>
            <CardDescription>Payments applied to package invoices, plus credit not yet applied and one-off charges</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList rows={r.byPackage.map((b) => ({ label: b.label, value: b.amount, detail: `${plural(b.payments, "payment")}` }))} total={k.collected} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By area</CardTitle>
            <CardDescription>The customer&apos;s estate, or town if no estate</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList rows={r.byArea.slice(0, 12).map((b) => ({ label: b.label, value: b.amount, detail: `${plural(b.payments, "payment")}` }))} total={k.collected} />
            {r.byArea.length > 12 ? (
              <ChartTable caption="All areas" headers={["Area", "Collected", "Payments"]} rows={r.byArea.map((b) => [b.label, formatKsh(b.amount), b.payments])} />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <section id="outstanding" className="mb-6 grid scroll-mt-20 gap-6 xl:grid-cols-3" aria-label="Outstanding balances">
        <Card>
          <CardHeader>
            <CardTitle>Outstanding by age</CardTitle>
            <CardDescription>Unpaid invoices today, by days past the due date{area ? ` · ${area}` : ""}</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList
              rows={r.ageing.map((a) => ({ label: a.bucket, value: a.amount, detail: `${plural(a.invoices, "invoice")} · ${plural(a.customers, "customer")}` }))}
              total={ageingTotal}
              emptyText="Nothing outstanding."
            />
          </CardContent>
        </Card>
        {r.balances ? (
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle>Customers with the largest balances</CardTitle>
              <CardDescription>Top 20{area ? ` in ${area}` : ""}. Open a customer to record a payment or send a reminder.</CardDescription>
            </CardHeader>
            <CardContent className="p-0 pb-2">
              {r.balances.length ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Customer</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                        <TableHead>Last verified payment</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {r.balances.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell>
                            <Link className="text-primary hover:underline" href={`/customers/${b.id}`}>{b.full_name}</Link>
                            <p className="text-xs text-muted-foreground">{[b.customer_number, b.estate ?? b.town].filter(Boolean).join(" · ")}</p>
                          </TableCell>
                          <TableCell><CustomerStatusBadge status={b.status} /></TableCell>
                          <TableCell className="tabular text-right">{formatKsh(b.outstanding)}</TableCell>
                          <TableCell className="tabular text-right">{b.credit ? formatKsh(b.credit) : "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{b.last_payment_at ? formatDate(b.last_payment_at) : "Never"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="px-6 pb-4 text-sm text-muted-foreground">No customer owes anything.</p>
              )}
            </CardContent>
          </Card>
        ) : null}
      </section>
    </>
  );
}
