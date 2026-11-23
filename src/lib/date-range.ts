/**
 * Date ranges for dashboards and reports, always in Kenyan calendar days.
 * Ranges are inclusive YYYY-MM-DD strings.
 */
import { kenyaToday } from "./format";

export const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "90d", label: "Last 90 days" },
  { key: "this_year", label: "This year" },
  { key: "custom", label: "Custom dates" },
] as const;

export type RangeKey = (typeof RANGE_PRESETS)[number]["key"];
export type DateRange = { key: RangeKey; from: string; to: string; label: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function isValidDate(iso: string): boolean {
  return ISO.test(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;
}

/**
 * Resolve ?range=…&from=…&to=… into a concrete range. If the dates sent do
 * not match the chosen preset, the person edited them, so they win (custom).
 * Invalid input falls back to the default.
 */
export function resolveRange(
  params: { range?: string; from?: string; to?: string },
  fallback: RangeKey = "30d",
  now = new Date(),
): DateRange {
  const preset = resolvePreset(params, fallback, now);
  const { from, to } = params;
  if (preset.key !== "custom" && from && to && isValidDate(from) && isValidDate(to) && (from !== preset.from || to !== preset.to)) {
    return resolvePreset({ range: "custom", from, to }, fallback, now);
  }
  return preset;
}

function resolvePreset(
  params: { range?: string; from?: string; to?: string },
  fallback: RangeKey = "30d",
  now = new Date(),
): DateRange {
  const today = kenyaToday(now);
  const key = (RANGE_PRESETS.some((p) => p.key === params.range) ? params.range : fallback) as RangeKey;
  const label = RANGE_PRESETS.find((p) => p.key === key)!.label;
  const month = today.slice(0, 7);
  switch (key) {
    case "today":
      return { key, from: today, to: today, label };
    case "7d":
      return { key, from: addDays(today, -6), to: today, label };
    case "30d":
      return { key, from: addDays(today, -29), to: today, label };
    case "90d":
      return { key, from: addDays(today, -89), to: today, label };
    case "this_month":
      return { key, from: `${month}-01`, to: today, label };
    case "last_month": {
      const lastDay = addDays(`${month}-01`, -1);
      return { key, from: `${lastDay.slice(0, 7)}-01`, to: lastDay, label };
    }
    case "this_year":
      return { key, from: `${today.slice(0, 4)}-01-01`, to: today, label };
    case "custom": {
      const from = params.from ?? "";
      const to = params.to ?? "";
      if (!isValidDate(from) || !isValidDate(to) || to < from || daysBetween(from, to) > 3660) {
        return resolvePreset({ range: fallback }, fallback, now);
      }
      return { key, from, to, label: `${from} to ${to}` };
    }
  }
}

/** Day buckets for up to ~3 months, month buckets beyond that. */
export function grainFor(range: DateRange): "day" | "month" {
  return daysBetween(range.from, range.to) <= 92 ? "day" : "month";
}

/** The same-length period immediately before, for comparisons. */
export function previousPeriod(range: DateRange): { from: string; to: string } {
  const len = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -len), to: addDays(range.from, -1) };
}

/** Last 12 Kenyan months up to today, for trend charts. */
export function last12Months(now = new Date()): { from: string; to: string } {
  const today = kenyaToday(now);
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const startMonth = new Date(Date.UTC(y, m - 12, 1)).toISOString().slice(0, 10);
  return { from: startMonth, to: today };
}

/** One Kenyan day for the daily report. Invalid or future dates give today. */
export function dayRange(date: string | undefined, now = new Date()): DateRange {
  const today = kenyaToday(now);
  const d = date && isValidDate(date) && date <= today ? date : today;
  return { key: "custom", from: d, to: d, label: d };
}

/** One calendar month for the monthly report, up to today for the current month. */
export function monthRange(month: string | undefined, now = new Date()): DateRange {
  const today = kenyaToday(now);
  const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= today.slice(0, 7) ? month : today.slice(0, 7);
  const [y, mm] = m.split("-").map(Number);
  const last = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);
  return { key: "custom", from: `${m}-01`, to: last < today ? last : today, label: m };
}
