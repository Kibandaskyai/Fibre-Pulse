/**
 * Statement parsing for reconciliation. Pure functions so they can be unit
 * tested. Turns an M-Pesa paybill statement or a bank statement CSV into
 * money-in lines; matching against payments happens in the database
 * (public.reconcile_statement).
 *
 * Supported layouts (column names are matched loosely, any order):
 *   M-Pesa (org portal export): Receipt No. · Completion Time · Details ·
 *     Transaction Status · Paid In · Withdrawn
 *   Bank: Date / Transaction Date / Value Date · Reference / Ref No. ·
 *     Description / Narration · Credit / Money In / Deposit (or a signed Amount)
 * Statements often start with a few lines of account details before the
 * header row, so the header is searched for in the first 30 rows.
 */
import { parseCsv } from "@/modules/customers/csv";

export type StatementSource = "mpesa_statement" | "bank_statement";
export type StatementLine = { line: number; reference: string; amount: number; date: string | null; details: string };
export type ParsedStatement =
  | {
      ok: true;
      source: StatementSource;
      columns: { reference: string; amount: string; date: string | null; details: string | null };
      lines: StatementLine[];
      skipped: { line: number; reason: string }[];
    }
  | { ok: false; message: string };

export const MAX_STATEMENT_LINES = 5000;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

const REFERENCE = ["receiptno", "receiptnumber", "receipt", "transactionid", "reference", "referenceno", "refno", "ref", "transactionreference", "chequeno"];
const PAID_IN = ["paidin", "credit", "credits", "creditamount", "moneyin", "deposit", "deposits", "amountin"];
const SIGNED_AMOUNT = ["amount", "transactionamount"];
const DATE = ["completiontime", "transactiondate", "date", "valuedate", "postingdate", "bookingdate", "initiationtime", "transactiontime"];
const DETAILS = ["details", "description", "narration", "narrative", "particulars", "otherpartyinfo", "remarks"];
const STATUS = ["transactionstatus", "status"];

function findColumn(header: string[], names: string[]): number {
  for (const n of names) {
    const i = header.findIndex((h) => norm(h) === n);
    if (i >= 0) return i;
  }
  return -1;
}

/** "KES 2,000.00", "2000", "(150.00)" → number; blank or "-" → null. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (!s || s === "-") return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()]/g, "").replace(/^-/, "").replace(/(KES|KSH|Ksh|KSh)\.?/gi, "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return negative ? -n : n;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Statement dates are Kenyan local dates. Slashed and dashed dates are read
 * day first (03/10/2026 is 3 October), as Kenyan banks and Safaricom print them.
 */
export function parseStatementDate(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return isoDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

export function parseStatement(text: string): ParsedStatement {
  const rows = parseCsv(text, true);
  let headerAt = -1;
  let source: StatementSource = "bank_statement";
  let col = { reference: -1, paidIn: -1, signed: -1, date: -1, details: -1, status: -1 };

  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const h = rows[i];
    const c = {
      reference: findColumn(h, REFERENCE),
      paidIn: findColumn(h, PAID_IN),
      signed: findColumn(h, SIGNED_AMOUNT),
      date: findColumn(h, DATE),
      details: findColumn(h, DETAILS),
      status: findColumn(h, STATUS),
    };
    if (c.reference >= 0 && (c.paidIn >= 0 || c.signed >= 0)) {
      headerAt = i;
      col = c;
      source = h.some((x) => ["receiptno", "receiptnumber"].includes(norm(x))) && c.paidIn >= 0 ? "mpesa_statement" : "bank_statement";
      break;
    }
  }
  if (headerAt < 0) {
    return {
      ok: false,
      message: "Could not find the header row. The file needs a reference column (Receipt No. or Reference) and a money-in column (Paid In, Credit or Amount).",
    };
  }

  const header = rows[headerAt];
  const amountCol = col.paidIn >= 0 ? col.paidIn : col.signed;
  const lines: StatementLine[] = [];
  const skipped: { line: number; reason: string }[] = [];

  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i];
    const lineNo = i + 1;
    if (r.every((v) => !v.trim())) continue;
    const reference = (r[col.reference] ?? "").trim().toUpperCase();
    const amount = parseAmount(r[amountCol]);
    if (col.status >= 0) {
      const st = (r[col.status] ?? "").trim().toLowerCase();
      if (st && st !== "completed" && st !== "success" && st !== "successful") {
        skipped.push({ line: lineNo, reason: `Status is "${r[col.status].trim()}".` });
        continue;
      }
    }
    if (amount === null || amount <= 0) {
      // Withdrawals, charges and balance lines are not money received.
      skipped.push({ line: lineNo, reason: "Not money received." });
      continue;
    }
    if (!reference) {
      skipped.push({ line: lineNo, reason: "No reference." });
      continue;
    }
    lines.push({
      line: lineNo,
      reference: reference.slice(0, 64),
      amount,
      date: col.date >= 0 ? parseStatementDate(r[col.date]) : null,
      details: col.details >= 0 ? (r[col.details] ?? "").trim().slice(0, 300) : "",
    });
  }

  if (lines.length > MAX_STATEMENT_LINES) {
    return { ok: false, message: `The statement has ${lines.length.toLocaleString()} money-in lines. The limit is ${MAX_STATEMENT_LINES.toLocaleString()}; split the file by month.` };
  }
  if (!lines.length) return { ok: false, message: "No money-in lines were found in the file." };

  return {
    ok: true,
    source,
    columns: {
      reference: header[col.reference],
      amount: header[amountCol],
      date: col.date >= 0 ? header[col.date] : null,
      details: col.details >= 0 ? header[col.details] : null,
    },
    lines,
    skipped,
  };
}
