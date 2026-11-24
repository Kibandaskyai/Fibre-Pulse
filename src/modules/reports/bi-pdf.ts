/**
 * PDF version of a BI report, using the same writer as the financial
 * reports. Wide reports (more than seven columns) print in landscape.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { formatDateTime } from "@/lib/format";
import { A4, A4_LANDSCAPE, ACCENT, MARGIN, MUTED, Writer, pdfSafe, type Col } from "@/modules/analytics/report-pdf";
import { biDefinition, biPeriodText, type BiReport } from "./bi";

export async function biPdf(r: BiReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${r.tenantName} - ${r.title}`));
  doc.setAuthor("FibrePulse");
  doc.setCreator("FibrePulse");
  doc.setCreationDate(new Date(r.generatedAt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const wide = r.sections.some((s) => s.columns.length > 7);
  const size = wide ? A4_LANDSCAPE : A4;
  const w = new Writer(doc, font, bold, `${r.tenantName} · ${r.title} · ${biPeriodText(r)} · generated ${formatDateTime(r.generatedAt)} (Kenyan time)`, size);
  const usable = size[0] - MARGIN * 2;

  w.text("FibrePulse", { size: 9, bold: true, color: ACCENT, gap: 2 });
  w.text(r.tenantName, { size: 18, bold: true, gap: 2 });
  w.text(`${r.title} · ${biPeriodText(r)}${biDefinition(r.key)?.area ? ` · ${r.area ?? "All areas"}` : ""}`, { size: 11, gap: 4 });
  for (const note of r.notes) w.text(note, { size: 8.5, color: MUTED, gap: 3 });

  w.heading("Summary");
  w.table(
    [
      { header: "Measure", width: usable * 0.4 },
      { header: "Value", width: usable * 0.25, align: "right" },
      { header: "Notes", width: usable * 0.35 },
    ],
    r.figures.map((f) => [f.label, f.value, f.hint ?? ""]),
  );

  for (const s of r.sections) {
    w.heading(s.title);
    const totalWeight = s.columns.reduce((t, c) => t + (c.weight ?? 1), 0);
    const cols: Col[] = s.columns.map((c) => ({ header: c.header, align: c.align, width: (usable * (c.weight ?? 1)) / totalWeight }));
    const rows = s.totals && s.rows.length ? [...s.rows, s.totals] : s.rows;
    w.table(cols, rows, { emptyText: s.empty, boldRows: s.totals && s.rows.length ? new Set([s.rows.length]) : undefined });
    if (s.note) w.text(s.note, { size: 8.5, color: MUTED });
  }
  return doc.save();
}
