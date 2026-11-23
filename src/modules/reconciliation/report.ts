/** Reconciliation result types and totals. Pure, so the browser can use it. */
export type Outcome =
  | "match"
  | "verified"
  | "already_verified"
  | "amount_mismatch"
  | "needs_review"
  | "simulated"
  | "not_in_system"
  | "duplicate_line"
  | "invalid";

export type ReconcileLine = {
  line: number;
  reference: string | null;
  amount: number | null;
  date: string | null;
  details: string | null;
  outcome: Outcome;
  note: string | null;
  payment_id: string | null;
  payment_amount: number | null;
  customer: string | null;
};

export type ReconcileReport = {
  lines: ReconcileLine[];
  missing: { payment_id: string; reference: string | null; amount: number; transaction_at: string; customer: string | null }[];
  from: string | null;
  to: string | null;
  applied: boolean;
  verified: number;
  recorded_unmatched: number;
};

export function summarise(report: ReconcileReport) {
  const by = (o: Outcome[]) => report.lines.filter((l) => o.includes(l.outcome));
  const total = (rows: ReconcileLine[]) => rows.reduce((s, l) => s + (l.amount ?? 0), 0);
  const ready = by(["match"]);
  const verified = by(["verified"]);
  const already = by(["already_verified"]);
  const review = by(["amount_mismatch", "needs_review", "simulated"]);
  const unknown = by(["not_in_system"]);
  const ignored = by(["duplicate_line", "invalid"]);
  return {
    ready: { count: ready.length, amount: total(ready) },
    verified: { count: verified.length, amount: total(verified) },
    already: { count: already.length, amount: total(already) },
    review: { count: review.length, amount: total(review) },
    unknown: { count: unknown.length, amount: total(unknown) },
    ignored: { count: ignored.length },
    statementTotal: total(report.lines.filter((l) => l.outcome !== "duplicate_line" && l.outcome !== "invalid")),
  };
}
