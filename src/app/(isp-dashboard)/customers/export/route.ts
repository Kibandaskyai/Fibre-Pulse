import { NextResponse, type NextRequest } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { kenyaToday } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { customerFiltersSchema } from "@/lib/validation/billing";
import { toCsv } from "@/modules/customers/csv";
import { exportCustomers } from "@/modules/customers/service";

/** CSV export of the customer list with the same filters as the screen. */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.active || !ctx.active.permissions.has("customers:view")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const f = customerFiltersSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  const result = await exportCustomers(await createClient(), ctx.active.tenantId, f.success ? f.data : customerFiltersSchema.parse({}));
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 500 });

  const money = ctx.active.permissions.has("invoices:view");
  const header = ["customer_number", "full_name", "phone", "email", "address", "estate", "town", "county", "status", "pppoe_username", "registered_on"];
  if (money) header.push("outstanding_ksh", "credit_ksh");
  const rows = result.data.map((c) => {
    const row: unknown[] = [c.customer_number, c.full_name, c.phone, c.email, c.address, c.estate, c.town, c.county, c.status, c.pppoe_username, c.registered_on];
    if (money) row.push(c.outstanding.toFixed(2), c.credit.toFixed(2));
    return row;
  });
  return new NextResponse(toCsv(header, rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="customers-${kenyaToday()}.csv"`,
      "cache-control": "no-store",
    },
  });
}
