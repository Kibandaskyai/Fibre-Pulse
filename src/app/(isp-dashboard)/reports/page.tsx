import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarList } from "@/components/charts/bar-list";
import { PageHeader } from "@/components/shared/page-header";
import { requireTenant } from "@/lib/auth/guards";
import { dayRange, monthRange } from "@/lib/date-range";
import { formatDate, formatDateTime, formatKsh, kenyaToday, PAYMENT_METHOD_LABELS, plural } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { change, loadRevenueReport, type RevenueReport } from "@/modules/analytics/report";
import { BI_REPORTS, canOpen } from "@/modules/reports/bi";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ date?: string; month?: string }> }) {
  const ctx = await requireTenant();
  const sp = await searchParams;
  const perms = ctx.active.permissions;
  const financial = perms.has("reports:financial") && perms.has("revenue:view");
  const today = kenyaToday();

  const header = (
    <PageHeader
      title="Reports"
      description="Financial, customer, network and support reports, on screen and as CSV or PDF. All money is verified collections; simulated test data is never included."
    />
  );
  const bi = BI_REPORTS.filter((d) => canOpen(d, perms));
  const later = (
    <Card>
      <CardHeader>
        <CardTitle>Business intelligence reports</CardTitle>
        <CardDescription>Pick a report, then filter by dates{bi.some((d) => d.area) ? " and area" : ""}. Each one downloads as CSV or PDF.</CardDescription>
      </CardHeader>
      <CardContent>
        {bi.length ? (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="bi-reports">
            {bi.map((d) => (
              <li key={d.key}>
                <Link href={`/reports/bi/${d.key}`} className="block h-full rounded-md border bg-background/40 p-3 transition-colors hover:border-primary/60 hover:bg-muted/40">
                  <span className="flex items-center gap-2 text-sm font-medium"><BarChart3 className="size-4 text-primary" aria-hidden />{d.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{d.summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Your role has no reports. Ask the owner if you need one.</p>
        )}
      </CardContent>
    </Card>
  );
  if (!financial) {
    return (
      <>
        {header}
        <p className="mb-6 text-sm text-muted-foreground">Financial reports are available to the owner and the finance manager.</p>
        {later}
      </>
    );
  }

  const day = dayRange(sp.date);
  const month = monthRange(sp.month);
  const db = await createClient();
  const opts = { tenantId: ctx.active.tenantId, tenantName: ctx.active.tenantName, canSeeCustomers: perms.has("customers:view") };
  const [daily, monthly] = await Promise.all([
    loadRevenueReport(db, { ...opts, range: day, kind: "daily" }),
    loadRevenueReport(db, { ...opts, range: month, kind: "monthly" }),
  ]);

  return (
    <>
      {header}
      <div className="mb-6 grid gap-6 2xl:grid-cols-2">
        <Card>
          <CardHeader className="gap-3">
            <div>
              <CardTitle>Daily collections report</CardTitle>
              <CardDescription>{formatDate(day.from)} · every verified payment received that day</CardDescription>
            </div>
            <ReportControls
              name="date"
              type="date"
              value={day.from}
              max={today}
              hidden={sp.month ? { month: sp.month } : undefined}
              download={`/reports/export?kind=daily&date=${day.from}`}
            />
          </CardHeader>
          <CardContent>
            {daily.ok ? <DailyBody r={daily.data} /> : <p className="text-sm text-danger">{daily.message}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="gap-3">
            <div>
              <CardTitle>Monthly revenue report</CardTitle>
              <CardDescription>
                {new Date(`${month.from}T00:00:00Z`).toLocaleDateString("en-KE", { month: "long", year: "numeric", timeZone: "UTC" })}
                {month.from.slice(0, 7) === today.slice(0, 7) ? ` · so far, to ${formatDate(month.to)}` : ""}
              </CardDescription>
            </div>
            <ReportControls
              name="month"
              type="month"
              value={month.from.slice(0, 7)}
              max={today.slice(0, 7)}
              hidden={sp.date ? { date: sp.date } : undefined}
              download={`/reports/export?kind=monthly&month=${month.from.slice(0, 7)}`}
            />
          </CardHeader>
          <CardContent>
            {monthly.ok ? <MonthlyBody r={monthly.data} /> : <p className="text-sm text-danger">{monthly.message}</p>}
            <p className="mt-4 text-xs text-muted-foreground">
              <Link className="text-primary hover:underline" href={`/revenue?range=custom&from=${month.from}&to=${month.to}`}>Open this month in Revenue</Link> for charts, areas and filters.
            </p>
          </CardContent>
        </Card>
      </div>
      {later}
    </>
  );
}

function ReportControls({
  name,
  type,
  value,
  max,
  hidden,
  download,
}: {
  name: string;
  type: "date" | "month";
  value: string;
  max: string;
  hidden?: Record<string, string>;
  download: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <form className="flex items-end gap-2" action="/reports">
        {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
        <label className="grid gap-1 text-xs text-muted-foreground">
          {type === "date" ? "Day" : "Month"}
          <Input type={type} name={name} defaultValue={value} max={max} className="w-44" />
        </label>
        <Button type="submit" variant="secondary">Show</Button>
      </form>
      <Button asChild variant="outline"><Link href={`${download}&format=pdf`} prefetch={false}><FileText aria-hidden /> PDF</Link></Button>
      <Button asChild variant="outline"><Link href={`${download}&format=csv`} prefetch={false}><Download aria-hidden /> CSV</Link></Button>
    </div>
  );
}

function Figures({ items }: { items: [string, string, string?][] }) {
  return (
    <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map(([label, value, hint]) => (
        <div key={label} className="rounded-md border bg-background/40 p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="tabular text-lg font-semibold">{value}</dd>
          {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function DailyBody({ r }: { r: RevenueReport }) {
  const k = r.kpis;
  const delta = change(k.collected, r.previous?.collected);
  return (
    <>
      <Figures
        items={[
          ["Collected", formatKsh(k.collected), delta === null ? `${plural(k.collected_count, "payment")}` : `${plural(k.collected_count, "payment")} · ${delta > 0 ? "+" : ""}${delta}% vs day before`],
          ["M-Pesa", formatKsh(k.collected_mpesa)],
          ["Bank", formatKsh(k.collected_bank)],
          ["Awaiting verification", formatKsh(k.awaiting_verification), `${plural(k.awaiting_verification_count, "payment")}, not counted`],
        ]}
      />
      {r.payments?.length ? (
        <div className="max-h-96 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Time</TableHead><TableHead>Reference</TableHead><TableHead>Customer</TableHead><TableHead className="text-right">Amount</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {r.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(p.transaction_at).split(", ").pop()}</TableCell>
                  <TableCell>
                    <Link className="text-primary hover:underline" href={`/payments/${p.id}`}>{p.provider_reference}</Link>
                    <p className="text-xs text-muted-foreground">{PAYMENT_METHOD_LABELS[p.method] ?? p.method}</p>
                  </TableCell>
                  <TableCell>{p.full_name ?? "Not linked"}</TableCell>
                  <TableCell className="tabular text-right">{formatKsh(p.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No verified payments on this day.</p>
      )}
    </>
  );
}

function MonthlyBody({ r }: { r: RevenueReport }) {
  const k = r.kpis;
  const delta = change(k.collected, r.previous?.collected);
  return (
    <>
      <Figures
        items={[
          ["Collected", formatKsh(k.collected), delta === null ? `${plural(k.collected_count, "payment")}` : `${delta > 0 ? "+" : ""}${delta}% vs previous period`],
          ["Invoiced", formatKsh(k.invoiced)],
          ["Outstanding now", formatKsh(k.outstanding), `${formatKsh(k.overdue)} overdue`],
          ["Packages sold", String(k.new_subscriptions + k.renewals + k.upgrades + k.downgrades), `${k.new_subscriptions} new · ${k.renewals} renewals`],
        ]}
      />
      <h3 className="mb-2 text-sm font-medium">By package</h3>
      <BarList rows={r.byPackage.map((b) => ({ label: b.label, value: b.amount, detail: `${plural(b.payments, "payment")}` }))} total={k.collected} emptyText="No verified collections this month." />
    </>
  );
}
