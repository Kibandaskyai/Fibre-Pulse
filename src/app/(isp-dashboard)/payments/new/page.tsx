import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatKsh } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { getCustomer } from "@/modules/customers/service";
import { acceptedMethods } from "@/modules/hotspot/service";
import { RecordPaymentForm } from "./record-payment-form";

export const metadata: Metadata = { title: "Record payment" };

function kenyaNowLocal(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

export default async function RecordPaymentPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const ctx = await requirePagePermission("payments:record");
  const sp = await searchParams;
  const db = await createClient();
  const [customer, methods] = await Promise.all([
    sp.customer && /^[0-9a-f-]{36}$/i.test(sp.customer) ? getCustomer(db, ctx.active.tenantId, sp.customer) : Promise.resolve(null),
    acceptedMethods(db, ctx.active.tenantId),
  ]);
  const mpesaOnly = methods.length === 1 && methods[0] === "mpesa";
  const c = customer?.ok ? customer.data : null;

  return (
    <>
      <PageHeader
        title="Record payment"
        description={mpesaOnly ? "For money you can see in your M-Pesa statement. It is saved as awaiting verification and counts as revenue only after someone verifies it." : "For money you can see in your M-Pesa or bank statement. It is saved as awaiting verification and counts as revenue only after someone verifies it."}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardContent className="pt-5">
            <RecordPaymentForm customerId={c?.id ?? null} defaultTime={kenyaNowLocal()} methods={methods} />
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{c ? c.full_name : "No customer chosen"}</CardTitle>
            <CardDescription>
              {c
                ? `${c.customer_number} · ${c.phone} · Outstanding ${formatKsh(c.outstanding)}`
                : "The payment will be saved as unmatched. Link it to a customer from the payment page."}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            The same reference cannot be recorded twice. Cash is not accepted as a payment method.
          </CardContent>
        </Card>
      </div>
    </>
  );
}
