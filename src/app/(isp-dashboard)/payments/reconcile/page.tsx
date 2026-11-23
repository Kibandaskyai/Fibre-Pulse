import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDate, formatKsh } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { unmatchedStatementLines } from "@/modules/reconciliation/service";
import { ReconcileForm } from "./reconcile-form";

export const metadata: Metadata = { title: "Reconcile statement" };

export default async function ReconcilePage() {
  const ctx = await requirePagePermission("payments:reconcile");
  const unmatched = await unmatchedStatementLines(await createClient(), ctx.active.tenantId);
  return (
    <>
      <PageHeader
        title="Reconcile a statement"
        description="Upload your M-Pesa paybill or bank statement. Recorded payments that appear on it with the same reference and amount are verified and start counting as revenue."
        actions={<Link className="text-sm text-primary hover:underline" href="/payments">Back to payments</Link>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <ReconcileForm />
        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Which file?</CardTitle>
              <CardDescription>CSV, up to 2 MB and 5,000 money-in lines. One month at a time works best.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <p><strong>M-Pesa:</strong> on the M-Pesa Org portal, export the paybill statement as CSV. FibrePulse reads Receipt No., Completion Time, Details, Transaction Status and Paid In.</p>
              <p><strong>Bank:</strong> download the statement as CSV from online banking. FibrePulse reads the date, reference, narration and credit (or a signed amount) columns.</p>
              <p className="text-muted-foreground">Withdrawals, charges and failed transactions are skipped. Checking the file changes nothing until you confirm.</p>
              <p className="text-muted-foreground">Simulated test payments are never verified, even if a reference matches.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Statement money not yet recorded</CardTitle>
              <CardDescription>From earlier uploads. Record these payments, then reconcile again.</CardDescription>
            </CardHeader>
            <CardContent className={unmatched.length ? "p-0 pb-2" : "text-sm text-muted-foreground"}>
              {unmatched.length ? (
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Reference</TableHead><TableHead>Date</TableHead><TableHead className="text-right">Amount</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {unmatched.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>
                          {u.statement_reference}
                          <p className="max-w-44 truncate text-xs text-muted-foreground" title={u.notes ?? undefined}>{u.statement_source === "mpesa_statement" ? "M-Pesa" : "Bank"}{u.notes ? ` · ${u.notes}` : ""}</p>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{formatDate(u.statement_date)}</TableCell>
                        <TableCell className="tabular text-right">{u.statement_amount !== null ? formatKsh(Number(u.statement_amount)) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                "None outstanding."
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
