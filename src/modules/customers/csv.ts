/**
 * Customer CSV import and export. Pure functions so they can be unit tested.
 *
 * Import columns (header row required, any order, case-insensitive):
 *   full_name*, phone*, email, address, estate, town, county, status,
 *   pppoe_username, notes
 * GPS is not imported from CSV on purpose: exact locations are captured on
 * site (Phase 5) so a spreadsheet cannot spread them.
 */
import { customerSchema, type CustomerInput } from "@/lib/validation/billing";
import { KENYAN_COUNTIES } from "@/lib/validation/common";

export const IMPORT_COLUMNS = ["full_name", "phone", "email", "address", "estate", "town", "county", "status", "pppoe_username", "notes"] as const;
export const MAX_IMPORT_ROWS = 2000;

/** RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type ImportRowResult =
  | { line: number; ok: true; data: CustomerInput }
  | { line: number; ok: false; errors: string[]; raw: Record<string, string> };

export type ImportReport = {
  rows: ImportRowResult[];
  valid: number;
  invalid: number;
  /** Header problems that stop the whole import. */
  fatal: string | null;
};

const STATUS_ALIASES: Record<string, string> = {
  active: "active",
  suspended: "suspended",
  pending: "pending_installation",
  "pending installation": "pending_installation",
  pending_installation: "pending_installation",
  disconnected: "disconnected",
  terminated: "terminated",
};

/**
 * Validate every row and flag duplicates within the file and against
 * existing customers. `existing` holds phones (E.164) and PPPoE usernames
 * already used by live customers of this ISP.
 */
export function buildImportReport(text: string, existing: { phones: Set<string>; pppoe: Set<string> }): ImportReport {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], valid: 0, invalid: 0, fatal: "The file needs a header row and at least one customer." };
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { rows: [], valid: 0, invalid: 0, fatal: `Import at most ${MAX_IMPORT_ROWS} customers at a time.` };
  }
  const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  for (const required of ["full_name", "phone"]) {
    if (!header.includes(required)) return { rows: [], valid: 0, invalid: 0, fatal: `The header row must include a "${required}" column.` };
  }
  const unknown = header.filter((h) => h && !(IMPORT_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) {
    return { rows: [], valid: 0, invalid: 0, fatal: `Unknown column(s): ${unknown.join(", ")}. Allowed: ${IMPORT_COLUMNS.join(", ")}.` };
  }

  const seenPhones = new Map<string, number>();
  const seenPppoe = new Map<string, number>();
  const rows: ImportRowResult[] = [];

  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    const raw: Record<string, string> = {};
    header.forEach((h, i) => (raw[h] = (cells[i] ?? "").trim()));
    const statusKey = (raw.status ?? "").toLowerCase();
    const parsed = customerSchema.safeParse({
      fullName: raw.full_name ?? "",
      phone: raw.phone ?? "",
      email: raw.email ?? "",
      address: raw.address ?? "",
      estate: raw.estate ?? "",
      town: raw.town ?? "",
      county: matchCounty(raw.county ?? ""),
      status: statusKey === "" ? "pending_installation" : (STATUS_ALIASES[statusKey] ?? raw.status),
      pppoeUsername: raw.pppoe_username ?? "",
      notes: raw.notes ?? "",
      latitude: "",
      longitude: "",
    });
    if (!parsed.success) {
      rows.push({ line, ok: false, errors: parsed.error.issues.map((i) => `${labelFor(String(i.path[0]))}: ${i.message}`), raw });
      return;
    }
    const errors: string[] = [];
    const d = parsed.data;
    if (existing.phones.has(d.phone)) errors.push(`Phone ${d.phone} already belongs to an existing customer.`);
    const firstPhone = seenPhones.get(d.phone);
    if (firstPhone) errors.push(`Phone ${d.phone} is repeated (first on line ${firstPhone}).`);
    else seenPhones.set(d.phone, line);
    if (d.pppoeUsername) {
      const key = d.pppoeUsername.toLowerCase();
      if (existing.pppoe.has(key)) errors.push(`PPPoE username ${d.pppoeUsername} is already in use.`);
      const firstPppoe = seenPppoe.get(key);
      if (firstPppoe) errors.push(`PPPoE username ${d.pppoeUsername} is repeated (first on line ${firstPppoe}).`);
      else seenPppoe.set(key, line);
    }
    if (errors.length) rows.push({ line, ok: false, errors, raw });
    else rows.push({ line, ok: true, data: d });
  });

  const valid = rows.filter((r) => r.ok).length;
  return { rows, valid, invalid: rows.length - valid, fatal: null };
}

/** "nairobi county" -> "Nairobi". Unknown names pass through and fail validation. */
function matchCounty(value: string): string {
  const cleaned = value.trim().replace(/\s+county$/i, "").replace(/\s+/g, " ");
  return KENYAN_COUNTIES.find((c) => c.toLowerCase() === cleaned.toLowerCase().replace(/[’`]/g, "'")) ?? cleaned;
}

function labelFor(field: string): string {
  const map: Record<string, string> = { fullName: "full_name", pppoeUsername: "pppoe_username" };
  return map[field] ?? field;
}

/** Escape one CSV cell. Neutralises spreadsheet formulas (CSV injection). */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // Plain numbers such as +254712345678 or -100 are safe; anything else that
  // starts like a formula is prefixed so spreadsheets show it as text.
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
