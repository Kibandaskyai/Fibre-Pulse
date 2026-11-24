import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { BI_REPORTS, biCsv, biFileName, canOpen, rangeInstants, type BiReport } from "@/modules/reports/bi";
import { biPdf } from "@/modules/reports/bi-pdf";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";

const report: BiReport = {
  key: "areas",
  title: "Geographical performance",
  tenantName: "Mwangaza Fibre Networks",
  range: { key: "custom", from: "2026-11-01", to: "2026-11-24", label: "Custom dates" },
  area: null,
  generatedAt: "2026-11-24T06:00:00.000Z",
  notes: ["Fictional test data."],
  figures: [{ label: "Collected", value: "Ksh 12,500.00" }],
  sections: [
    {
      title: "By area",
      columns: [{ header: "Area" }, { header: "Collected", align: "right" }, ...Array.from({ length: 7 }, (_, i) => ({ header: `C${i}`, align: "right" as const }))],
      rows: [["=Roysambu", "12,500.00", "1", "2", "3", "4", "5", "6", "7"]],
      totals: ["All areas", "12,500.00", "", "", "", "", "", "", ""],
      empty: "No customers yet.",
    },
  ],
};

describe("BI reports", () => {
  it("CSV keeps numbers plain and neutralises formula-like text", () => {
    const csv = biCsv(report);
    expect(csv).toContain(",12500.00,");
    expect(csv).not.toContain(',"12,500.00"');
    expect(csv).toMatch(/'=Roysambu/);
    expect(csv).toContain("All areas,12500.00");
    expect(biFileName(report, "csv")).toBe("fibrepulse-areas-report-2026-11-01_to_2026-11-24.csv");
  });

  it("PDF renders, in landscape for wide tables", async () => {
    const bytes = await biPdf(report);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
  });

  it("roles see only the reports their permissions allow", () => {
    const keys = (role: keyof typeof ROLE_PERMISSIONS) => BI_REPORTS.filter((d) => canOpen(d, new Set(ROLE_PERMISSIONS[role]))).map((d) => d.key);
    expect(keys("owner")).toEqual(["customers", "subscriptions", "payments", "network", "support", "areas"]);
    expect(keys("support_agent")).toEqual(["support"]);
    expect(keys("network_admin")).toEqual(["network"]);
    expect(keys("technician")).toEqual([]);
    expect(keys("finance")).toContain("payments");
    expect(keys("finance")).not.toContain("support");
  });

  it("turns Kenyan days into instants for network readings", () => {
    expect(rangeInstants({ key: "custom", from: "2026-11-01", to: "2026-11-01", label: "" })).toEqual({
      from: "2026-10-31T21:00:00.000Z",
      to: "2026-11-01T21:00:00.000Z",
    });
  });
});
