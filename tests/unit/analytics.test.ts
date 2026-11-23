import { describe, expect, it } from "vitest";
import { grainFor, last12Months, previousPeriod, resolveRange } from "@/lib/date-range";
import { change } from "@/modules/analytics/report";
import { pdfSafe } from "@/modules/analytics/report-pdf";
import { parseAmount, parseStatement, parseStatementDate } from "@/modules/reconciliation/statement";

// 23 Nov 2026 22:30 UTC is already 24 Nov in Kenya.
const LATE_EVENING = new Date("2026-11-23T22:30:00Z");
const NOON = new Date("2026-11-23T09:00:00Z");

describe("resolveRange", () => {
  it("resolves presets in Kenyan days", () => {
    expect(resolveRange({ range: "today" }, "30d", LATE_EVENING)).toMatchObject({ from: "2026-11-24", to: "2026-11-24" });
    expect(resolveRange({ range: "7d" }, "30d", NOON)).toMatchObject({ from: "2026-11-17", to: "2026-11-23" });
    expect(resolveRange({}, "30d", NOON)).toMatchObject({ key: "30d", from: "2026-10-25", to: "2026-11-23" });
    expect(resolveRange({ range: "this_month" }, "30d", NOON)).toMatchObject({ from: "2026-11-01", to: "2026-11-23" });
    expect(resolveRange({ range: "last_month" }, "30d", NOON)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolveRange({ range: "this_year" }, "30d", NOON)).toMatchObject({ from: "2026-01-01", to: "2026-11-23" });
  });

  it("handles last month across a year boundary", () => {
    expect(resolveRange({ range: "last_month" }, "30d", new Date("2027-01-10T09:00:00Z"))).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("treats edited dates as a custom range", () => {
    const r = resolveRange({ range: "30d", from: "2026-09-01", to: "2026-09-30" }, "30d", NOON);
    expect(r).toMatchObject({ key: "custom", from: "2026-09-01", to: "2026-09-30" });
  });

  it("keeps the preset when the dates sent are the preset's own", () => {
    expect(resolveRange({ range: "7d", from: "2026-11-17", to: "2026-11-23" }, "30d", NOON).key).toBe("7d");
  });

  it("falls back on invalid or reversed custom dates", () => {
    expect(resolveRange({ range: "custom", from: "2026-02-30", to: "2026-03-01" }, "30d", NOON).key).toBe("30d");
    expect(resolveRange({ range: "custom", from: "2026-10-10", to: "2026-10-01" }, "30d", NOON).key).toBe("30d");
    expect(resolveRange({ range: "custom", from: "x", to: "y" }, "this_month", NOON).key).toBe("this_month");
    expect(resolveRange({ range: "bogus" }, "7d", NOON).key).toBe("7d");
  });

  it("picks day or month buckets and the previous period", () => {
    expect(grainFor(resolveRange({ range: "90d" }, "30d", NOON))).toBe("day");
    expect(grainFor(resolveRange({ range: "this_year" }, "30d", NOON))).toBe("month");
    expect(previousPeriod({ key: "custom", from: "2026-11-01", to: "2026-11-10", label: "" })).toEqual({ from: "2026-10-22", to: "2026-10-31" });
    expect(last12Months(NOON)).toEqual({ from: "2025-12-01", to: "2026-11-23" });
  });
});

describe("statement values", () => {
  it("parses amounts", () => {
    expect(parseAmount("2,000.00")).toBe(2000);
    expect(parseAmount("KES 1,500.50")).toBe(1500.5);
    expect(parseAmount("(150.00)")).toBe(-150);
    expect(parseAmount("-75")).toBe(-75);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("-")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });

  it("parses dates day first", () => {
    expect(parseStatementDate("2026-10-03 09:15:22")).toBe("2026-10-03");
    expect(parseStatementDate("03/10/2026")).toBe("2026-10-03");
    expect(parseStatementDate("3-10-26 14:00")).toBe("2026-10-03");
    expect(parseStatementDate("03 Oct 2026")).toBe("2026-10-03");
    expect(parseStatementDate("3-Oct-2026")).toBe("2026-10-03");
    expect(parseStatementDate("31/02/2026")).toBeNull();
    expect(parseStatementDate("")).toBeNull();
  });
});

describe("parseStatement", () => {
  it("reads an M-Pesa paybill statement with account details above the header", () => {
    const csv = [
      "Mwangaza Fibre Networks,,,,,,",
      "Paybill 123456,,,,,,",
      "",
      "Receipt No.,Completion Time,Initiation Time,Details,Transaction Status,Paid In,Withdrawn,Balance",
      "skq1abc234,2026-10-03 09:15:22,2026-10-03 09:15:20,Pay Bill from 2547****678 - Grace W Acc. GW001,Completed,\"2,000.00\",,\"12,000.00\"",
      "SKQ2DEF567,2026-10-03 10:00:00,2026-10-03 10:00:00,Business charge,Completed,,30.00,\"11,970.00\"",
      "SKQ3GHI890,2026-10-04 11:00:00,2026-10-04 11:00:00,Pay Bill from 2547****111,Failed,\"1,500.00\",,",
      "SKQ4JKL123,04/10/2026 12:00,,Pay Bill from 2547****222,Completed,1500,,",
    ].join("\r\n");
    const r = parseStatement(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("mpesa_statement");
    expect(r.columns).toMatchObject({ reference: "Receipt No.", amount: "Paid In", date: "Completion Time", details: "Details" });
    expect(r.lines).toEqual([
      { line: 5, reference: "SKQ1ABC234", amount: 2000, date: "2026-10-03", details: "Pay Bill from 2547****678 - Grace W Acc. GW001" },
      { line: 8, reference: "SKQ4JKL123", amount: 1500, date: "2026-10-04", details: "Pay Bill from 2547****222" },
    ]);
    expect(r.skipped).toEqual([
      { line: 6, reason: "Not money received." },
      { line: 7, reason: 'Status is "Failed".' },
    ]);
  });

  it("reads a bank statement with credit and debit columns", () => {
    const csv = "Transaction Date,Value Date,Narration,Reference,Debit,Credit,Balance\n03/10/2026,03/10/2026,RTGS from Ruiru Shop,FT26276ABC,,\"3,000.00\",9000\n04/10/2026,04/10/2026,Charges,FT26277XYZ,50.00,,8950\n";
    const r = parseStatement(csv);
    expect(r.ok && r.source).toBe("bank_statement");
    expect(r.ok && r.lines).toEqual([{ line: 2, reference: "FT26276ABC", amount: 3000, date: "2026-10-03", details: "RTGS from Ruiru Shop" }]);
  });

  it("reads a signed single amount column and keeps only money in", () => {
    const csv = "Date,Description,Ref No.,Amount\n2026-10-05,Deposit,DEP001,1200\n2026-10-06,Fee,FEE001,-40\n";
    const r = parseStatement(csv);
    expect(r.ok && r.lines.map((l) => l.reference)).toEqual(["DEP001"]);
  });

  it("explains files it cannot read", () => {
    expect(parseStatement("name,phone\nGrace,0711\n")).toMatchObject({ ok: false });
    expect(parseStatement("Receipt No.,Paid In\nX1,\n")).toMatchObject({ ok: false, message: "No money-in lines were found in the file." });
  });
});

describe("report helpers", () => {
  it("computes change only when there is something to compare", () => {
    expect(change(1500, 1000)).toBe(50);
    expect(change(500, 1000)).toBe(-50);
    expect(change(100, 0)).toBeNull();
    expect(change(100, null)).toBeNull();
  });

  it("keeps PDF text inside the standard font's characters", () => {
    expect(pdfSafe("Murang\u2019a \u00B7 Ksh\u00A02,000 \u2014 ok")).toBe("Murang'a \u00B7 Ksh 2,000 \u2014 ok");
    expect(pdfSafe("Wi-Fi \u{1F4F6}")).toBe("Wi-Fi ??");
  });
});
