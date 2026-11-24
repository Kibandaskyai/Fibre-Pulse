import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartTable } from "@/components/charts/chart-table";
import { TimeBarChart } from "@/components/charts/time-bar-chart";
import { AgreementBadge } from "@/components/platform/platform-badges";
import { KpiCard } from "@/components/shared/kpi-card";
import { PageHeader } from "@/components/shared/page-header";
import { TenantStatusBadge } from "@/components/shared/status-badge";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { formatDate, formatKsh } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { ispRevenue, platformMonthly, platformSummary, ratePct } from "@/modules/platform/billing";
import { listTenants } from "@/modules/platform/service";

export const metadata: Metadata = { title: "Platform overview" };

const monthLabel = (iso: string, style: "short" | "long" = "short") =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-KE", { month: style, year: style === "long" ? "numeric" : "2-digit", timeZone: "UTC" });

export default async function PlatformOverviewPage() {
  const ctx = await requirePlatformStaff();
  const db = await createClient();

  if (ctx.platformRole !== "super_admin") {
    const tenants = await listTenants(db);
    const rows = tenants.ok ? tenants.data : [];
    const by = (s: string) => rows.filter((r) => r.status === s).length;
    return (
      <>
        <PageHeader title="Platform overview" description="Support administrators see ISP counts only. Fees and invoices are for super administrators." />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Registered ISPs" value={String(rows.length)} />
          <KpiCard label="Active ISPs" value={String(by("active"))} />
          <KpiCard label="Awaiting activation" value={String(by("pending"))} />
          <KpiCard label="Support access" value="Requests" hint="Ask an ISP owner for time-limited access" href="/admin/support-access" />
        </div>
      </>
    );
  }

  const [summary, monthly, isps] = await Promise.all([platformSummary(db), platformMonthly(db, 12), ispRevenue(db)]);
  if (!summary.ok) return <p className="text-sm text-danger">{summary.message}</p>;
  const s = summary.data;
  const months = monthly.ok ? monthly.data : [];
  const ispRows = isps.ok ? isps.data : [];
  const monthName = monthLabel(s.month, "long");

  return (
    <>
      <PageHeader
        title="Platform overview"
        description="FibrePulse's own business: ISPs, the collections fees are charged on, platform fees earned and what is still owed. Figures come from calculated fee records and platform invoices; ISP customer details are never shown here."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="platform-kpis">
        <KpiCard label="Registered ISPs" value={String(s.tenants)} hint={`${s.active} active · ${s.pending} awaiting activation`} href="/admin/tenants" />
        <KpiCard label="Eligible collections (all time)" value={formatKsh(s.eligible_total)} hint="Verified subscription collections in calculated months" />
        <KpiCard label="Platform fees earned" value={formatKsh(s.fees_total)} hint={s.fees_uninvoiced ? `${formatKsh(s.fees_uninvoiced)} not invoiced yet` : "All invoiced"} />
        <KpiCard
          label="Unpaid platform invoices"
          value={formatKsh(s.unpaid_total)}
          hint={s.overdue_count ? `${s.overdue_count} overdue: ${formatKsh(s.overdue_total)}` : `${s.unpaid_count} unpaid, none overdue`}
          tone={s.overdue_count ? "danger" : undefined}
          href="/admin/invoices?status=unpaid"
        />
        <KpiCard label={`${monthName} so far`} value={formatKsh(s.mtd_fee)} hint={`Estimated fee on ${formatKsh(s.mtd_eligible)} collected so far; final after month end`} />
        <KpiCard label="Paid to FibrePulse" value={formatKsh(s.paid_total)} hint={`${formatKsh(s.invoiced_total)} invoiced in total`} />
        <KpiCard label="ISPs with a signed agreement" value={`${s.signed_agreements} of ${s.active + s.suspended}`} hint="Fees can only be calculated under a signed agreement" href="/admin/agreements" />
        <KpiCard label="Subscribers on FibrePulse" value={s.customers.toLocaleString("en-KE")} hint="Customers of active ISPs (counts only)" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Platform fees by month</CardTitle>
            <CardDescription>Fees on each month&apos;s collections, including adjustments</CardDescription>
          </CardHeader>
          <CardContent>
            <TimeBarChart data={months.map((m) => ({ label: monthLabel(m.month), value: m.fees, detail: `${formatKsh(m.eligible)} eligible` }))} valueLabel="Platform fees" />
            <ChartTable
              caption="Platform fees by month"
              headers={["Month", "Eligible", "Fees", "Invoiced", "Paid"]}
              rows={months.map((m) => [monthLabel(m.month, "long"), formatKsh(m.eligible), formatKsh(m.fees), formatKsh(m.invoiced), formatKsh(m.paid)])}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>ISP onboarding and growth</CardTitle>
            <CardDescription>New ISPs, activations and subscribers added each month</CardDescription>
          </CardHeader>
          <CardContent>
            <TimeBarChart data={months.map((m) => ({ label: monthLabel(m.month), value: m.new_customers, detail: `${m.new_isps} ISPs registered, ${m.activated_isps} activated` }))} valueLabel="Subscribers added" format="count" />
            <ChartTable
              caption="Onboarding by month"
              headers={["Month", "ISPs registered", "ISPs activated", "Subscribers added"]}
              rows={months.map((m) => [monthLabel(m.month, "long"), m.new_isps, m.activated_isps, m.new_customers])}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Revenue per ISP</CardTitle>
          <CardDescription>Agreement, size and what each ISP has been charged and owes</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ISP</TableHead>
                  <TableHead>Agreement</TableHead>
                  <TableHead className="text-right">Subscribers</TableHead>
                  <TableHead className="text-right">This month so far</TableHead>
                  <TableHead className="text-right">Fees to date</TableHead>
                  <TableHead className="text-right">Unpaid</TableHead>
                  <TableHead>Last month charged</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ispRows.map((r) => (
                  <TableRow key={r.tenant_id}>
                    <TableCell>
                      <Link href={`/admin/tenants/${r.tenant_id}`} className="font-medium text-primary hover:underline">{r.name}</Link>
                      <div className="mt-1"><TenantStatusBadge status={r.status} /></div>
                    </TableCell>
                    <TableCell>
                      <AgreementBadge status={r.agreement_state} />
                      {r.fee_rate !== null ? <p className="mt-1 text-xs text-muted-foreground">{ratePct(r.fee_rate)}</p> : null}
                    </TableCell>
                    <TableCell className="tabular text-right">{r.customers.toLocaleString("en-KE")}<p className="text-xs text-muted-foreground">{r.active_subscriptions} live</p></TableCell>
                    <TableCell className="tabular text-right">{r.mtd_fee === null ? "—" : formatKsh(r.mtd_fee)}{r.mtd_eligible !== null ? <p className="text-xs text-muted-foreground">on {formatKsh(r.mtd_eligible)}</p> : null}</TableCell>
                    <TableCell className="tabular text-right">{formatKsh(r.fees_total)}</TableCell>
                    <TableCell className={r.overdue ? "tabular text-right text-danger" : "tabular text-right"}>{formatKsh(r.unpaid)}{r.overdue ? <p className="text-xs">{formatKsh(r.overdue)} overdue</p> : null}</TableCell>
                    <TableCell className="text-muted-foreground">{r.last_calculated ? monthLabel(r.last_calculated, "long") : "Never"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!ispRows.length ? <p className="px-5 py-6 text-sm text-muted-foreground">No ISPs yet.</p> : null}
        </CardContent>
      </Card>
      <p className="mt-4 text-xs text-muted-foreground">Updated {formatDate(new Date())}. Monthly fees are final once calculated after the month ends; a later reversal or verification adds an adjustment instead of changing history.</p>
    </>
  );
}
