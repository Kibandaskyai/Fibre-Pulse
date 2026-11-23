"use client";
import Link from "next/link";
import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubmitButton } from "@/components/shared/form-bits";
import { importCustomersAction, type ImportState } from "@/modules/customers/actions";

export function ImportForm() {
  const [state, action] = useActionState<ImportState, FormData>(importCustomersAction, null);

  if (state?.stage === "done") {
    return (
      <Card>
        <CardContent className="grid gap-4 pt-5">
          <Alert variant="success"><AlertDescription className="text-foreground">{state.inserted} customers imported.</AlertDescription></Alert>
          <div className="flex gap-2">
            <Button asChild><Link href="/customers">View customers</Link></Button>
            <Button asChild variant="outline"><Link href="/customers/import">Import another file</Link></Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const report = state?.stage === "checked" ? state.report : state?.stage === "error" ? state.report : undefined;
  const csv = state?.stage === "checked" ? state.csv : state?.stage === "error" ? state.csv : undefined;
  const problems = report?.rows.filter((r) => !r.ok) ?? [];

  return (
    <div className="grid gap-6">
      <Card>
        <CardContent className="pt-5">
          <form action={action} className="grid gap-3">
            <input type="hidden" name="step" value="check" />
            <Label htmlFor="csv-file">CSV file</Label>
            <Input id="csv-file" name="file" type="file" accept=".csv,text/csv" required />
            <div><SubmitButton variant="secondary" pendingText="Checking…">Check file</SubmitButton></div>
          </form>
          {state?.stage === "error" ? (
            <Alert variant="danger" className="mt-4"><AlertDescription className="text-foreground">{state.message}</AlertDescription></Alert>
          ) : null}
        </CardContent>
      </Card>

      {report && csv ? (
        <Card>
          <CardHeader>
            <CardTitle>Check results</CardTitle>
            <p className="text-sm text-muted-foreground">
              <span className="text-success">{report.valid} ready to import</span> · <span className={report.invalid ? "text-warning" : ""}>{report.invalid} with problems</span>
            </p>
          </CardHeader>
          <CardContent className="grid gap-4">
            {problems.length ? (
              <div className="max-h-96 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead className="w-16">Line</TableHead><TableHead>Name</TableHead><TableHead>Problem</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {problems.map((r) => (
                      <TableRow key={r.line}>
                        <TableCell className="tabular">{r.line}</TableCell>
                        <TableCell>{!r.ok ? r.raw.full_name || "—" : null}</TableCell>
                        <TableCell className="text-warning">{!r.ok ? r.errors.join(" ") : null}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
            {report.valid > 0 ? (
              <form action={action}>
                <input type="hidden" name="step" value="import" />
                <input type="hidden" name="csv" value={csv} />
                <SubmitButton pendingText="Importing…">Import {report.valid} customers</SubmitButton>
              </form>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
