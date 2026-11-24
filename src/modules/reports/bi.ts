/**
 * Business intelligence reports (spec Module 12). Each report is loaded from
 * an aggregate database function (migration 20261127000100) that checks the
 * report permission itself, then shaped into one generic structure so the
 * page, the CSV and the PDF always show the same figures.
 *
 * Every report reads real records only. Simulated payments and customers are
 * left out; simulated routers are kept but labelled, because the network
 * pages show them that way too.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Permission } from "@/lib/auth/permissions";
import type { DateRange } from "@/lib/date-range";
import { formatDate, formatKsh, kenyaLocalToIso, PAYMENT_METHOD_LABELS } from "@/lib/format";
import { friendlyDbError } from "@/lib/validation/db-errors";
import { labelOf, JOB_TYPES, TICKET_CATEGORIES } from "@/lib/validation/operations";
import { csvCell } from "@/modules/customers/csv";
import { revenueBreakdown } from "@/modules/analytics/service";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export const BI_KEYS = ["customers", "subscriptions", "payments", "network", "support", "areas"] as const;
export type BiKey = (typeof BI_KEYS)[number];

export type BiDefinition = {
  key: BiKey;
  title: string;
  summary: string;
  /** All of these are needed to open the report. */
  permissions: Permission[];
  /** Whether the report takes an area filter. */
  area: boolean;
};

export const BI_REPORTS: BiDefinition[] = [
  {
    key: "customers",
    title: "Customer acquisition and churn",
    summary: "New customers, first connections, lapsed customers and churn rate by month.",
    permissions: ["reports:financial", "customers:view"],
    area: true,
  },
  {
    key: "subscriptions",
    title: "Subscription performance",
    summary: "Packages sold, renewed, upgraded and lapsed, with live subscriptions and collections per package.",
    permissions: ["reports:financial", "revenue:view"],
    area: true,
  },
  {
    key: "payments",
    title: "Payment reconciliation",
    summary: "Every payment in the period by method and where it stands: matched, verified only, awaiting, rejected or reversed.",
    permissions: ["reports:financial"],
    area: false,
  },
  {
    key: "network",
    title: "Network availability and router performance",
    summary: "Availability, load, peak sessions and alerts per router, from connector readings.",
    permissions: ["reports:network"],
    area: false,
  },
  {
    key: "support",
    title: "Support and field operations",
    summary: "Tickets and jobs opened and resolved, resolution times, and technician performance.",
    permissions: ["reports:support"],
    area: false,
  },
  {
    key: "areas",
    title: "Geographical performance",
    summary: "Customers, collections, balances, tickets and routers per area.",
    permissions: ["reports:financial", "revenue:view"],
    area: false,
  },
];

export function biDefinition(key: string | undefined): BiDefinition | undefined {
  return BI_REPORTS.find((r) => r.key === key);
}

export function canOpen(def: BiDefinition, perms: ReadonlySet<string>): boolean {
  return def.permissions.every((p) => perms.has(p));
}

export type BiColumn = { header: string; align?: "right"; /** relative PDF width */ weight?: number };
export type BiSection = { title: string; note?: string; columns: BiColumn[]; rows: string[][]; empty: string; totals?: string[] };
export type BiFigure = { label: string; value: string; hint?: string };
export type BiBar = { label: string; value: number; detail?: string };

export type BiReport = {
  key: BiKey;
  title: string;
  tenantName: string;
  range: DateRange;
  area: string | null;
  generatedAt: string;
  notes: string[];
  figures: BiFigure[];
  /** Optional bar list shown on screen (identity in text, never colour alone). */
  bars?: { title: string; format: "ksh" | "count"; rows: BiBar[]; empty: string };
  sections: BiSection[];
};

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const nOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const int = (v: unknown) => n(v).toLocaleString("en-KE");
const money = (v: unknown) => formatKsh(n(v)).replace("Ksh", "").trim();
const pct = (v: number | null) => (v === null ? "" : `${v.toLocaleString("en-KE", { maximumFractionDigits: 1 })}%`);
const hours = (v: number | null) => (v === null ? "" : v < 48 ? `${v.toLocaleString("en-KE", { maximumFractionDigits: 1 })} h` : `${(v / 24).toLocaleString("en-KE", { maximumFractionDigits: 1 })} days`);
const monthName = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-KE", { month: "long", year: "numeric", timeZone: "UTC" });
const area = (a?: string | null) => (a && a.trim() ? a.trim() : null);

type Opts = { tenantId: string; tenantName: string; range: DateRange; area?: string | null };

export async function loadBiReport(db: SupabaseClient, key: BiKey, opts: Opts): Promise<Result<BiReport>> {
  const base = {
    key,
    title: biDefinition(key)!.title,
    tenantName: opts.tenantName,
    range: opts.range,
    area: biDefinition(key)!.area ? area(opts.area) : null,
    generatedAt: new Date().toISOString(),
  };
  const args = { p_tenant: opts.tenantId, p_from: opts.range.from, p_to: opts.range.to };
  switch (key) {
    case "customers":
      return customersReport(db, base, { ...args, p_area: base.area });
    case "subscriptions":
      return subscriptionsReport(db, base, { ...args, p_area: base.area }, opts.tenantId);
    case "payments":
      return paymentsReport(db, base, args);
    case "network":
      return networkReport(db, base, opts);
    case "support":
      return supportReport(db, base, args);
    case "areas":
      return areasReport(db, base, args);
  }
}

type Base = Omit<BiReport, "notes" | "figures" | "sections" | "bars">;

async function rpc(db: SupabaseClient, fn: string, args: Record<string, unknown>, fallback: string): Promise<Result<Record<string, unknown>[]>> {
  const { data, error } = await db.rpc(fn, args);
  if (error) return { ok: false, message: friendlyDbError(error, fallback) };
  return { ok: true, data: (data ?? []) as Record<string, unknown>[] };
}

async function customersReport(db: SupabaseClient, base: Base, args: Record<string, unknown>): Promise<Result<BiReport>> {
  const res = await rpc(db, "bi_customer_report", args, "Could not load the customer report.");
  if (!res.ok) return res;
  const rows = res.data;
  const sum = (k: string) => rows.reduce((s, r) => s + n(r[k]), 0);
  const lapsed = sum("lapsed");
  const atStart = rows.reduce((s, r) => s + n(r.active_at_start), 0);
  return {
    ok: true,
    data: {
      ...base,
      notes: [
        "Churn is customers whose last package ended in the month without a renewal since, divided by customers with a live package on the first day of the month.",
        "Simulated test customers are not counted.",
      ],
      figures: [
        { label: "New customers", value: int(sum("new_customers")), hint: "Registered in the period" },
        { label: "First connections", value: int(sum("first_subscriptions")), hint: "First package started" },
        { label: "Lapsed", value: int(lapsed), hint: "Package ended, not renewed" },
        { label: "Disconnected or terminated", value: int(sum("terminated")) },
        { label: "Average monthly churn", value: atStart ? pct(Math.round((lapsed * 1000) / atStart) / 10) : "No base yet", hint: atStart ? undefined : "Needs customers live at a month start" },
      ],
      bars: {
        title: "New customers by month",
        format: "count",
        rows: rows.map((r) => ({ label: monthName(String(r.month)), value: n(r.new_customers) })),
        empty: "No new customers in this period.",
      },
      sections: [
        {
          title: "By month",
          columns: [
            { header: "Month", weight: 2 },
            { header: "New customers", align: "right" },
            { header: "First connections", align: "right" },
            { header: "Live at start", align: "right" },
            { header: "Lapsed", align: "right" },
            { header: "Disconnected", align: "right" },
            { header: "Churn", align: "right" },
          ],
          rows: rows.map((r) => [monthName(String(r.month)), int(r.new_customers), int(r.first_subscriptions), int(r.active_at_start), int(r.lapsed), int(r.terminated), pct(nOrNull(r.churn_pct))]),
          totals: ["Total", int(sum("new_customers")), int(sum("first_subscriptions")), "", int(lapsed), int(sum("terminated")), ""],
          empty: "No customer activity in this period.",
        },
      ],
    },
  };
}

async function subscriptionsReport(db: SupabaseClient, base: Base, args: Record<string, unknown>, tenantId: string): Promise<Result<BiReport>> {
  const [res, collected] = await Promise.all([
    rpc(db, "bi_subscription_report", args, "Could not load the subscription report."),
    revenueBreakdown(db, tenantId, base.range.from, base.range.to, "package", base.area),
  ]);
  if (!res.ok) return res;
  if (!collected.ok) return collected;
  const byPackage = new Map(collected.data.map((b) => [b.label, b.amount]));
  const rows = res.data;
  const sum = (k: string) => rows.reduce((s, r) => s + n(r[k]), 0);
  const sold = sum("sold_new") + sum("renewals") + sum("upgrades") + sum("downgrades");
  const others = collected.data.filter((b) => !rows.some((r) => r.package === b.label));
  return {
    ok: true,
    data: {
      ...base,
      notes: [
        "Sold counts packages created in the period. Sales value is the package price at the time of sale; collected is verified money applied to that package's invoices.",
        "Upgrades and downgrades give no credit for unused days.",
      ],
      figures: [
        { label: "Packages sold", value: int(sold), hint: `${int(sum("sold_new"))} new · ${int(sum("renewals"))} renewals` },
        { label: "Upgrades / downgrades", value: `${int(sum("upgrades"))} / ${int(sum("downgrades"))}` },
        { label: "Live now", value: int(sum("active_now")), hint: `${int(sum("suspended_now"))} suspended` },
        { label: "Lapsed in period", value: int(sum("lapsed")) },
        { label: "Sales value", value: formatKsh(sum("sales_value")) },
      ],
      bars: {
        title: "Collected by package",
        format: "ksh",
        rows: collected.data.map((b) => ({ label: b.label, value: b.amount, detail: `${b.payments} payments` })),
        empty: "No verified collections in this period.",
      },
      sections: [
        {
          title: "By package",
          columns: [
            { header: "Package", weight: 2 },
            { header: "Price", align: "right" },
            { header: "Live", align: "right" },
            { header: "Suspended", align: "right" },
            { header: "New", align: "right" },
            { header: "Renewals", align: "right" },
            { header: "Up", align: "right" },
            { header: "Down", align: "right" },
            { header: "Lapsed", align: "right" },
            { header: "Sales value", align: "right", weight: 1.5 },
            { header: "Collected", align: "right", weight: 1.5 },
          ],
          rows: [
            ...rows.map((r) => [
              String(r.package),
              money(r.price),
              int(r.active_now),
              int(r.suspended_now),
              int(r.sold_new),
              int(r.renewals),
              int(r.upgrades),
              int(r.downgrades),
              int(r.lapsed),
              money(r.sales_value),
              money(byPackage.get(String(r.package)) ?? 0),
            ]),
            ...others.map((b) => [b.label, "", "", "", "", "", "", "", "", "", money(b.amount)]),
          ],
          totals: ["Total", "", int(sum("active_now")), int(sum("suspended_now")), int(sum("sold_new")), int(sum("renewals")), int(sum("upgrades")), int(sum("downgrades")), int(sum("lapsed")), money(sum("sales_value")), money(collected.data.reduce((s, b) => s + b.amount, 0))],
          empty: "No packages set up yet.",
        },
      ],
    },
  };
}

const STATE_ORDER = [
  "Verified and matched to a statement",
  "Verified, not yet on a statement",
  "Verified, statement mismatch or dispute",
  "Awaiting verification",
  "Pending at provider",
  "Rejected at verification",
  "Failed or cancelled",
  "Reversed or refunded",
];

async function paymentsReport(db: SupabaseClient, base: Base, args: Record<string, unknown>): Promise<Result<BiReport>> {
  const res = await rpc(db, "bi_payment_report", args, "Could not load the reconciliation report.");
  if (!res.ok) return res;
  const rows = [...res.data].sort((a, b) => STATE_ORDER.indexOf(String(a.state)) - STATE_ORDER.indexOf(String(b.state)) || String(a.method).localeCompare(String(b.method)));
  const total = (pred: (s: string) => boolean, k = "amount") => rows.filter((r) => pred(String(r.state))).reduce((s, r) => s + n(r[k]), 0);
  const verified = (s: string) => s.startsWith("Verified");
  const byState = new Map<string, { amount: number; payments: number }>();
  for (const r of rows) {
    const cur = byState.get(String(r.state)) ?? { amount: 0, payments: 0 };
    byState.set(String(r.state), { amount: cur.amount + n(r.amount), payments: cur.payments + n(r.payments) });
  }
  return {
    ok: true,
    data: {
      ...base,
      notes: [
        "Every payment recorded in the period, by transaction date. Only verified payments count as collected revenue.",
        "Unallocated is verified money not yet applied to an invoice (customer credit). Cash is not accepted. Simulated test payments are left out.",
      ],
      figures: [
        { label: "Verified", value: formatKsh(total(verified)), hint: `${int(total(verified, "payments"))} payments` },
        { label: "Matched to a statement", value: formatKsh(total((s) => s === STATE_ORDER[0])) },
        { label: "Awaiting verification", value: formatKsh(total((s) => s === "Awaiting verification")), hint: `${int(total((s) => s === "Awaiting verification", "payments"))} payments, not counted` },
        { label: "Rejected, failed or reversed", value: formatKsh(total((s) => /Rejected|Failed|Reversed/.test(s))) },
        { label: "Verified but unallocated", value: formatKsh(total(verified, "unallocated")) },
      ],
      bars: {
        title: "Amount by status",
        format: "ksh",
        rows: STATE_ORDER.filter((s) => byState.has(s)).map((s) => ({ label: s, value: byState.get(s)!.amount, detail: `${byState.get(s)!.payments} payments` })),
        empty: "No payments recorded in this period.",
      },
      sections: [
        {
          title: "By method and status",
          columns: [
            { header: "Method", weight: 1.2 },
            { header: "Status", weight: 3 },
            { header: "Payments", align: "right" },
            { header: "Amount", align: "right", weight: 1.4 },
            { header: "Unallocated", align: "right", weight: 1.4 },
          ],
          rows: rows.map((r) => [PAYMENT_METHOD_LABELS[String(r.method)] ?? String(r.method), String(r.state), int(r.payments), money(r.amount), verified(String(r.state)) ? money(r.unallocated) : ""]),
          totals: ["All", "", int(rows.reduce((s, r) => s + n(r.payments), 0)), money(rows.reduce((s, r) => s + n(r.amount), 0)), money(total(verified, "unallocated"))],
          empty: "No payments recorded in this period.",
        },
      ],
    },
  };
}

/** Network readings are timestamps, so a Kenyan day range becomes [from 00:00, day after to 00:00). */
export function rangeInstants(range: DateRange): { from: string; to: string } {
  const next = new Date(Date.parse(`${range.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { from: kenyaLocalToIso(`${range.from}T00:00`)!, to: kenyaLocalToIso(`${next}T00:00`)! };
}

async function networkReport(db: SupabaseClient, base: Base, opts: Opts): Promise<Result<BiReport>> {
  const { from, to } = rangeInstants(opts.range);
  const res = await rpc(db, "router_report", { p_tenant: opts.tenantId, p_from: from, p_to: to }, "Could not load the network report.");
  if (!res.ok) return res;
  const rows = res.data;
  const measured = rows.filter((r) => n(r.samples) > 0);
  const real = measured.filter((r) => r.data_source !== "simulated");
  const avail = (list: typeof rows) => {
    const samples = list.reduce((s, r) => s + n(r.samples), 0);
    return samples ? Math.round((list.reduce((s, r) => s + n(r.availability_pct) * n(r.samples), 0) / samples) * 100) / 100 : null;
  };
  const anySimulated = rows.some((r) => r.data_source === "simulated");
  return {
    ok: true,
    data: {
      ...base,
      notes: [
        "Availability is the share of connector polls in which the router answered. Routers with no readings in the period show no figure rather than a guess.",
        ...(anySimulated ? ["Routers marked SIMULATED are fed by the demo connector, not real equipment, and are left out of the headline availability."] : []),
      ],
      figures: [
        { label: "Availability (real routers)", value: avail(real) === null ? "No readings" : pct(avail(real)), hint: `${real.length} routers measured` },
        { label: "Routers", value: int(rows.length), hint: `${rows.filter((r) => r.status === "offline").length} offline now` },
        { label: "Offline alerts", value: int(rows.reduce((s, r) => s + n(r.offline_alerts), 0)) },
        { label: "Warnings", value: int(rows.reduce((s, r) => s + n(r.warnings), 0)) },
      ],
      sections: [
        {
          title: "By router",
          columns: [
            { header: "Router", weight: 3 },
            { header: "Now", weight: 1 },
            { header: "Availability", align: "right", weight: 1.2 },
            { header: "Polls", align: "right" },
            { header: "CPU avg / max", align: "right", weight: 1.4 },
            { header: "Memory avg / max", align: "right", weight: 1.5 },
            { header: "Peak sessions", align: "right", weight: 1.2 },
            { header: "Offline alerts", align: "right", weight: 1.2 },
          ],
          rows: rows.map((r) => [
            `${String(r.name)}${r.data_source === "simulated" && !/simulated/i.test(String(r.name)) ? " (SIMULATED)" : ""}`,
            { online: "Online", offline: "Offline" }[String(r.status)] ?? "Unknown",
            n(r.samples) ? pct(nOrNull(r.availability_pct)) : "No readings",
            int(r.samples),
            r.avg_cpu === null ? "" : `${n(r.avg_cpu)}% / ${n(r.max_cpu)}%`,
            r.avg_memory === null ? "" : `${n(r.avg_memory)}% / ${n(r.max_memory)}%`,
            r.peak_sessions === null ? "" : int(r.peak_sessions),
            int(r.offline_alerts),
          ]),
          empty: "No routers added yet.",
        },
      ],
    },
  };
}

async function supportReport(db: SupabaseClient, base: Base, args: Record<string, unknown>): Promise<Result<BiReport>> {
  const res = await rpc(db, "bi_support_report", args, "Could not load the support report.");
  if (!res.ok) return res;
  const of = (kind: string) => res.data.filter((r) => r.kind === kind);
  const tickets = of("ticket");
  const jobs = of("job");
  const techs = of("technician");
  const sum = (list: Record<string, unknown>[], k: string) => list.reduce((s, r) => s + n(r[k]), 0);
  const wavg = (list: Record<string, unknown>[]) => {
    const done = sum(list, "resolved");
    return done ? Math.round((list.reduce((s, r) => s + n(r.avg_hours) * n(r.resolved), 0) / done) * 10) / 10 : null;
  };
  const cols = (first: string): BiColumn[] => [
    { header: first, weight: 2.4 },
    { header: "Opened", align: "right" },
    { header: first === "Technician" ? "Completed" : "Resolved", align: "right" },
    { header: "Open now", align: "right" },
    { header: "Average time", align: "right", weight: 1.3 },
    { header: "Median time", align: "right", weight: 1.3 },
    { header: "Within 24 h", align: "right" },
  ];
  const line = (label: string) => (r: Record<string, unknown>) => [label, int(r.opened), int(r.resolved), int(r.open_now), hours(nOrNull(r.avg_hours)), hours(nOrNull(r.median_hours)), pct(nOrNull(r.within_24h_pct))];
  return {
    ok: true,
    data: {
      ...base,
      notes: ["Times run from when a ticket or job was opened to when it was resolved or completed. Open now counts everything still open, whenever it was opened."],
      figures: [
        { label: "Tickets opened", value: int(sum(tickets, "opened")), hint: `${int(sum(tickets, "open_now"))} open now` },
        { label: "Tickets resolved", value: int(sum(tickets, "resolved")), hint: wavg(tickets) === null ? undefined : `${hours(wavg(tickets))} on average` },
        { label: "Jobs completed", value: int(sum(jobs, "resolved")), hint: `${int(sum(jobs, "open_now"))} still open` },
        { label: "Average job time", value: wavg(jobs) === null ? "None completed" : hours(wavg(jobs)) },
      ],
      bars: {
        title: "Tickets opened by category",
        format: "count",
        rows: tickets.map((r) => ({ label: labelOf(TICKET_CATEGORIES, String(r.label)), value: n(r.opened) })),
        empty: "No tickets opened in this period.",
      },
      sections: [
        { title: "Tickets by category", columns: cols("Category"), rows: tickets.map((r) => line(labelOf(TICKET_CATEGORIES, String(r.label)))(r)), empty: "No support tickets yet." },
        { title: "Jobs by type", columns: cols("Job type"), rows: jobs.map((r) => line(labelOf(JOB_TYPES, String(r.label)))(r)), empty: "No field jobs yet." },
        { title: "Technician performance", columns: cols("Technician"), rows: techs.map((r) => line(String(r.label))(r)), empty: "No jobs assigned to technicians yet." },
      ],
    },
  };
}

async function areasReport(db: SupabaseClient, base: Base, args: Record<string, unknown>): Promise<Result<BiReport>> {
  const res = await rpc(db, "bi_area_report", args, "Could not load the area report.");
  if (!res.ok) return res;
  const rows = res.data;
  const sum = (k: string) => rows.reduce((s, r) => s + n(r[k]), 0);
  return {
    ok: true,
    data: {
      ...base,
      notes: [
        "Area is the customer's estate, or town, or county when no estate is recorded. Collected is verified money in the period; outstanding and open tickets are as of now.",
        "A router counts in every area it serves customers in. No exact customer locations are shown.",
      ],
      figures: [
        { label: "Areas", value: int(rows.length) },
        { label: "Customers", value: int(sum("customers")), hint: `${int(sum("new_customers"))} new in the period` },
        { label: "Collected", value: formatKsh(sum("collected")) },
        { label: "Outstanding now", value: formatKsh(sum("outstanding")) },
      ],
      bars: {
        title: "Collected by area",
        format: "ksh",
        rows: rows.filter((r) => n(r.collected) > 0).map((r) => ({ label: String(r.area), value: n(r.collected) })),
        empty: "No verified collections in this period.",
      },
      sections: [
        {
          title: "By area",
          columns: [
            { header: "Area", weight: 2.2 },
            { header: "Customers", align: "right" },
            { header: "New", align: "right", weight: 0.8 },
            { header: "Live packages", align: "right", weight: 1.1 },
            { header: "Collected", align: "right", weight: 1.4 },
            { header: "Outstanding", align: "right", weight: 1.4 },
            { header: "Tickets", align: "right", weight: 0.9 },
            { header: "Open tickets", align: "right", weight: 1.1 },
            { header: "Routers (offline)", align: "right", weight: 1.3 },
          ],
          rows: rows.map((r) => [
            String(r.area),
            int(r.customers),
            int(r.new_customers),
            int(r.active_subscriptions),
            money(r.collected),
            money(r.outstanding),
            int(r.tickets_opened),
            int(r.open_tickets),
            n(r.routers) ? `${int(r.routers)} (${int(r.routers_offline)})` : "0",
          ]),
          totals: ["All areas", int(sum("customers")), int(sum("new_customers")), int(sum("active_subscriptions")), money(sum("collected")), money(sum("outstanding")), int(sum("tickets_opened")), int(sum("open_tickets")), ""],
          empty: "No customers yet.",
        },
      ],
    },
  };
}

export function biPeriodText(r: Pick<BiReport, "range">): string {
  return r.range.from === r.range.to ? formatDate(r.range.from) : `${formatDate(r.range.from)} to ${formatDate(r.range.to)}`;
}

export function biCsv(r: BiReport): string {
  const out: unknown[][] = [];
  out.push([`${r.tenantName}: ${r.title}`]);
  out.push(["Period", r.range.from, r.range.to]);
  if (biDefinition(r.key)?.area) out.push(["Area", r.area ?? "All areas"]);
  out.push(["Generated", r.generatedAt]);
  out.push(["Currency", "KES"]);
  for (const note of r.notes) out.push(["Note", note]);
  out.push([]);
  out.push(["Summary", "Value", "Notes"]);
  for (const f of r.figures) out.push([f.label, f.value, f.hint ?? ""]);
  for (const s of r.sections) {
    out.push([]);
    out.push([s.title]);
    out.push(s.columns.map((c) => c.header));
    if (!s.rows.length) out.push([s.empty]);
    for (const row of s.rows) out.push(row);
    if (s.totals && s.rows.length) out.push(s.totals);
  }
  // Plain numbers in money columns: drop thousands separators so spreadsheets read them.
  const clean = (v: unknown) => (typeof v === "string" && /^-?[\d,]+(\.\d+)?$/.test(v) ? v.replace(/,/g, "") : v);
  return out.map((row) => row.map((v) => csvCell(clean(v))).join(",")).join("\r\n") + "\r\n";
}

export function biFileName(r: BiReport, ext: "csv" | "pdf"): string {
  const period = r.range.from === r.range.to ? r.range.from : `${r.range.from}_to_${r.range.to}`;
  return `fibrepulse-${r.key}-report-${period}.${ext}`;
}
