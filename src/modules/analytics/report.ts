/**
 * Financial reports: one loader feeds the revenue page, the daily and
 * monthly reports, and their CSV and PDF downloads, so every format shows the
 * same figures. All money is verified collections only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { daysBetween, grainFor, previousPeriod, type DateRange } from "@/lib/date-range";
import { formatDate, formatDateTime, formatKsh, kenyaLocalToIso, PAYMENT_METHOD_LABELS } from "@/lib/format";
import { csvCell } from "@/modules/customers/csv";
import {
  outstandingAgeing,
  revenueBreakdown,
  revenueKpis,
  revenueSeries,
  topBalances,
  verifiedPayments,
  type AgeingRow,
  type BalanceRow,
  type BreakdownRow,
  type DayPayment,
  type RevenueKpis,
  type SeriesPoint,
} from "./service";

export type ReportKind = "range" | "daily" | "monthly";

export type RevenueReport = {
  kind: ReportKind;
  title: string;
  tenantName: string;
  range: DateRange;
  area: string | null;
  generatedAt: string;
  grain: "day" | "month";
  kpis: RevenueKpis;
  previous: RevenueKpis | null;
  series: SeriesPoint[];
  byPackage: BreakdownRow[];
  byArea: BreakdownRow[];
  byMethod: BreakdownRow[];
  ageing: AgeingRow[];
  balances: BalanceRow[] | null;
  payments: DayPayment[] | null;
};

const TITLES: Record<ReportKind, string> = {
  range: "Revenue report",
  daily: "Daily collections report",
  monthly: "Monthly revenue report",
};

export async function loadRevenueReport(
  db: SupabaseClient,
  opts: { tenantId: string; tenantName: string; range: DateRange; area?: string | null; kind?: ReportKind; canSeeCustomers: boolean },
): Promise<{ ok: true; data: RevenueReport } | { ok: false; message: string }> {
  const { tenantId, range } = opts;
  const area = opts.area?.trim() || null;
  const kind = opts.kind ?? "range";
  const grain = grainFor(range);
  const prev = previousPeriod(range);
  const withPayments = kind === "daily" || (kind === "range" && daysBetween(range.from, range.to) === 0);
  const nextDay = new Date(Date.parse(`${range.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  const [kpis, previous, series, byPackage, byArea, byMethod, ageing, balances, payments] = await Promise.all([
    revenueKpis(db, tenantId, range.from, range.to, area),
    revenueKpis(db, tenantId, prev.from, prev.to, area),
    revenueSeries(db, tenantId, range.from, range.to, grain, area),
    revenueBreakdown(db, tenantId, range.from, range.to, "package", area),
    revenueBreakdown(db, tenantId, range.from, range.to, "area", area),
    revenueBreakdown(db, tenantId, range.from, range.to, "method", area),
    outstandingAgeing(db, tenantId, area),
    opts.canSeeCustomers ? topBalances(db, tenantId, area, 20) : Promise.resolve(null),
    withPayments && !area ? verifiedPayments(db, tenantId, kenyaLocalToIso(`${range.from}T00:00`)!, kenyaLocalToIso(`${nextDay}T00:00`)!) : Promise.resolve(null),
  ]);
  if (!kpis.ok) return kpis;
  if (!series.ok) return series;
  if (!byPackage.ok) return byPackage;
  if (!byArea.ok) return byArea;
  if (!byMethod.ok) return byMethod;
  if (!ageing.ok) return ageing;

  return {
    ok: true,
    data: {
      kind,
      title: TITLES[kind],
      tenantName: opts.tenantName,
      range,
      area,
      generatedAt: new Date().toISOString(),
      grain,
      kpis: kpis.data,
      previous: previous.ok ? previous.data : null,
      series: series.data,
      byPackage: byPackage.data,
      byArea: byArea.data,
      byMethod: byMethod.data,
      ageing: ageing.data,
      balances,
      payments,
    },
  };
}

/** Percentage change, or null when there is nothing to compare with. */
export function change(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function periodText(r: RevenueReport): string {
  return r.range.from === r.range.to ? formatDate(r.range.from) : `${formatDate(r.range.from)} to ${formatDate(r.range.to)}`;
}

const money = (n: number) => n.toFixed(2);

/** The summary lines shared by the CSV, the PDF and the page. */
export function summaryRows(r: RevenueReport): [string, string, string][] {
  const k = r.kpis;
  const rows: [string, string, string][] = [
    ["Collected (verified)", money(k.collected), `${k.collected_count} payments`],
    ["  M-Pesa", money(k.collected_mpesa), ""],
    ["  Bank transfer", money(k.collected_bank), ""],
    ["  Other digital", money(k.collected_other), ""],
    ["  Cash", "0.00", "Not accepted; all payments are digital"],
    ["Applied to invoices", money(k.recognised), ""],
    ["Credit not yet applied", money(k.unapplied_credit), "Overpayments and unlinked payments"],
    ["Paying customers", String(k.paying_customers), ""],
    ["Invoiced", money(k.invoiced), "Invoices issued in the period"],
    ["Awaiting verification", money(k.awaiting_verification), `${k.awaiting_verification_count} payments, not counted`],
    ["Reversed", money(k.reversed), `${k.reversed_count} payments`],
    ["Refunded", money(k.refunded), `${k.refunded_count} payments`],
    ["Simulated test payments excluded", money(k.simulated_excluded), `${k.simulated_excluded_count} payments`],
    ["Outstanding balances (now)", money(k.outstanding), `${k.outstanding_customers} customers`],
    ["  of which overdue", money(k.overdue), ""],
    ["New subscriptions", String(k.new_subscriptions), ""],
    ["Renewals", String(k.renewals), ""],
    ["Upgrades", String(k.upgrades), ""],
    ["Downgrades", String(k.downgrades), ""],
  ];
  if (r.previous) {
    const c = change(k.collected, r.previous.collected);
    rows.splice(1, 0, ["  Previous period", money(r.previous.collected), c === null ? "" : `${c > 0 ? "+" : ""}${c}% change`]);
  }
  return rows;
}

function seriesLabel(r: RevenueReport, bucket: string) {
  return r.grain === "day" ? bucket : bucket.slice(0, 7);
}

export function reportCsv(r: RevenueReport): string {
  const out: unknown[][] = [];
  const blank = () => out.push([]);
  out.push([`${r.tenantName}: ${r.title}`]);
  out.push(["Period", r.range.from, r.range.to]);
  out.push(["Area", r.area ?? "All areas"]);
  out.push(["Generated", r.generatedAt]);
  out.push(["Currency", "KES"]);
  out.push(["Note", "Collected means successful payments verified against a statement. Simulated test payments are never included."]);
  blank();
  out.push(["Summary", "Amount / count", "Notes"]);
  for (const row of summaryRows(r)) out.push([row[0].trim(), row[1], row[2]]);
  blank();
  out.push([r.grain === "day" ? "Day" : "Month", "Collected", "Payments", "Reversed"]);
  for (const p of r.series) out.push([seriesLabel(r, p.bucket), money(p.collected), p.payments, money(p.reversed)]);
  for (const [title, rows] of [["Package", r.byPackage], ["Area", r.byArea], ["Payment method", r.byMethod]] as const) {
    blank();
    out.push([title, "Collected", "Payments"]);
    for (const b of rows) out.push([title === "Payment method" ? PAYMENT_METHOD_LABELS[b.label] ?? b.label : b.label, money(b.amount), b.payments]);
  }
  blank();
  out.push(["Outstanding by age", "Amount", "Invoices", "Customers"]);
  for (const a of r.ageing) out.push([a.bucket, money(a.amount), a.invoices, a.customers]);
  if (r.balances) {
    blank();
    out.push(["Customer number", "Customer", "Area", "Outstanding", "Credit", "Last verified payment"]);
    for (const b of r.balances) out.push([b.customer_number, b.full_name, b.estate ?? b.town ?? "", money(b.outstanding), money(b.credit), b.last_payment_at ?? ""]);
  }
  if (r.payments) {
    blank();
    out.push(["Time", "Reference", "Method", "Customer number", "Customer", "Category", "Amount"]);
    for (const p of r.payments) {
      out.push([formatDateTime(p.transaction_at), p.provider_reference, PAYMENT_METHOD_LABELS[p.method] ?? p.method, p.customer_number, p.full_name ?? "Not linked", p.revenue_category, money(p.amount)]);
    }
  }
  return out.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function reportFileName(r: RevenueReport, ext: "csv" | "pdf"): string {
  const slug = r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const period = r.range.from === r.range.to ? r.range.from : r.kind === "monthly" ? r.range.from.slice(0, 7) : `${r.range.from}_to_${r.range.to}`;
  return `fibrepulse-${slug}-${period}.${ext}`;
}

/** Plain money text for the PDF (no currency symbol in columns). */
export const pdfMoney = (n: number) => formatKsh(n).replace("Ksh", "").trim();
