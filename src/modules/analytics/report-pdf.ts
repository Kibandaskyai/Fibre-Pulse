/**
 * PDF version of a financial report (A4, built server-side with pdf-lib).
 * Plain, printable layout: header, summary table, then the same tables as
 * the CSV. Uses the standard Helvetica font, so text is limited to the
 * Windows-1252 character set; anything else is replaced.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatDate, formatDateTime, PAYMENT_METHOD_LABELS } from "@/lib/format";
import { pdfMoney, periodText, summaryRows, type RevenueReport } from "./report";

export const A4: [number, number] = [595.28, 841.89];
export const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
export const MARGIN = 44;
export const INK = rgb(0.1, 0.12, 0.17);
export const MUTED = rgb(0.42, 0.46, 0.54);
const RULE = rgb(0.84, 0.86, 0.9);
export const ACCENT = rgb(0.13, 0.4, 0.78);

/** Keep text inside WinAnsi so the standard font can draw it. */
export function pdfSafe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ | /g, " ")
    .replace(/[^\x20-\x7E -ÿ–—•€]/g, "?");
}

export type Col = { header: string; width: number; align?: "left" | "right" };

/** Page-by-page writer shared by the financial and the BI report PDFs. */
export class Writer {
  doc: PDFDocument;
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  constructor(
    doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
    private footer: string,
    readonly size: [number, number] = A4,
  ) {
    this.doc = doc;
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage(this.size);
    this.pageNo += 1;
    this.y = this.size[1] - MARGIN;
    this.page.drawText(pdfSafe(`${this.footer} · page ${this.pageNo}`), { x: MARGIN, y: 24, size: 7.5, font: this.font, color: MUTED });
  }
  ensure(h: number) {
    if (this.y - h < MARGIN) this.newPage();
  }
  fit(text: string, size: number, width: number, font = this.font) {
    let t = pdfSafe(text);
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
    return `${t}...`;
  }
  text(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; gap?: number } = {}) {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.font;
    const words = pdfSafe(text).split(" ");
    const width = this.size[0] - MARGIN * 2;
    let line = "";
    const lines: string[] = [];
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      this.ensure(size + 4);
      this.y -= size + 3;
      this.page.drawText(l, { x: MARGIN, y: this.y, size, font, color: opts.color ?? INK });
    }
    this.y -= opts.gap ?? 4;
  }
  heading(text: string) {
    // Keep a heading with at least its table header and two rows.
    this.ensure(80);
    this.y -= 10;
    this.text(text, { size: 12, bold: true, gap: 6 });
  }
  table(cols: Col[], rows: string[][], opts: { emptyText?: string; boldRows?: Set<number> } = {}) {
    const size = 8.5;
    const rowH = 14;
    const drawHeader = () => {
      this.ensure(rowH * 2);
      let x = MARGIN;
      this.y -= rowH;
      for (const c of cols) {
        const t = this.fit(c.header, size, c.width - 6, this.bold);
        const tx = c.align === "right" ? x + c.width - this.bold.widthOfTextAtSize(t, size) - 3 : x + 3;
        this.page.drawText(t, { x: tx, y: this.y + 4, size, font: this.bold, color: MUTED });
        x += c.width;
      }
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + cols.reduce((s, c) => s + c.width, 0), y: this.y }, thickness: 0.8, color: RULE });
    };
    drawHeader();
    if (!rows.length) {
      this.y -= rowH;
      this.page.drawText(pdfSafe(opts.emptyText ?? "Nothing in this period."), { x: MARGIN + 3, y: this.y + 4, size, font: this.font, color: MUTED });
    }
    rows.forEach((row, i) => {
      if (this.y - rowH < MARGIN) {
        this.newPage();
        drawHeader();
      }
      this.y -= rowH;
      let x = MARGIN;
      const font = opts.boldRows?.has(i) ? this.bold : this.font;
      cols.forEach((c, ci) => {
        const t = this.fit(row[ci] ?? "", size, c.width - 6, font);
        const tx = c.align === "right" ? x + c.width - font.widthOfTextAtSize(t, size) - 3 : x + 3;
        this.page.drawText(t, { x: tx, y: this.y + 4, size, font, color: INK });
        x += c.width;
      });
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + cols.reduce((s, c) => s + c.width, 0), y: this.y }, thickness: 0.4, color: RULE });
    });
    this.y -= 6;
  }
}

export async function reportPdf(r: RevenueReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${r.tenantName} - ${r.title}`));
  doc.setAuthor("FibrePulse");
  doc.setCreator("FibrePulse");
  doc.setCreationDate(new Date(r.generatedAt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold, `${r.tenantName} · ${r.title} · ${periodText(r)} · generated ${formatDateTime(r.generatedAt)} (Kenyan time)`);

  w.text("FibrePulse", { size: 9, bold: true, color: ACCENT, gap: 2 });
  w.text(r.tenantName, { size: 18, bold: true, gap: 2 });
  w.text(`${r.title} · ${periodText(r)}${r.area ? ` · ${r.area}` : ""}`, { size: 11, gap: 4 });
  w.text(
    "Amounts in Kenya shillings. Collected means successful payments verified against an M-Pesa or bank statement. Payments awaiting verification are listed but not counted. Simulated test payments are never included.",
    { size: 8.5, color: MUTED, gap: 8 },
  );

  w.heading("Summary");
  const summary = summaryRows(r);
  const isCount = (label: string) => /customers|subscriptions|Renewals|Upgrades|Downgrades/.test(label) && !/Outstanding/.test(label);
  w.table(
    [
      { header: "Measure", width: 200 },
      { header: "KSh / count", width: 110, align: "right" },
      { header: "Notes", width: 197 },
    ],
    summary.map(([label, value, note]) => [label.replace(/^ {2}/, "    "), isCount(label) ? value : pdfMoney(Number(value)), note]),
    { boldRows: new Set([0]) },
  );

  w.heading(r.grain === "day" ? "Collections by day" : "Collections by month");
  w.table(
    [
      { header: r.grain === "day" ? "Day" : "Month", width: 167 },
      { header: "Collected", width: 120, align: "right" },
      { header: "Payments", width: 100, align: "right" },
      { header: "Reversed", width: 120, align: "right" },
    ],
    r.series.map((p) => [
      r.grain === "day" ? formatDate(p.bucket) : new Date(`${p.bucket}T00:00:00Z`).toLocaleDateString("en-KE", { month: "long", year: "numeric", timeZone: "UTC" }),
      pdfMoney(p.collected),
      String(p.payments),
      pdfMoney(p.reversed),
    ]),
  );

  for (const [title, rows] of [
    ["Collections by package", r.byPackage],
    ["Collections by area", r.byArea],
    ["Collections by payment method", r.byMethod],
  ] as const) {
    w.heading(title);
    const total = rows.reduce((s, b) => s + b.amount, 0);
    w.table(
      [
        { header: title.replace("Collections by ", "").replace(/^./, (c) => c.toUpperCase()), width: 267 },
        { header: "Collected", width: 120, align: "right" },
        { header: "Share", width: 60, align: "right" },
        { header: "Payments", width: 60, align: "right" },
      ],
      rows.map((b) => [
        title.endsWith("method") ? PAYMENT_METHOD_LABELS[b.label] ?? b.label : b.label,
        pdfMoney(b.amount),
        total ? `${Math.round((b.amount / total) * 100)}%` : "",
        String(b.payments),
      ]),
      { emptyText: "No verified collections in this period." },
    );
  }
  w.text("Cash: not accepted. All payments are digital (M-Pesa or bank).", { size: 8.5, color: MUTED });

  w.heading("Outstanding balances by age (today)");
  w.table(
    [
      { header: "Age", width: 207 },
      { header: "Amount", width: 120, align: "right" },
      { header: "Invoices", width: 90, align: "right" },
      { header: "Customers", width: 90, align: "right" },
    ],
    r.ageing.map((a) => [a.bucket, pdfMoney(a.amount), String(a.invoices), String(a.customers)]),
  );

  if (r.balances) {
    w.heading("Customers with the largest balances");
    w.table(
      [
        { header: "Number", width: 70 },
        { header: "Customer", width: 150 },
        { header: "Area", width: 107 },
        { header: "Outstanding", width: 90, align: "right" },
        { header: "Last paid", width: 90, align: "right" },
      ],
      r.balances.map((b) => [b.customer_number ?? "", b.full_name, b.estate ?? b.town ?? "", pdfMoney(b.outstanding), b.last_payment_at ? formatDate(b.last_payment_at) : "Never"]),
      { emptyText: "No customer owes anything." },
    );
  }

  if (r.payments) {
    w.heading("Verified payments");
    w.table(
      [
        { header: "Time", width: 95 },
        { header: "Reference", width: 95 },
        { header: "Method", width: 70 },
        { header: "Customer", width: 157 },
        { header: "Amount", width: 90, align: "right" },
      ],
      r.payments.map((p) => [
        formatDateTime(p.transaction_at),
        p.provider_reference ?? "",
        PAYMENT_METHOD_LABELS[p.method] ?? p.method,
        p.full_name ? `${p.full_name}${p.customer_number ? ` (${p.customer_number})` : ""}` : "Not linked",
        pdfMoney(p.amount),
      ]),
      { emptyText: "No verified payments on this day." },
    );
  }

  return doc.save();
}
