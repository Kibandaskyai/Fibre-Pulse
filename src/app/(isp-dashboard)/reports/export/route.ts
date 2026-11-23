import { NextResponse, type NextRequest } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { dayRange, monthRange, resolveRange } from "@/lib/date-range";
import { createClient } from "@/lib/supabase/server";
import { loadRevenueReport, reportCsv, reportFileName, type ReportKind } from "@/modules/analytics/report";
import { reportPdf } from "@/modules/analytics/report-pdf";

/**
 * Financial report downloads.
 *   ?kind=range&range=…&from=…&to=…&area=…   (the revenue page's filters)
 *   ?kind=daily&date=YYYY-MM-DD
 *   ?kind=monthly&month=YYYY-MM
 * and &format=csv|pdf. Read as the signed-in user, so RLS and the
 * revenue:view check in the database apply.
 */
export async function GET(request: NextRequest) {
  const ctx = await getSessionContext();
  const sp = request.nextUrl.searchParams;
  const g = (k: string, max = 40) => (sp.get(k) ?? "").slice(0, max) || undefined;
  const kind: ReportKind = sp.get("kind") === "daily" ? "daily" : sp.get("kind") === "monthly" ? "monthly" : "range";
  const needs = kind === "range" ? "revenue:view" : "reports:financial";
  if (!ctx?.active || !ctx.active.permissions.has("revenue:view") || !ctx.active.permissions.has(needs)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const range =
    kind === "daily" ? dayRange(g("date", 10)) : kind === "monthly" ? monthRange(g("month", 7)) : resolveRange({ range: g("range"), from: g("from", 10), to: g("to", 10) });
  const report = await loadRevenueReport(await createClient(), {
    tenantId: ctx.active.tenantId,
    tenantName: ctx.active.tenantName,
    range,
    area: kind === "range" ? g("area", 80) : null,
    kind,
    canSeeCustomers: ctx.active.permissions.has("customers:view"),
  });
  if (!report.ok) return NextResponse.json({ error: report.message }, { status: 500 });

  const pdf = sp.get("format") === "pdf";
  const body = pdf ? Buffer.from(await reportPdf(report.data)) : reportCsv(report.data);
  return new NextResponse(body, {
    headers: {
      "content-type": pdf ? "application/pdf" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${reportFileName(report.data, pdf ? "pdf" : "csv")}"`,
      "cache-control": "no-store",
    },
  });
}
