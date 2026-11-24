import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { PlatformInvoiceBadge } from "@/components/platform/platform-badges";
import { InvoiceDocument } from "@/components/platform/invoice-document";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { formatDate, kenyaToday } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { getInvoice, invoiceState } from "@/modules/platform/billing";
import { RecordPaymentForm, VoidInvoiceForm } from "../../billing-forms";

export const metadata: Metadata = { title: "Platform invoice" };

export default async function PlatformInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePlatformStaff();
  if (ctx.platformRole !== "super_admin") redirect("/not-allowed");
  const { id } = await params;
  const res = await getInvoice(await createClient(), id);
  if (!res.ok) return <p className="text-sm text-danger">{res.message}</p>;
  if (!res.data) notFound();
  const { invoice: inv, lines } = res.data;
  const today = kenyaToday();
  const state = invoiceState(inv, today);
  return (
    <>
      <Link href={`/admin/tenants/${inv.tenant_id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> {inv.tenant_name}
      </Link>
      <PageHeader title={inv.invoice_number} description={`Issued ${formatDate(inv.issued_at)} · due ${formatDate(inv.due_date)}`} actions={<PlatformInvoiceBadge status={state} />} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <InvoiceDocument invoice={inv} lines={lines} />
        {state === "issued" || state === "overdue" ? (
          <div className="grid h-fit gap-6">
            <Card>
              <CardHeader><CardTitle>Record payment</CardTitle></CardHeader>
              <CardContent><RecordPaymentForm invoiceId={inv.id} tenantId={inv.tenant_id} today={today} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Wrong invoice?</CardTitle></CardHeader>
              <CardContent className="grid gap-2 text-sm text-muted-foreground">
                <p>Voiding keeps the invoice on record and frees its fees for a new invoice.</p>
                <VoidInvoiceForm invoiceId={inv.id} tenantId={inv.tenant_id} />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
