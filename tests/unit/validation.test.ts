import { describe, expect, it } from "vitest";
import { normaliseKenyanPhone } from "@/lib/validation/common";
import { registerTenantSchema, slugify } from "@/lib/validation/tenants";
import { signUpSchema } from "@/lib/validation/auth";
import { safeNextPath } from "@/lib/security/redirect";
import { friendlyDbError } from "@/lib/validation/db-errors";

describe("Kenyan phone numbers", () => {
  it.each([
    ["0712345678", "+254712345678"],
    ["0712 345 678", "+254712345678"],
    ["+254712345678", "+254712345678"],
    ["254712345678", "+254712345678"],
    ["712345678", "+254712345678"],
    ["0110123456", "+254110123456"],
  ])("normalises %s", (input, expected) => {
    expect(normaliseKenyanPhone(input)).toBe(expected);
  });

  it.each(["0812345678", "07123", "+255712345678", "hello", ""])("rejects %s", (input) => {
    expect(normaliseKenyanPhone(input)).toBeNull();
  });
});

describe("tenant registration input", () => {
  it("builds a workspace address from the ISP name", () => {
    expect(slugify("Kilimani Fibre Networks Ltd.")).toBe("kilimani-fibre-networks-ltd");
    expect(slugify("  Mũthaiga Net  ")).toBe("muthaiga-net");
  });

  it("accepts a valid registration", () => {
    const r = registerTenantSchema.safeParse({ name: "Ruaka Net", slug: "ruaka-net", county: "Kiambu", contactPhone: "0722 000 111" });
    expect(r.success && r.data.contactPhone).toBe("+254722000111");
  });

  it("rejects unknown counties and bad slugs", () => {
    expect(registerTenantSchema.safeParse({ name: "X Net", slug: "x-net", county: "Atlantis", contactPhone: "" }).success).toBe(false);
    expect(registerTenantSchema.safeParse({ name: "X Net", slug: "-bad-", county: "Nairobi", contactPhone: "" }).success).toBe(false);
  });
});

describe("passwords", () => {
  it("requires length and mixed characters", () => {
    expect(signUpSchema.safeParse({ fullName: "Achieng Test", email: "a@example.test", password: "short" }).success).toBe(false);
    expect(signUpSchema.safeParse({ fullName: "Achieng Test", email: "a@example.test", password: "alllowercase123" }).success).toBe(false);
    expect(signUpSchema.safeParse({ fullName: "Achieng Test", email: "a@example.test", password: "Strong-Pass-2026" }).success).toBe(true);
  });
});

describe("post-login redirect", () => {
  it.each([
    ["/customers", "/customers"],
    ["/customers?status=active", "/customers?status=active"],
    ["https://evil.example", "/overview"],
    ["//evil.example", "/overview"],
    ["/\\evil.example", "/overview"],
    ["javascript:alert(1)", "/overview"],
    [undefined, "/overview"],
  ])("maps %s to %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe("database error messages", () => {
  it("never leaks raw RLS errors", () => {
    expect(friendlyDbError({ code: "42501", message: 'new row violates row-level security policy for table "customers"' })).toBe(
      "You do not have permission to do that.",
    );
  });
  it("passes through our own readable guard messages", () => {
    expect(friendlyDbError({ code: "42501", message: "You cannot change your own role or status." })).toBe(
      "You cannot change your own role or status.",
    );
  });
});
