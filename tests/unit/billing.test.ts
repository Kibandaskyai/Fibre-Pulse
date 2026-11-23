import { describe, expect, it } from "vitest";
import { formatKsh, kenyaLocalToIso, kenyaToday } from "@/lib/format";
import { customerSchema, packageSchema, recordPaymentSchema } from "@/lib/validation/billing";
import { buildImportReport, csvCell, parseCsv, toCsv } from "@/modules/customers/csv";
import { safeSearchTerm } from "@/modules/customers/service";

describe("CSV parsing", () => {
  it("handles quotes, escaped quotes, commas and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
  });
  it("strips a UTF-8 BOM from Excel exports", () => {
    expect(parseCsv("﻿full_name,phone\nA,1")[0]).toEqual(["full_name", "phone"]);
  });
});

describe("customer import report", () => {
  const existing = { phones: new Set(["+254700000001"]), pppoe: new Set(["taken.user"]) };

  it("needs full_name and phone columns and rejects unknown ones", () => {
    expect(buildImportReport("name,phone\nA,0712345678", existing).fatal).toMatch(/full_name/);
    expect(buildImportReport("full_name,phone,gps\nA,0712345678,1", existing).fatal).toMatch(/Unknown column/);
  });

  it("normalises phones, maps statuses and flags every kind of duplicate", () => {
    const csv = [
      "Full Name,Phone,County,Status,pppoe_username",
      "Jane Wanjiku,0712 345 678,nairobi county,Active,jane.w",
      "Duplicate In File,+254712345678,,,",
      "Existing Phone,0700000001,,,",
      "Taken Pppoe,0722000000,,,TAKEN.USER",
      "Bad,12345,,,",
      "Pending Person,0733000000,Murang'a,pending,",
    ].join("\n");
    const r = buildImportReport(csv, existing);
    expect(r.fatal).toBeNull();
    expect(r.valid).toBe(2);
    expect(r.invalid).toBe(4);
    const first = r.rows[0];
    expect(first.ok && first.data).toMatchObject({ phone: "+254712345678", county: "Nairobi", status: "active", pppoeUsername: "jane.w" });
    const messages = r.rows.flatMap((row) => (row.ok ? [] : row.errors)).join(" | ");
    expect(messages).toContain("repeated (first on line 2)");
    expect(messages).toContain("already belongs to an existing customer");
    expect(messages).toContain("PPPoE username TAKEN.USER is already in use");
    expect(messages).toContain("Kenyan mobile number");
    const last = r.rows[5];
    expect(last.ok && last.data.status).toBe("pending_installation");
  });
});

describe("CSV export safety", () => {
  it("neutralises spreadsheet formulas but keeps phone numbers and amounts", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("+254712345678")).toBe("+254712345678");
    expect(csvCell("-100.50")).toBe("-100.50");
    expect(csvCell(null)).toBe("");
    expect(toCsv(["a"], [["x,y"]])).toBe('a\r\n"x,y"\r\n');
  });
});

describe("billing validation", () => {
  it("package periods set the right number of days", () => {
    const base = { name: "Home 10", downloadMbps: "10", uploadMbps: "5", price: "2,500" };
    expect(packageSchema.parse({ ...base, billingPeriod: "daily" }).durationDays).toBe(1);
    expect(packageSchema.parse({ ...base, billingPeriod: "weekly" }).durationDays).toBe(7);
    expect(packageSchema.parse({ ...base, billingPeriod: "monthly", durationDays: "9" }).durationDays).toBeNull();
    expect(packageSchema.parse({ ...base, billingPeriod: "custom", durationDays: "30" }).durationDays).toBe(30);
    expect(packageSchema.safeParse({ ...base, billingPeriod: "custom", durationDays: "" }).success).toBe(false);
    expect(packageSchema.parse({ ...base, billingPeriod: "monthly" }).price).toBe(2500);
    expect(packageSchema.safeParse({ ...base, price: "12.345", billingPeriod: "monthly" }).success).toBe(false);
  });

  it("customer GPS must be inside Kenya and come as a pair", () => {
    const base = { fullName: "Jane", phone: "0712345678" };
    expect(customerSchema.safeParse({ ...base, latitude: "-1.2", longitude: "36.8" }).success).toBe(true);
    expect(customerSchema.safeParse({ ...base, latitude: "51.5", longitude: "-0.1" }).success).toBe(false);
    expect(customerSchema.safeParse({ ...base, latitude: "-1.2", longitude: "" }).success).toBe(false);
  });

  it("payments: no cash, positive amounts, uppercase references", () => {
    const base = { method: "mpesa", reference: "skl4h7xy2q", amount: "1,500", transactionAt: "2026-11-23T10:00" };
    const ok = recordPaymentSchema.parse(base);
    expect(ok.reference).toBe("SKL4H7XY2Q");
    expect(ok.amount).toBe(1500);
    expect(recordPaymentSchema.safeParse({ ...base, method: "cash" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, amount: "0" }).success).toBe(false);
    expect(recordPaymentSchema.safeParse({ ...base, reference: "AB" }).success).toBe(false);
    expect(recordPaymentSchema.parse({ ...base, payerPhone: "0712 345 678" }).payerPhone).toBe("+254712345678");
  });
});

describe("formatting and search", () => {
  it("converts Kenyan local time to UTC", () => {
    expect(kenyaLocalToIso("2026-11-23T10:00")).toBe("2026-11-23T07:00:00.000Z");
    expect(kenyaLocalToIso("23/11/2026")).toBeNull();
    expect(kenyaToday(new Date("2026-11-23T22:30:00Z"))).toBe("2026-11-24");
  });
  it("formats shillings", () => {
    expect(formatKsh("2500")).toMatch(/2,500\.00/);
    expect(formatKsh(null)).toMatch(/0\.00/);
  });
  it("search terms cannot inject PostgREST filter syntax", () => {
    expect(safeSearchTerm("a,b),id.eq.1")).toBe("a b id.eq.1");
    expect(safeSearchTerm("50%_off*")).toBe("50 off");
  });
});
