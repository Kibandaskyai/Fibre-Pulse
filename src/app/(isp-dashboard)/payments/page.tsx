import type { Metadata } from "next";
import Link from "next/link";
import { Download, FileCheck2, Receipt, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InvoiceStatusBadge, PaymentStatusBadge, VerificationBadge } from "@/components/shared/billing-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDate, formatDateTime, formatKsh, PAYMENT_METHOD_LABELS } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { listInvoices, listPayments, PAGE_SIZE, paymentTotals } from "@/modules/billing/service";

export const metadata: Metadata = { title: "Payments" };

const s = (v: string | undefined, max = 40) => (v ?? "").slice(0, max);

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePagePermission("payments:view");
  const sp = await searchParams;
  const db = await createClient();
  const tab = sp.tab === "invoices" ? "invoices" : "payments";
  const page = Math.max(1, Number(sp.page) || 1);
  const f = { verification: s(sp.verification), method: s(sp.method), q: s(sp.q), from: s(sp.from, 10), to: s(sp.to, 10), page };
  const invoiceStatus = s(sp.status);
  const totals = await paymentTotals(db, ctx.active.tenantId);
  const canRecord = ctx.active.permissions.has("payments:record");
  const canReconcile = ctx.active.permissions.has("payments:reconcile");

  const filterParams = { verification: f.verification, method: f.method, q: f.q, from: f.from, to: f.to };
  const exportQs = new URLSearchParams(Object.entries(filterParams).filter(([, v]) => v)).toString();

  return (
    <>
      <PageHeader
        title="Payments"
        description="Only successful, verified payments count as collected revenue. Simulated payments are labelled and never count."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/payments/export${exportQs ? `?${exportQs}` : ""}`} prefetch={false}><Download aria-hidden /> Export CSV</Link>
            </Button>
            {canReconcile ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/payments/reconcile"><FileCheck2 aria-hidden /> Reconcile statement</Link>
              </Button>
            ) : null}
            {canRecord ? <Button asChild size="sm"><Link href="/payments/new"><Wallet aria-hidden /> Record payment</Link></Button> : null}
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Link href="/payments?verification=unverified">
          <Card className="transition-colors hover:border-primary/50">
            <CardHeader className="pb-2"><CardDescription>Awaiting verification</CardDescription></CardHeader>
            <CardContent><p className={cn("tabular text-2xl font-semibold", totals.awaitingVerification && "text-warning")}>{totals.awaitingVerification}</p></CardContent>
          </Card>
        </Link>
        <Link href="/payments?verification=unmatched">
          <Card className="transition-colors hover:border-primary/50">
            <CardHeader className="pb-2"><CardDescription>Not linked to a customer</CardDescription></CardHeader>
            <CardContent><p className={cn("tabular text-2xl font-semibold", totals.unmatched && "text-warning")}>{totals.unmatched}</p></CardContent>
          </Card>
        </Link>
      </div>

      <nav className="mb-4 flex gap-2" aria-label="Payments and invoices">
        {(["payments", "invoices"] as const).map((t) => (
          <Link
            key={t}
            href={t === "payments" ? "/payments" : "/payments?tab=invoices"}
            aria-current={t === tab ? "page" : undefined}
            className={cn("rounded-full border px-3 py-1 text-sm capitalize", t === tab ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}
          >
            {t}
          </Link>
        ))}
      </nav>

      {tab === "payments" ? <PaymentsTab tenantId={ctx.active.tenantId} f={f} params={filterParams} /> : <InvoicesTab tenantId={ctx.active.tenantId} status={invoiceStatus} page={page} />}
    </>
  );
}

async function PaymentsTab({ tenantId, f, params }: { tenantId: string; f: Parameters<typeof listPayments>[2]; params: Record<string, string> }) {
  const result = await listPayments(await createClient(), tenantId, f);
  const filtered = Object.values(params).some(Boolean);
  return (
    <>
      <form className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-[1fr_12rem_10rem_9.5rem_9.5rem_auto]" role="search">
        <Input name="q" defaultValue={f.q} placeholder="Receipt or reference" aria-label="Reference" />
        <NativeSelect name="verification" defaultValue={f.verification} aria-label="Verification">
          <option value="">Any verification</option>
          <option value="unverified">Awaiting verification</option>
          <option value="verified">Verified</option>
          <option value="rejected">Rejected</option>
          <option value="unmatched">No customer</option>
        </NativeSelect>
        <NativeSelect name="method" defaultValue={f.method} aria-label="Method">
          <option value="">Any method</option>
          <option value="mpesa">M-Pesa</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="other">Other</option>
        </NativeSelect>
        <Input name="from" type="date" defaultValue={f.from} aria-label="From date" />
        <Input name="to" type="date" defaultValue={f.to} aria-label="To date" />
        <div className="flex gap-2">
          <Button type="submit" variant="secondary">Filter</Button>
          {filtered ? <Button asChild variant="ghost"><Link href="/payments">Clear</Link></Button> : null}
        </div>
      </form>
      {!result.ok ? (
        <Flash error={result.message} />
      ) : result.data.total === 0 ? (
        <EmptyState icon={<Wallet />} title={filtered ? "No payments match" : "No payments yet"} description="Record M-Pesa and bank payments as they arrive. Automatic M-Pesa collection is added at handover." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden md:table-cell">When</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Link className="tabular font-medium hover:underline" href={`/payments/${p.id}`}>{p.provider_reference ?? "No reference"}</Link>
                      <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">{PAYMENT_METHOD_LABELS[p.method]} <DataSourceBadge source={p.data_source} /></p>
                    </TableCell>
                    <TableCell>
                      {p.customers && p.customer_id ? (
                        <Link className="hover:underline" href={`/customers/${p.customer_id}?tab=payments`}>{p.customers.full_name}</Link>
                      ) : <span className="text-warning">Not linked</span>}
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">{formatDateTime(p.transaction_at)}</TableCell>
                    <TableCell className="tabular text-right">{formatKsh(p.amount)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {p.status !== "successful" ? <PaymentStatusBadge status={p.status} /> : null}
                        <VerificationBadge status={p.verification_status} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination path="/payments" params={params} page={f.page} pageSize={PAGE_SIZE} total={result.data.total} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

async function InvoicesTab({ tenantId, status, page }: { tenantId: string; status: string; page: number }) {
  const result = await listInvoices(await createClient(), tenantId, { status, page });
  const STATUSES = [["", "All"], ["open", "Unpaid"], ["partially_paid", "Part paid"], ["paid", "Paid"], ["void", "Void"]];
  return (
    <>
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Invoice status">
        {STATUSES.map(([k, l]) => (
          <Link key={k} href={`/payments?tab=invoices${k ? `&status=${k}` : ""}`} aria-current={k === status ? "page" : undefined}
            className={cn("rounded-md px-2 py-1 text-xs", k === status ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground")}>
            {l}
          </Link>
        ))}
      </nav>
      {!result.ok ? (
        <Flash error={result.message} />
      ) : result.data.total === 0 ? (
        <EmptyState icon={<Receipt />} title="No invoices" description="Invoices are issued automatically when a customer buys or renews a package." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden md:table-cell">Issued</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.rows.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="tabular">{i.invoice_number}</TableCell>
                    <TableCell><Link className="hover:underline" href={`/customers/${i.customer_id}?tab=invoices`}>{i.customers?.full_name}</Link></TableCell>
                    <TableCell className="hidden md:table-cell">{formatDate(i.issue_date)}</TableCell>
                    <TableCell className="tabular text-right">{formatKsh(i.total)}</TableCell>
                    <TableCell className="hidden tabular sm:table-cell text-right">{i.status === "void" ? "—" : formatKsh(Number(i.total) - Number(i.amount_paid))}</TableCell>
                    <TableCell><InvoiceStatusBadge status={i.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination path="/payments" params={{ tab: "invoices", status }} page={page} pageSize={PAGE_SIZE} total={result.data.total} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
