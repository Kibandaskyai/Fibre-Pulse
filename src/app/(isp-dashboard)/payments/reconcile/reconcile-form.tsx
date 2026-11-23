"use client";
import Link from "next/link";
import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubmitButton } from "@/components/shared/form-bits";
import { formatDate, formatDateTime, formatKsh } from "@/lib/format";
import { reconcileStatementAction, type ReconcileState } from "@/modules/reconciliation/actions";
import { summarise, type Outcome, type ReconcileLine } from "@/modules/reconciliation/report";

const SOURCE_LABEL = { mpesa_statement: "M-Pesa statement", bank_statement: "Bank statement" } as const;
const SHOW = 200;
const plural = (n: number, word: string) => `${n.toLocaleString("en-KE")} ${word}${n === 1 ? "" : "s"}`;

const OUTCOME: Record<Outcome, [string, "success" | "warning" | "danger" | "secondary" | "accent"]> = {
  match: ["Ready to verify", "success"],
  verified: ["Verified now", "success"],
  already_verified: ["Already verified", "secondary"],
  amount_mismatch: ["Amount differs", "warning"],
  needs_review: ["Needs review", "warning"],
  simulated: ["Simulated payment", "danger"],
  not_in_system: ["Not in FibrePulse", "accent"],
  duplicate_line: ["Repeated line", "secondary"],
  invalid: ["Unreadable line", "secondary"],
};

export function ReconcileForm() {
  const [state, action] = useActionState<ReconcileState, FormData>(reconcileStatementAction, null);
  const result = state && state.stage !== "error" ? state : null;
  const s = result ? summarise(result.report) : null;

  return (
    <div className="grid content-start gap-6">
      {state?.stage !== "done" ? (
        <Card>
          <CardContent className="pt-5">
            <form action={action} className="grid gap-4 sm:grid-cols-[1fr_14rem_auto] sm:items-end">
              <input type="hidden" name="step" value="check" />
              <div className="grid gap-2">
                <Label htmlFor="statement-file">Statement CSV</Label>
                <Input id="statement-file" name="file" type="file" accept=".csv,text/csv" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="statement-source">Statement type</Label>
                <NativeSelect id="statement-source" name="source" defaultValue="">
                  <option value="">Detect from the file</option>
                  <option value="mpesa_statement">M-Pesa statement</option>
                  <option value="bank_statement">Bank statement</option>
                </NativeSelect>
              </div>
              <SubmitButton variant="secondary" pendingText="Checking…">Check statement</SubmitButton>
            </form>
            {state?.stage === "error" ? (
              <Alert variant="danger" className="mt-4"><AlertDescription className="text-foreground">{state.message}</AlertDescription></Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {result && s ? (
        <>
          {result.stage === "done" ? (
            <Alert variant="success">
              <AlertDescription className="text-foreground">
                {plural(s.verified.count, "payment")} ({formatKsh(s.verified.amount)}) verified and now counted as collected revenue.
                {result.report.recorded_unmatched ? ` ${plural(result.report.recorded_unmatched, "statement line")} with no payment recorded for follow-up.` : ""}
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{result.stage === "done" ? "Reconciliation saved" : "Check results"}</CardTitle>
              <CardDescription>
                {result.fileName} · read as {SOURCE_LABEL[result.source]}
                {result.source !== result.detected ? ` (the file looked like a ${SOURCE_LABEL[result.detected].toLowerCase()})` : ""}
                {result.report.from ? ` · ${formatDate(result.report.from)} to ${formatDate(result.report.to!)}` : ""}
                {" · "}columns used: {result.columns.reference}, {result.columns.amount}{result.columns.date ? `, ${result.columns.date}` : ""}
                {result.skipped ? ` · ${plural(result.skipped, "line")} skipped (withdrawals, charges or failed)` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {result.stage === "done" ? (
                  <Tile label="Verified now" count={s.verified.count} amount={s.verified.amount} tone="text-success" />
                ) : (
                  <Tile label="Ready to verify" count={s.ready.count} amount={s.ready.amount} tone="text-success" />
                )}
                <Tile label="Already verified" count={s.already.count} amount={s.already.amount} />
                <Tile label="Need review" count={s.review.count} amount={s.review.amount} tone={s.review.count ? "text-warning" : undefined} />
                <Tile label="Not in FibrePulse" count={s.unknown.count} amount={s.unknown.amount} tone={s.unknown.count ? "text-accent" : undefined} />
              </dl>
              {result.stage === "checked" ? (
                s.ready.count || s.unknown.count ? (
                  <form action={action} className="flex flex-wrap items-center gap-3">
                    <input type="hidden" name="step" value="apply" />
                    <input type="hidden" name="csv" value={result.csv} />
                    <input type="hidden" name="source" value={result.source} />
                    <input type="hidden" name="fileName" value={result.fileName} />
                    <SubmitButton pendingText="Saving…">
                      {s.ready.count ? `Verify ${plural(s.ready.count, "payment")}` : "Record unknown lines"}
                    </SubmitButton>
                    <p className="text-xs text-muted-foreground">
                      Only exact matches (same reference and amount) are verified.
                      {s.unknown.count ? ` ${s.unknown.count} lines not in FibrePulse will be recorded for follow-up.` : ""} Nothing else changes.
                    </p>
                  </form>
                ) : (
                  <p className="text-sm text-muted-foreground">Nothing to verify in this statement.</p>
                )
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button asChild><Link href="/payments?verification=unverified">Payments still awaiting verification</Link></Button>
                  <Button asChild variant="outline"><Link href="/payments/reconcile">Reconcile another statement</Link></Button>
                </div>
              )}
            </CardContent>
          </Card>

          <LineTable
            title={result.stage === "done" ? "Verified now" : "Ready to verify"}
            description="Same reference and amount as a recorded payment that was awaiting verification."
            rows={result.report.lines.filter((l) => l.outcome === "match" || l.outcome === "verified")}
          />
          <LineTable
            title="Need review"
            description="The reference is recorded but something does not agree. Open the payment to fix or reject it."
            rows={result.report.lines.filter((l) => ["amount_mismatch", "needs_review", "simulated"].includes(l.outcome))}
          />
          <LineTable
            title="On the statement but not in FibrePulse"
            description="Money received that nobody has recorded. Record the payment, then reconcile again."
            rows={result.report.lines.filter((l) => l.outcome === "not_in_system")}
            showDetails
          />

          {result.report.missing.length ? (
            <Card>
              <CardHeader>
                <CardTitle>Recorded in FibrePulse but not on this statement</CardTitle>
                <CardDescription>
                  Payments awaiting verification dated within the statement&apos;s period. Check the reference; if the money never arrived, reject the payment.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 pb-2">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Reference</TableHead><TableHead>Customer</TableHead><TableHead>When</TableHead><TableHead className="text-right">Amount</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.report.missing.slice(0, SHOW).map((m) => (
                        <TableRow key={m.payment_id}>
                          <TableCell><Link className="text-primary hover:underline" href={`/payments/${m.payment_id}`}>{m.reference ?? "No reference"}</Link></TableCell>
                          <TableCell>{m.customer ?? "Not linked"}</TableCell>
                          <TableCell className="whitespace-nowrap">{formatDateTime(m.transaction_at)}</TableCell>
                          <TableCell className="tabular text-right">{formatKsh(m.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Tile({ label, count, amount, tone }: { label: string; count: number; amount: number; tone?: string }) {
  return (
    <div className="rounded-md border bg-background/40 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`tabular text-xl font-semibold ${tone ?? ""}`}>{count}</dd>
      <dd className="tabular text-xs text-muted-foreground">{formatKsh(amount)}</dd>
    </div>
  );
}

function LineTable({ title, description, rows, showDetails }: { title: string; description: string; rows: ReconcileLine[]; showDetails?: boolean }) {
  if (!rows.length) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title} <span className="tabular text-sm font-normal text-muted-foreground">({rows.length})</span></CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0 pb-2">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Line</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>{showDetails ? "Statement details" : "Customer"}</TableHead>
                <TableHead className="text-right">Statement amount</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, SHOW).map((l) => {
                const [label, variant] = OUTCOME[l.outcome];
                return (
                  <TableRow key={`${l.line}-${l.reference}`}>
                    <TableCell className="tabular">{l.line}</TableCell>
                    <TableCell>
                      {l.payment_id ? <Link className="text-primary hover:underline" href={`/payments/${l.payment_id}`}>{l.reference}</Link> : l.reference}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{l.date ? formatDate(l.date) : "—"}</TableCell>
                    <TableCell className="max-w-72 truncate">{showDetails ? l.details || "—" : l.customer ?? "Not linked"}</TableCell>
                    <TableCell className="tabular text-right">{l.amount !== null ? formatKsh(l.amount) : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={variant}>{label}</Badge>
                      {l.note && l.outcome !== "not_in_system" ? <p className="mt-1 text-xs text-muted-foreground">{l.note}</p> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {rows.length > SHOW ? <p className="px-6 pt-2 text-xs text-muted-foreground">First {SHOW} of {rows.length} shown.</p> : null}
      </CardContent>
    </Card>
  );
}
