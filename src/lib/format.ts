/** Display helpers. All dates show in Kenyan time (EAT, UTC+3). */
export const KENYA_TZ = "Africa/Nairobi";

const ksh = new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeZone: KENYA_TZ });
const dateTime = new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: KENYA_TZ });

/** "Ksh 2,500.00". Accepts numbers or Postgres numeric strings. */
export function formatKsh(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  return ksh.format(Number.isFinite(n) ? n : 0).replace("KES", "Ksh");
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return date.format(typeof value === "string" ? new Date(value.length === 10 ? `${value}T00:00:00+03:00` : value) : value);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return dateTime.format(typeof value === "string" ? new Date(value) : value);
}

/** Today's date in Kenya as YYYY-MM-DD. */
export function kenyaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: KENYA_TZ }).format(now);
}

/** Convert a local Kenyan date-time from a form ("2026-11-23T14:05") to an ISO instant. */
export function kenyaLocalToIso(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const d = new Date(`${local}:00+03:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const BILLING_PERIOD_LABELS: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom",
};

export function periodLabel(period: string, days: number | null): string {
  if (period === "custom" && days) return `${days} days`;
  return BILLING_PERIOD_LABELS[period] ?? period;
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  mpesa: "M-Pesa",
  bank_transfer: "Bank transfer",
  other: "Other",
};
