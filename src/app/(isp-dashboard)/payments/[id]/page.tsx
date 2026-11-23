import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm } from "@/components/shared/action-form";
import { InvoiceStatusBadge, PaymentStatusBadge, VerificationBadge } from "@/components/shared/billing-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDateTime, formatKsh, PAYMENT_METHOD_LABELS } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import {
  allocatePaymentAction,
  assignPaymentCustomerAction,
  rejectPaymentAction,
  reversePaymentAction,
  verifyPaymentAction,
} from "@/modules/billing/actions";
import { findCustomers, getPayment, openInvoicesForCustomer } from "@/modules/billing/service";

export const metadata: Metadata = { title: "Payment" };

const SOURCES: Record<string, string> = {
  mpesa_statement: "M-Pesa statement",
  bank_statement: "Bank statement",
  provider_query: "Provider transaction query",
  manual_review: "Manual review",
};

export default async function PaymentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ recorded?: string; find?: string }> }) {
  const ctx = await requirePagePermission("payments:view");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await createClient();
  const detail = await getPayment(db, ctx.active.tenantId, id);
  if (!detail) notFound();
  const { payment: p, allocations, reconciliation, unallocated } = detail;
  const canReconcile = ctx.active.permissions.has("payments:reconcile");
  const verified = p.status === "successful" && p.verification_status === "verified";
  const [openInvoices, matches] = await Promise.all([
    canReconcile && verified && p.customer_id && unallocated > 0 ? openInvoicesForCustomer(db, ctx.active.tenantId, p.customer_id) : Promise.resolve([]),
    canReconcile && !p.customer_id && sp.find ? findCustomers(db, ctx.active.tenantId, sp.find) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title={`${formatKsh(p.amount)} ${PAYMENT_METHOD_LABELS[p.method] ?? p.method}`}
        description={`Reference ${p.provider_reference ?? "none"} · paid ${formatDateTime(p.transaction_at)}`}
        actions={
          <>
            <DataSourceBadge source={p.data_source} />
            <PaymentStatusBadge status={p.status} />
            <VerificationBadge status={p.verification_status} />
          </>
        }
      />
      <Flash success={sp.recorded ? "Payment recorded. Verify it against the statement so it counts as collected." : null} />
      {p.data_source === "simulated" ? (
        <Flash error="This is simulated test data. It can never be verified or counted as revenue." />
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><p className="text-xs text-muted-foreground">Customer</p>
                {p.customer_id && p.customers ? <Link className="hover:underline" href={`/customers/${p.customer_id}?tab=payments`}>{p.customers.full_name} ({p.customers.customer_number})</Link> : <p className="text-warning">Not linked to a customer</p>}
              </div>
              <div><p className="text-xs text-muted-foreground">Payer</p><p>{[p.payer_name, p.payer_phone].filter(Boolean).join(" · ") || "—"}</p></div>
              <div><p className="text-xs text-muted-foreground">Applied to invoices</p><p className="tabular">{formatKsh(Number(p.amount) - unallocated)}</p></div>
              <div><p className="text-xs text-muted-foreground">Unapplied</p><p className="tabular">{formatKsh(unallocated)}</p></div>
              <div className="sm:col-span-2"><p className="text-xs text-muted-foreground">Note</p><p>{p.description || "—"}</p></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Allocations</CardTitle><CardDescription>Which invoices this payment paid.</CardDescription></CardHeader>
            <CardContent className="p-0 pb-2">
              {allocations.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Invoice status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {allocations.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="tabular">{a.invoices?.invoice_number}</TableCell>
                        <TableCell className="tabular text-right">{formatKsh(a.amount)}</TableCell>
                        <TableCell>{a.invoices ? <InvoiceStatusBadge status={a.invoices.status} /> : null}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="px-5 pb-3 text-sm text-muted-foreground">{verified ? "Not applied to any invoice yet." : "Payments are applied to invoices once verified."}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Reconciliation history</CardTitle></CardHeader>
            <CardContent className="p-0 pb-2">
              {reconciliation.length ? (
                <Table>
                  <TableBody>
                    {reconciliation.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-xs">{formatDateTime(r.created_at)}</TableCell>
                        <TableCell>{SOURCES[r.statement_source] ?? r.statement_source}{r.statement_reference ? ` · ${r.statement_reference}` : ""}</TableCell>
                        <TableCell className="capitalize">{r.result}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.notes}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="px-5 pb-3 text-sm text-muted-foreground">Not checked against a statement yet.</p>}
            </CardContent>
          </Card>
        </div>

        {canReconcile ? (
          <div className="grid h-fit gap-6">
            {p.status === "successful" && p.verification_status === "unverified" && p.data_source !== "simulated" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Verify</CardTitle>
                  <CardDescription>Confirm you found this exact amount and reference on the statement.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ActionForm action={verifyPaymentAction} submitLabel="Mark as verified" hidden={{ paymentId: p.id }}>
                    <Label htmlFor="v-source">Checked against</Label>
                    <NativeSelect id="v-source" name="statementSource" defaultValue={p.method === "mpesa" ? "mpesa_statement" : "bank_statement"}>
                      {Object.entries(SOURCES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </NativeSelect>
                    <Label htmlFor="v-ref">Statement line or reference (optional)</Label>
                    <Input id="v-ref" name="statementReference" />
                    <Label htmlFor="v-notes">Note (optional)</Label>
                    <Input id="v-notes" name="notes" />
                  </ActionForm>
                </CardContent>
              </Card>
            ) : null}

            {p.verification_status === "unverified" ? (
              <Card>
                <CardHeader><CardTitle>Reject</CardTitle><CardDescription>The money is not on the statement.</CardDescription></CardHeader>
                <CardContent>
                  <ActionForm action={rejectPaymentAction} submitLabel="Reject payment" variant="outline" hidden={{ paymentId: p.id }}>
                    <Label htmlFor="rj-reason">Reason</Label>
                    <Input id="rj-reason" name="reason" placeholder="e.g. Not on the 23 Nov statement" />
                  </ActionForm>
                </CardContent>
              </Card>
            ) : null}

            {!p.customer_id && p.status === "successful" ? (
              <Card>
                <CardHeader><CardTitle>Link to a customer</CardTitle></CardHeader>
                <CardContent className="grid gap-3">
                  <form className="flex gap-2" role="search">
                    <Input name="find" defaultValue={sp.find ?? ""} placeholder="Name, number or phone" aria-label="Find customer" />
                    <Button type="submit" variant="secondary">Find</Button>
                  </form>
                  {matches.map((m) => (
                    <ActionForm key={m.id} action={assignPaymentCustomerAction} submitLabel={`Link to ${m.full_name}`} variant="outline" hidden={{ paymentId: p.id, customerId: m.id }}>
                      <p className="text-xs text-muted-foreground">{m.customer_number} · {m.phone}</p>
                    </ActionForm>
                  ))}
                  {sp.find && !matches.length ? <p className="text-sm text-muted-foreground">No customers match.</p> : null}
                </CardContent>
              </Card>
            ) : null}

            {openInvoices.length ? (
              <Card>
                <CardHeader><CardTitle>Apply to an invoice</CardTitle><CardDescription>Verified payments apply to the oldest invoice automatically; use this to choose another.</CardDescription></CardHeader>
                <CardContent>
                  <ActionForm action={allocatePaymentAction} submitLabel="Apply" variant="secondary" hidden={{ paymentId: p.id }}>
                    <Label htmlFor="al-inv">Invoice</Label>
                    <NativeSelect id="al-inv" name="invoiceId">
                      {openInvoices.map((i) => <option key={i.id} value={i.id}>{i.invoice_number} · {formatKsh(i.balance)} due</option>)}
                    </NativeSelect>
                    <Label htmlFor="al-amount">Amount (Ksh)</Label>
                    <Input id="al-amount" name="amount" inputMode="decimal" defaultValue={Math.min(unallocated, openInvoices[0].balance).toFixed(2)} />
                  </ActionForm>
                </CardContent>
              </Card>
            ) : null}

            {p.status === "successful" ? (
              <Card>
                <CardHeader><CardTitle>Reverse</CardTitle><CardDescription>For a bank recall or M-Pesa reversal. The record is kept and its invoices become unpaid again.</CardDescription></CardHeader>
                <CardContent>
                  <ActionForm action={reversePaymentAction} submitLabel="Reverse payment" variant="destructive" hidden={{ paymentId: p.id }}>
                    <Label htmlFor="rv-reason">Reason</Label>
                    <Input id="rv-reason" name="reason" placeholder="e.g. Bank recalled the transfer" />
                  </ActionForm>
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
