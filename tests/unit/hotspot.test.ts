import { describe, expect, it } from "vitest";
import { formatPlanDuration, timeLeft } from "@/lib/format";
import { cleanMac, safeHotspotLoginUrl } from "@/lib/hotspot-login";
import { compensateSchema, hotspotPlanSchema, portalBuySchema, sellCodeSchema, serviceSettingsSchema } from "@/lib/validation/hotspot";

describe("hotspot plan durations", () => {
  it("names the client's plans the way they are sold", () => {
    expect(formatPlanDuration(60)).toBe("1 hour");
    expect(formatPlanDuration(180)).toBe("3 hours");
    expect(formatPlanDuration(1440)).toBe("24 hours");
    expect(formatPlanDuration(2880)).toBe("2 days");
    expect(formatPlanDuration(10080)).toBe("7 days");
    expect(formatPlanDuration(30)).toBe("30 minutes");
    expect(formatPlanDuration(null)).toBe("—");
  });

  it("shows time left on a running code", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(timeLeft("2026-11-24T15:20:00Z", now)).toBe("3 h 20 min");
    expect(timeLeft("2026-11-26T16:00:00Z", now)).toBe("2 days 4 h");
    expect(timeLeft("2026-11-24T12:00:20Z", now)).toBe("1 min");
    expect(timeLeft("2026-11-24T11:00:00Z", now)).toBe("ended");
    expect(timeLeft(null, now)).toBe("—");
  });
});

describe("hotspot login address", () => {
  it("accepts the router's own login page", () => {
    expect(safeHotspotLoginUrl("http://10.5.50.1/login")).toBe("http://10.5.50.1/login");
    expect(safeHotspotLoginUrl("http://192.168.88.1/login")).toBeTruthy();
    expect(safeHotspotLoginUrl("http://172.20.0.1/login")).toBeTruthy();
    expect(safeHotspotLoginUrl("http://hotspot.local/login")).toBeTruthy();
    expect(safeHotspotLoginUrl("http://wifi/login")).toBeTruthy();
  });

  it("refuses anything that could send a code to the internet", () => {
    expect(safeHotspotLoginUrl("https://evil.example.com/login")).toBeNull();
    expect(safeHotspotLoginUrl("http://8.8.8.8/login")).toBeNull();
    expect(safeHotspotLoginUrl("http://172.32.0.1/login")).toBeNull();
    expect(safeHotspotLoginUrl("http://user:pw@10.0.0.1/login")).toBeNull();
    expect(safeHotspotLoginUrl("javascript:alert(1)")).toBeNull();
    expect(safeHotspotLoginUrl("http://10.0.0.300/")).toBeNull();
    expect(safeHotspotLoginUrl("not a url")).toBeNull();
    expect(safeHotspotLoginUrl(null)).toBeNull();
  });

  it("keeps only a valid device MAC", () => {
    expect(cleanMac("AA:BB:CC:DD:EE:FF")).toBe("aa:bb:cc:dd:ee:ff");
    expect(cleanMac("aa-bb-cc-dd-ee-ff")).toBe("aa:bb:cc:dd:ee:ff");
    expect(cleanMac("aa:bb:cc")).toBeNull();
    expect(cleanMac(undefined)).toBeNull();
  });
});

describe("hotspot forms", () => {
  const plan = { name: "24 Hours", durationValue: "24", durationUnit: "hours", price: "50", downloadMbps: "10", uploadMbps: "", usageType: "limited", dataLimitMb: "", networkProfile: "", sortOrder: "" };

  it("turns a plan's duration into minutes", () => {
    const r = hotspotPlanSchema.safeParse(plan);
    expect(r.success && r.data.durationMinutes).toBe(1440);
    const d = hotspotPlanSchema.safeParse({ ...plan, durationValue: "7", durationUnit: "days" });
    expect(d.success && d.data.durationMinutes).toBe(10080);
  });

  it("refuses plans M-Pesa or the router cannot handle", () => {
    expect(hotspotPlanSchema.safeParse({ ...plan, price: "49.5" }).success).toBe(false);
    expect(hotspotPlanSchema.safeParse({ ...plan, price: "0" }).success).toBe(false);
    expect(hotspotPlanSchema.safeParse({ ...plan, durationValue: "5", durationUnit: "minutes" }).success).toBe(false);
  });

  it("needs a real M-Pesa code to sell a code by hand", () => {
    const base = { planId: "00000000-0000-4000-8000-000000000001", phone: "" };
    const ok = sellCodeSchema.safeParse({ ...base, mpesaReference: " skl4h7xy2q " });
    expect(ok.success && ok.data.mpesaReference).toBe("SKL4H7XY2Q");
    expect(sellCodeSchema.safeParse({ ...base, mpesaReference: "123" }).success).toBe(false);
  });

  it("needs a phone to buy on the WiFi page", () => {
    const base = { planId: "00000000-0000-4000-8000-000000000001", mac: "" };
    expect(portalBuySchema.safeParse({ ...base, phone: "0712345678" }).success).toBe(true);
    expect(portalBuySchema.safeParse({ ...base, phone: "" }).success).toBe(false);
  });

  it("limits outage compensation to a week", () => {
    expect(compensateSchema.safeParse({ minutes: "120", reason: "Safaricom outage" }).success).toBe(true);
    expect(compensateSchema.safeParse({ minutes: "20000", reason: "Safaricom outage" }).success).toBe(false);
  });

  it("checks the paybill and the address the router pings", () => {
    const s = { methods: ["mpesa"], paybill: "123456", upstreamProvider: "Safaricom", upstreamPhone: "", upstreamCheckTarget: "8.8.8.8" };
    expect(serviceSettingsSchema.safeParse(s).success).toBe(true);
    expect(serviceSettingsSchema.safeParse({ ...s, methods: [] }).success).toBe(false);
    expect(serviceSettingsSchema.safeParse({ ...s, paybill: "12" }).success).toBe(false);
    expect(serviceSettingsSchema.safeParse({ ...s, upstreamCheckTarget: "google.com" }).success).toBe(false);
  });
});
