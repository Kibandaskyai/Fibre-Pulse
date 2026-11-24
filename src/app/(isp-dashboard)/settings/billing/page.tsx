import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AgreementBadge, PlatformInvoiceBadge } from "@/components/platform/platform-badges";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDate, formatKsh, kenyaToday, plural } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import {
  agreementsFor,
  FEE_BASIS_LABELS,
  feeMonths,
  feeRecordsFor,
  invoicesFor,
  invoiceState,
  ratePct,
  REVENUE_CATEGORY_LABELS,
} from "@/modules/platform/billing";

export const metadata: Metadata = { title: "FibrePulse billing" };

const monthName = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-KE", { month: "long", year: "numeric", timeZone: "UTC" });

/** What this ISP pays FibrePulse: agreement terms, monthly fees and invoices. Read-only, through RLS. */
export default async function IspBillingPage() {
  const ctx = await requirePagePermission("platform_billing:view");
  const db = await createClient();
  const tenantId = ctx.active.tenantId;
  const [agreements, fees, invoices] = await Promise.all([agreementsFor(db, tenantId), feeRecordsFor(db, tenantId), invoicesFor(db, tenantId)]);
  const today = kenyaToday();
  const all = agreements.ok ? agreements.data : [];
  const current = all.find((a) => a.status === "active");
  const draft = all.find((a) => a.status === "draft");
  const months = fees.ok ? feeMonths(fees.data) : [];
  const invs = invoices.ok ? invoices.data : [];
  const unpaid = invs.filter((i) => ["issued", "overdue"].includes(invoiceState(i, today)));
  const unpaidTotal = unpaid.reduce((s, i) => s + i.total, 0);

  return (
    <>
      <PageHeader
        title="FibrePulse billing"
        description="What your ISP pays FibrePulse. The fee is a share of verified subscription collections each calendar month, under the agreement you signed."
      />
      {!agreements.ok || !fees.ok || !invoices.ok ? (
        <p className="mb-4 text-sm text-danger">{!agreements.ok ? agreements.message : !fees.ok ? fees.message : !invoices.ok ? invoices.message : ""}</p>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your agreement</CardTitle>
            <CardDescription>Signed terms never change. A new rate needs a new signed version.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm" data-testid="isp-agreement">
            {current ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-2xl font-semibold tabular">{ratePct(current.fee_rate)}</span>
                  <span className="text-muted-foreground">of {FEE_BASIS_LABELS[current.fee_basis].toLowerCase()}</span>
                  <AgreementBadge status={current.status} />
                </div>
                <dl className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                  <dt className="text-muted-foreground">Version</dt><dd>v{current.version}</dd>
                  <dt className="text-muted-foreground">In force from</dt><dd>{monthName(current.effective_from)}</dd>
                  <dt className="text-muted-foreground">Not charged</dt>
                  <dd>{current.excluded_categories.map((c) => REVENUE_CATEGORY_LABELS[c] ?? c).join(", ") || "Nothing excluded"}</dd>
                  <dt className="text-muted-foreground">Signed</dt><dd>{current.signed_by_name}, {formatDate(current.signed_at)}</dd>
                </dl>
              </>
            ) : (
              <p className="text-muted-foreground">No signed agreement yet. FibrePulse charges nothing until one is signed.</p>
            )}
            {draft ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-3">
                Proposed version {draft.version}: {ratePct(draft.fee_rate)} from {monthName(draft.effective_from)}. It applies only once it is signed.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">Reversed, refunded, unverified and simulated payments are never charged.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Balance</CardTitle>
            <CardDescription>Invoices FibrePulse has issued to you</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p className="text-2xl font-semibold tabular" data-testid="isp-unpaid">{formatKsh(unpaidTotal)}</p>
            <p className="text-muted-foreground">{unpaid.length ? `${unpaid.length} unpaid invoice${unpaid.length === 1 ? "" : "s"}` : "Nothing owed."}</p>
            {/* TODO: SOFTWARE ENGINEER - IMPLEMENT SAFARICOM DARAJA INTEGRATION (FibrePulse paybill details and STK push for platform invoices) */}
            <p className="text-xs text-muted-foreground">Pay by M-Pesa or bank transfer and quote the invoice number. FibrePulse records the payment against the invoice.</p>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invs.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell><Link href={`/settings/billing/invoices/${i.id}`} className="whitespace-nowrap font-medium text-primary hover:underline">{i.invoice_number}</Link></TableCell>
                    <TableCell className="whitespace-nowrap">{monthName(i.period_start)}{i.period_start.slice(0, 7) !== i.period_end.slice(0, 7) ? ` to ${monthName(i.period_end)}` : ""}</TableCell>
                    <TableCell>{formatDate(i.due_date)}</TableCell>
                    <TableCell className="tabular text-right">{formatKsh(i.total)}</TableCell>
                    <TableCell><PlatformInvoiceBadge status={invoiceState(i, today)} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!invs.length ? <p className="px-5 py-6 text-sm text-muted-foreground">No invoices yet.</p> : null}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Monthly fees</CardTitle>
          <CardDescription>Calculated after each month ends. A later reversal or verification shows as an adjustment; past figures are never edited.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Month</TableHead>
                  <TableHead className="text-right">Eligible collections</TableHead>
                  <TableHead className="text-right">Fee</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {months.map((m) => (
                  <TableRow key={m.period_start}>
                    <TableCell>
                      {monthName(m.period_start)}
                      {m.base ? <p className="text-xs text-muted-foreground">{plural(m.base.payment_count, "verified payment")} at {ratePct(m.base.fee_rate)}</p> : null}
                      {m.adjustments.length ? <p className="text-xs text-muted-foreground">{m.adjustments.length} adjustment{m.adjustments.length === 1 ? "" : "s"}</p> : null}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatKsh(m.eligible)}</TableCell>
                    <TableCell className="tabular text-right">{formatKsh(m.fee)}</TableCell>
                    <TableCell><PlatformInvoiceBadge status={m.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!months.length ? <p className="px-5 py-6 text-sm text-muted-foreground">No fees calculated yet.</p> : null}
        </CardContent>
      </Card>
    </>
  );
}
