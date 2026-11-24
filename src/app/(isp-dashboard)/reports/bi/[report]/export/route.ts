import { NextResponse, type NextRequest } from "next/server";
import { getSessionContext } from "@/lib/auth/session";
import { resolveRange } from "@/lib/date-range";
import { createClient } from "@/lib/supabase/server";
import { biCsv, biDefinition, biFileName, canOpen, loadBiReport } from "@/modules/reports/bi";
import { biPdf } from "@/modules/reports/bi-pdf";

/**
 * BI report downloads: /reports/bi/{report}/export?range=…&from=…&to=…&area=…&format=csv|pdf.
 * Read as the signed-in user; the database functions check the report
 * permission again.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const def = biDefinition((await params).report);
  if (!def) return NextResponse.json({ error: "Unknown report" }, { status: 404 });
  const ctx = await getSessionContext();
  if (!ctx?.active || !canOpen(def, ctx.active.permissions)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const sp = request.nextUrl.searchParams;
  const g = (k: string, max = 40) => (sp.get(k) ?? "").slice(0, max) || undefined;
  const range = resolveRange({ range: g("range"), from: g("from", 10), to: g("to", 10) }, "this_month");
  const report = await loadBiReport(await createClient(), def.key, {
    tenantId: ctx.active.tenantId,
    tenantName: ctx.active.tenantName,
    range,
    area: def.area ? g("area", 80) : null,
  });
  if (!report.ok) return NextResponse.json({ error: report.message }, { status: 500 });
  const pdf = sp.get("format") === "pdf";
  const body = pdf ? Buffer.from(await biPdf(report.data)) : biCsv(report.data);
  return new NextResponse(body, {
    headers: {
      "content-type": pdf ? "application/pdf" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${biFileName(report.data, pdf ? "pdf" : "csv")}"`,
      "cache-control": "no-store",
    },
  });
}
