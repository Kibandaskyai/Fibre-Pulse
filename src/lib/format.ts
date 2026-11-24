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

/** "1 payment", "3 payments". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString("en-KE")} ${n === 1 ? word : many}`;
}

/** 250000000 -> "250 Mbps". */
export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  const units = ["bps", "kbps", "Mbps", "Gbps"];
  let v = bps;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 788645 -> "9d 3h". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "3 min ago", "2 h ago", or a date. */
export function timeAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "never";
  const s = Math.round((now - Date.parse(value)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return formatDateTime(value);
}

/** An ISO time as a datetime-local value in Kenyan time ("2026-11-24T14:30"), or "" for none. */
export function isoToKenyaLocal(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 16);
}

/** Hotspot plan length: 60 -> "1 hour", 1440 -> "24 hours", 4320 -> "3 days", 43200 -> "30 days". */
/** Data in MB as people say it: "500 MB", "1 GB", "1.5 GB". */
export function formatData(mb: number | null | undefined): string {
  const m = Number(mb ?? 0);
  if (!(m > 0)) return "—";
  if (m < 1024) return `${Math.round(m)} MB`;
  const gb = m / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1).replace(/\.0$/, "")} GB`;
}

export function formatPlanDuration(minutes: number | null | undefined): string {
  const m = Number(minutes ?? 0);
  if (!m) return "—";
  if (m < 60) return plural(m, "minute");
  if (m <= 1440 && m % 60 === 0) return plural(m / 60, "hour");
  if (m % 1440 === 0) return plural(m / 1440, "day");
  if (m % 60 === 0) return plural(m / 60, "hour");
  return plural(m, "minute");
}

/** Time left until an instant: "3 h 20 min", "2 days 4 h", "ended". */
export function timeLeft(until: string | null | undefined, now = Date.now()): string {
  if (!until) return "—";
  const s = Math.floor((new Date(until).getTime() - now) / 1000);
  if (s <= 0) return "ended";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const min = Math.floor((s % 3600) / 60);
  if (d) return `${d} ${d === 1 ? "day" : "days"}${h ? ` ${h} h` : ""}`;
  if (h) return `${h} h${min ? ` ${min} min` : ""}`;
  return `${Math.max(min, 1)} min`;
}
