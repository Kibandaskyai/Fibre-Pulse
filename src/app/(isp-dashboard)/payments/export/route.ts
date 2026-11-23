import { NextResponse, type NextRequest } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { kenyaToday } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { listPayments } from "@/modules/billing/service";
import { toCsv } from "@/modules/customers/csv";

/** CSV export of payments with the same filters as the screen (up to 20,000 rows). */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.active || !ctx.active.permissions.has("payments:view")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const sp = request.nextUrl.searchParams;
  const g = (k: string, max = 40) => (sp.get(k) ?? "").slice(0, max);
  const db = await createClient();
  const rows: unknown[][] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await listPayments(db, ctx.active.tenantId, { verification: g("verification"), method: g("method"), q: g("q"), from: g("from", 10), to: g("to", 10), page }, 1000);
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: 500 });
    for (const p of r.data.rows) {
      rows.push([
        p.transaction_at, p.method, p.provider_reference, Number(p.amount).toFixed(2), p.status, p.verification_status, p.reconciliation_status,
        p.data_source, p.customers?.customer_number, p.customers?.full_name, p.payer_phone, p.payer_name, p.description,
        // Only these count as collected revenue.
        p.status === "successful" && p.verification_status === "verified" ? "yes" : "no",
      ]);
    }
    if (r.data.rows.length < 1000) break;
  }
  const header = [
    "transaction_at", "method", "reference", "amount_ksh", "status", "verification", "reconciliation", "data_source",
    "customer_number", "customer_name", "payer_phone", "payer_name", "description", "counts_as_revenue",
  ];
  return new NextResponse(toCsv(header, rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="payments-${kenyaToday()}.csv"`,
      "cache-control": "no-store",
    },
  });
}
