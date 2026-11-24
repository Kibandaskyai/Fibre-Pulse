import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { PlatformInvoiceBadge } from "@/components/platform/platform-badges";
import { InvoiceDocument } from "@/components/platform/invoice-document";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDate, kenyaToday } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { getInvoice, invoiceState } from "@/modules/platform/billing";

export const metadata: Metadata = { title: "FibrePulse invoice" };

export default async function IspInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePagePermission("platform_billing:view");
  const { id } = await params;
  const res = await getInvoice(await createClient(), id);
  if (!res.ok) return <p className="text-sm text-danger">{res.message}</p>;
  // RLS already hides other ISPs' invoices and drafts; the tenant check is belt and braces.
  if (!res.data || res.data.invoice.tenant_id !== ctx.active.tenantId) notFound();
  const { invoice: inv, lines } = res.data;
  const state = invoiceState(inv, kenyaToday());
  return (
    <>
      <Link href="/settings/billing" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> FibrePulse billing
      </Link>
      <PageHeader title={inv.invoice_number} description={`Issued ${formatDate(inv.issued_at)} · due ${formatDate(inv.due_date)}`} actions={<PlatformInvoiceBadge status={state} />} />
      <div className="max-w-3xl"><InvoiceDocument invoice={inv} lines={lines} /></div>
    </>
  );
}
