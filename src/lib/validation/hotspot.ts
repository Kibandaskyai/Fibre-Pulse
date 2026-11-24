import { z } from "zod";
import { kenyanPhone, optionalKenyanPhone } from "./common";

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

/** A hotspot plan: time bought, price, speed. Durations are entered as a number and a unit. */
export const hotspotPlanSchema = z
  .object({
    name: z.string().trim().min(2, "Give the plan a name.").max(60),
    durationValue: z.coerce.number().int("Whole numbers only.").min(1, "At least 1.").max(527040),
    durationUnit: z.enum(["minutes", "hours", "days"]),
    price: z.coerce.number().int("M-Pesa takes whole shillings.").min(1, "Enter a price above zero.").max(1_000_000),
    downloadMbps: z.coerce.number().positive("Enter a speed above zero.").max(10_000),
    uploadMbps: z.preprocess(blankToNull, z.coerce.number().positive().max(10_000).nullable()),
    usageType: z.enum(["limited", "unlimited"]),
    dataLimitGb: z.preprocess(blankToNull, z.coerce.number("Enter the data in GB, e.g. 1 or 0.5.").positive("Enter more than 0 GB.").max(10_000).nullable()),
    networkProfile: z.preprocess(blankToNull, z.string().trim().max(64).nullable()),
    sortOrder: z.preprocess(blankToNull, z.coerce.number().int().min(0).max(999).nullable()),
  })
  .transform((v, ctx) => {
    const minutes = v.durationValue * (v.durationUnit === "days" ? 1440 : v.durationUnit === "hours" ? 60 : 1);
    if (minutes < 10) ctx.addIssue({ code: "custom", path: ["durationValue"], message: "Plans run for at least 10 minutes." });
    if (minutes > 527040) ctx.addIssue({ code: "custom", path: ["durationValue"], message: "Plans run for at most a year." });
    // Limited plans have a data cap for the period; Unlimited plans never do.
    // A Limited plan may be saved without a cap until the ISP decides it.
    const dataLimitMb = v.usageType === "limited" && v.dataLimitGb ? Math.max(1, Math.round(v.dataLimitGb * 1024)) : null;
    return { ...v, durationMinutes: minutes, dataLimitMb };
  });
export type HotspotPlanInput = z.infer<typeof hotspotPlanSchema>;

export const sellCodeSchema = z.object({
  planId: z.uuid("Choose a plan."),
  phone: optionalKenyanPhone,
  mpesaReference: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{8,12}$/, "Enter the M-Pesa transaction code, for example SKL4H7XY2Q."),
});

export const freeCodeSchema = z.object({
  planId: z.uuid("Choose a plan."),
  phone: optionalKenyanPhone,
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(300),
});

export const cancelCodeSchema = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(300),
});

export const resendCodeSchema = z.object({
  id: z.uuid(),
  phone: optionalKenyanPhone,
});

export const compensateSchema = z.object({
  minutes: z.coerce.number().int("Whole minutes.").min(1, "At least 1 minute.").max(10080, "At most 7 days."),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(300),
});

export const serviceSettingsSchema = z.object({
  methods: z.array(z.enum(["mpesa", "bank_transfer", "other"])).min(1, "Choose at least one payment method."),
  paybill: z.preprocess(blankToNull, z.string().trim().regex(/^\d{5,7}$/, "A paybill number has 5 to 7 digits.").nullable()),
  accountNumber: z.preprocess((v) => (v === undefined ? null : blankToNull(v)), z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, "Up to 20 letters or digits.").nullable()),
  upstreamProvider: z.string().trim().min(2, "Name your internet provider.").max(60),
  upstreamPhone: z.preprocess(blankToNull, z.string().trim().regex(/^[0-9+ ]{3,20}$/, "Digits only, for example 0722 000 100.").nullable()),
  upstreamCheckTarget: z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .regex(/^(\d{1,3}\.){3}\d{1,3}$/, "An IPv4 address, for example 8.8.8.8.")
      .nullable(),
  ),
  hotspotClockStart: z.enum(["payment", "first_login"]).default("payment"),
});

/** The public buying page. */
export const portalBuySchema = z.object({
  planId: z.uuid("Choose a plan."),
  phone: kenyanPhone,
  mac: z.preprocess(blankToNull, z.string().trim().max(32).nullable()),
});
