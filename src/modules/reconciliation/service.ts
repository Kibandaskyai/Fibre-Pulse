/**
 * Statement reconciliation. Matching and verification run inside
 * public.reconcile_statement (migration 20261125000200) as the signed-in
 * user, which checks payments:reconcile.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError } from "@/lib/validation/db-errors";
import type { ReconcileReport } from "./report";
import type { StatementLine, StatementSource } from "./statement";

export type { Outcome, ReconcileLine, ReconcileReport } from "./report";

export async function reconcileStatement(
  db: SupabaseClient,
  tenantId: string,
  source: StatementSource,
  lines: StatementLine[],
  apply: boolean,
): Promise<{ ok: true; data: ReconcileReport } | { ok: false; message: string }> {
  const { data, error } = await db.rpc("reconcile_statement", { p_tenant: tenantId, p_source: source, p_lines: lines, p_apply: apply });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not reconcile the statement.") };
  const r = data as ReconcileReport;
  return {
    ok: true,
    data: {
      ...r,
      lines: r.lines.map((l) => ({ ...l, amount: l.amount === null ? null : Number(l.amount), payment_amount: l.payment_amount === null ? null : Number(l.payment_amount) })),
      missing: r.missing.map((m) => ({ ...m, amount: Number(m.amount) })),
    },
  };
}

/**
 * Statement lines recorded as received but with no payment in FibrePulse.
 * Lines whose reference has since been recorded as a payment are left out:
 * the next upload links them, or the payment was verified by hand.
 */
export async function unmatchedStatementLines(db: SupabaseClient, tenantId: string, limit = 50) {
  const { data } = await db
    .from("payment_reconciliation_records")
    .select("id, statement_source, statement_reference, statement_amount, statement_date, notes, created_at")
    .eq("tenant_id", tenantId)
    .is("payment_id", null)
    .eq("result", "unmatched")
    .order("statement_date", { ascending: false })
    .limit(limit);
  const rows = (data ?? []) as {
    id: string; statement_source: string; statement_reference: string | null; statement_amount: number | null;
    statement_date: string | null; notes: string | null; created_at: string;
  }[];
  const refs = rows.map((r) => r.statement_reference).filter((r): r is string => !!r);
  if (!refs.length) return rows;
  const { data: recorded } = await db.from("payments").select("provider_reference").eq("tenant_id", tenantId).in("provider_reference", refs);
  const known = new Set((recorded ?? []).map((p) => String(p.provider_reference).toUpperCase()));
  return rows.filter((r) => !r.statement_reference || !known.has(r.statement_reference.toUpperCase()));
}
