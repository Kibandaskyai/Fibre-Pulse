import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PlatformInvoiceBadge } from "@/components/platform/platform-badges";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { formatDate, formatKsh, kenyaToday } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { invoicesFor, invoiceState, ispRevenue } from "@/modules/platform/billing";
import { CalculateAllForm } from "../billing-forms";

export const metadata: Metadata = { title: "Platform invoices" };

const FILTERS = [
  ["", "All"],
  ["unpaid", "Unpaid"],
  ["paid", "Paid"],
  ["void", "Void"],
] as const;

export default async function PlatformInvoicesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requirePlatformStaff();
  if (ctx.platformRole !== "super_admin") redirect("/not-allowed");
  const { status = "" } = await searchParams;
  const db = await createClient();
  const today = kenyaToday();
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const lastMonth = d.toISOString().slice(0, 7);
  const [invoices, isps] = await Promise.all([invoicesFor(db, undefined, status), ispRevenue(db)]);
  const waiting = isps.ok ? isps.data.filter((r) => r.fees_uninvoiced > 0) : [];

  return (
    <>
      <PageHeader title="Fees and platform invoices" description="Calculate last month's fees for every ISP, issue invoices and record payments to FibrePulse." />
      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Monthly fee run</CardTitle>
            <CardDescription>Run after each month ends. Safe to repeat: unchanged months stay as they are and changes become adjustments.</CardDescription>
          </CardHeader>
          <CardContent><CalculateAllForm defaultMonth={lastMonth} maxMonth={lastMonth} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Waiting to be invoiced</CardTitle>
            <CardDescription>Calculated fees not yet on an invoice. Open the ISP to issue its invoice.</CardDescription>
          </CardHeader>
          <CardContent>
            {waiting.length ? (
              <ul className="grid gap-2 text-sm">
                {waiting.map((r) => (
                  <li key={r.tenant_id} className="flex items-center justify-between gap-3">
                    <Link href={`/admin/tenants/${r.tenant_id}`} className="text-primary hover:underline">{r.name}</Link>
                    <span className="tabular">{formatKsh(r.fees_uninvoiced)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing waiting.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mb-3 flex flex-wrap gap-2" role="navigation" aria-label="Invoice status">
        {FILTERS.map(([key, label]) => (
          <Button key={key} asChild size="sm" variant={status === key ? "secondary" : "ghost"}>
            <Link href={key ? `/admin/invoices?status=${key}` : "/admin/invoices"}>{label}</Link>
          </Button>
        ))}
      </div>
      {!invoices.ok ? (
        <p className="text-sm text-danger">{invoices.message}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>ISP</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.data.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell><Link href={`/admin/invoices/${i.id}`} className="tabular whitespace-nowrap text-primary hover:underline">{i.invoice_number}</Link></TableCell>
                      <TableCell>{i.tenant_name}</TableCell>
                      <TableCell>{formatDate(i.issued_at)}</TableCell>
                      <TableCell>{formatDate(i.due_date)}</TableCell>
                      <TableCell className="tabular text-right">{formatKsh(i.total)}</TableCell>
                      <TableCell><PlatformInvoiceBadge status={invoiceState(i, today)} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {!invoices.data.length ? <p className="px-5 py-6 text-sm text-muted-foreground">No invoices here.</p> : null}
          </CardContent>
        </Card>
      )}
    </>
  );
}
