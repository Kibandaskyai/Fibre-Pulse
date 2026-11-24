import { describe, expect, it } from "vitest";
import { feeMonths, grantState, invoiceState, ratePct, type FeeRecord } from "@/modules/platform/billing";

const rec = (over: Partial<FeeRecord>): FeeRecord => ({
  id: "r", tenant_id: "t", agreement_id: "a", period_start: "2026-10-01", period_end: "2026-10-31",
  eligible_amount: 0, fee_rate: 0.0275, fee_amount: 0, payment_count: 0, adjustment_of: null, reason: null,
  status: "calculated", platform_invoice_id: null, calculated_at: "2026-11-01T00:00:00Z", ...over,
});

describe("platform billing helpers", () => {
  it("shows an issued invoice past its due date as overdue", () => {
    expect(invoiceState({ status: "issued", due_date: "2026-11-10" }, "2026-11-24")).toBe("overdue");
    expect(invoiceState({ status: "issued", due_date: "2026-11-30" }, "2026-11-24")).toBe("issued");
    expect(invoiceState({ status: "paid", due_date: "2026-11-10" }, "2026-11-24")).toBe("paid");
  });

  it("formats fee rates as percentages", () => {
    expect(ratePct(0.0275)).toBe("2.75%");
    expect(ratePct(0.03)).toBe("3%");
  });

  it("works out a support grant's state", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(grantState({ approved_at: null, expires_at: null, revoked_at: null }, now)).toBe("waiting");
    expect(grantState({ approved_at: null, expires_at: null, revoked_at: "2026-11-24T10:00:00Z" }, now)).toBe("declined");
    expect(grantState({ approved_at: "2026-11-24T09:00:00Z", expires_at: "2026-11-24T13:00:00Z", revoked_at: null }, now)).toBe("active");
    expect(grantState({ approved_at: "2026-11-24T09:00:00Z", expires_at: "2026-11-24T11:00:00Z", revoked_at: null }, now)).toBe("expired");
    expect(grantState({ approved_at: "2026-11-24T09:00:00Z", expires_at: "2026-11-24T13:00:00Z", revoked_at: "2026-11-24T10:00:00Z" }, now)).toBe("revoked");
  });

  it("nets a month's base fee and adjustments, ignoring void records", () => {
    const months = feeMonths([
      rec({ id: "b", eligible_amount: 102000, fee_amount: 2805, status: "invoiced" }),
      rec({ id: "adj", adjustment_of: "b", eligible_amount: -2000, fee_amount: -55 }),
      rec({ id: "v", period_start: "2026-09-01", eligible_amount: 5000, fee_amount: 137.5, status: "void" }),
    ]);
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({ eligible: 100000, fee: 2750, status: "calculated" });
    expect(months[0].adjustments).toHaveLength(1);
  });
});
