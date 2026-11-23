import { z } from "zod";
import { email, KENYAN_COUNTIES, kenyanPhone } from "./common";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .transform((v) => (v === "" ? null : v))
    .prefault("");

const money = (label: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/,/g, ""))
    .pipe(
      z
        .string()
        .regex(/^\d{1,10}(\.\d{1,2})?$/, `Enter the ${label} in Ksh, for example 2500 or 2500.50.`)
        .transform(Number),
    );

const positiveNumber = (label: string, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, `Enter a number for ${label}.`)
    .transform(Number)
    .refine((n) => n > 0 && n <= max, `${label} must be between 0 and ${max}.`);

export const BILLING_PERIODS = ["daily", "weekly", "monthly", "custom"] as const;
export const REVENUE_CATEGORIES = ["subscription", "installation", "equipment", "other"] as const;
export const CUSTOMER_STATUSES = ["active", "suspended", "pending_installation", "disconnected", "terminated"] as const;
export const PAYMENT_METHODS = ["mpesa", "bank_transfer", "other"] as const;

// -----------------------------------------------------------------------------
// Packages
// -----------------------------------------------------------------------------
export const packageSchema = z
  .object({
    name: z.string().trim().min(2, "Give the package a name.").max(80),
    description: optionalText(500),
    downloadMbps: positiveNumber("Download speed", 100_000),
    uploadMbps: positiveNumber("Upload speed", 100_000),
    price: money("price"),
    billingPeriod: z.enum(BILLING_PERIODS, "Choose a billing period."),
    durationDays: z.string().trim().optional().prefault(""),
    dataLimitGb: z.string().trim().optional().prefault(""),
    fairUsagePolicy: optionalText(1000),
    networkProfile: optionalText(80),
    revenueCategory: z.enum(REVENUE_CATEGORIES).default("subscription"),
  })
  .transform((v, ctx) => {
    let durationDays: number | null = null;
    if (v.billingPeriod === "daily") durationDays = 1;
    else if (v.billingPeriod === "weekly") durationDays = 7;
    else if (v.billingPeriod === "custom") {
      const n = Number(v.durationDays);
      if (!Number.isInteger(n) || n < 1 || n > 366) {
        ctx.addIssue({ code: "custom", path: ["durationDays"], message: "Enter the number of days (1 to 366)." });
        return z.NEVER;
      }
      durationDays = n;
    }
    let dataLimitGb: number | null = null;
    if (v.dataLimitGb !== "") {
      const n = Number(v.dataLimitGb);
      if (!Number.isFinite(n) || n <= 0) {
        ctx.addIssue({ code: "custom", path: ["dataLimitGb"], message: "Enter a data limit in GB, or leave it blank for unlimited." });
        return z.NEVER;
      }
      dataLimitGb = n;
    }
    return { ...v, durationDays, dataLimitGb };
  });
export type PackageInput = z.infer<typeof packageSchema>;

// -----------------------------------------------------------------------------
// Customers
// -----------------------------------------------------------------------------
const latitude = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : Number(v)))
  .refine((v) => v === null || (Number.isFinite(v) && v >= -5 && v <= 5.5), "Latitude must be inside Kenya (-5.0 to 5.5).");
const longitude = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : Number(v)))
  .refine((v) => v === null || (Number.isFinite(v) && v >= 33.5 && v <= 42), "Longitude must be inside Kenya (33.5 to 42.0).");

export const customerSchema = z
  .object({
    fullName: z.string().trim().min(2, "Enter the customer's name.").max(120),
    phone: kenyanPhone,
    email: z.union([z.literal("").transform(() => null), email]).prefault(""),
    address: optionalText(200),
    estate: optionalText(80),
    town: optionalText(80),
    county: z.union([z.literal("").transform(() => null), z.enum(KENYAN_COUNTIES, "Choose a county.")]).prefault(""),
    status: z.enum(CUSTOMER_STATUSES).default("pending_installation"),
    pppoeUsername: optionalText(64),
    notes: optionalText(1000),
    latitude: latitude.prefault(""),
    longitude: longitude.prefault(""),
  })
  .refine((v) => (v.latitude === null) === (v.longitude === null), {
    path: ["longitude"],
    message: "Enter both latitude and longitude, or neither.",
  });
export type CustomerInput = z.infer<typeof customerSchema>;

export const customerFiltersSchema = z.object({
  q: z.string().trim().max(80).prefault(""),
  status: z.union([z.enum(CUSTOMER_STATUSES), z.literal("")]).prefault(""),
  area: z.string().trim().max(80).prefault(""),
  balance: z.enum(["", "owing", "credit"]).prefault(""),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type CustomerFilters = z.infer<typeof customerFiltersSchema>;

// -----------------------------------------------------------------------------
// Subscriptions, invoices and payments
// -----------------------------------------------------------------------------
export const reasonSchema = z.string().trim().min(5, "Give a reason of at least 5 characters.").max(500);

export const purchaseSchema = z.object({
  customerId: z.uuid(),
  packageId: z.uuid("Choose a package."),
});

export const subscriptionActionSchema = z.object({
  subscriptionId: z.uuid(),
  action: z.enum(["suspend", "restore", "cancel"]),
  reason: z.string().trim().max(500).prefault(""),
});

export const recordPaymentSchema = z.object({
  customerId: z.union([z.literal("").transform(() => null), z.uuid()]).prefault(""),
  method: z.enum(PAYMENT_METHODS, "Choose how the customer paid."),
  reference: z
    .string()
    .trim()
    .toUpperCase()
    .min(4, "Enter the M-Pesa receipt or bank reference.")
    .max(64)
    .regex(/^[A-Z0-9/-]+$/, "Use letters, numbers, / or - only."),
  amount: money("amount").refine((n) => n > 0, "The amount must be more than zero."),
  transactionAt: z.string().trim().min(1, "Enter when the payment was made."),
  payerPhone: z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return null;
      const m = v.replace(/[\s()-]/g, "").match(/^(?:\+?254|0)?([17]\d{8})$/);
      if (!m) {
        ctx.addIssue({ code: "custom", message: "Enter a Kenyan mobile number, for example 0712 345 678." });
        return z.NEVER;
      }
      return `+254${m[1]}`;
    })
    .prefault(""),
  payerName: optionalText(120),
  description: optionalText(300),
});

export const verifySchema = z.object({
  paymentId: z.uuid(),
  statementSource: z.enum(["mpesa_statement", "bank_statement", "provider_query", "manual_review"], "Choose the statement you checked."),
  statementReference: optionalText(80),
  notes: optionalText(500),
});

export const allocateSchema = z.object({
  paymentId: z.uuid(),
  invoiceId: z.uuid("Choose an invoice."),
  amount: money("amount").refine((n) => n > 0, "The amount must be more than zero."),
});

export const invoiceSchema = z.object({
  customerId: z.uuid(),
  description: z.string().trim().min(1, "Describe what is being charged.").max(200),
  category: z.enum(REVENUE_CATEGORIES),
  quantity: positiveNumber("Quantity", 10_000),
  unitPrice: money("unit price"),
  dueDate: z
    .string()
    .trim()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, "Enter a date.")
    .transform((v) => (v === "" ? null : v))
    .prefault(""),
  notes: optionalText(500),
});
