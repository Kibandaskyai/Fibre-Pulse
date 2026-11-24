import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BarList } from "@/components/charts/bar-list";
import { PageHeader } from "@/components/shared/page-header";
import { RangeFilter } from "@/components/shared/range-filter";
import { requireTenant } from "@/lib/auth/guards";
import { resolveRange } from "@/lib/date-range";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { customerAreas } from "@/modules/analytics/service";
import { biDefinition, biPeriodText, canOpen, loadBiReport, type BiSection } from "@/modules/reports/bi";

type Params = { report: string };
type Search = { range?: string; from?: string; to?: string; area?: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const def = biDefinition((await params).report);
  return { title: def ? def.title : "Report" };
}

export default async function BiReportPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Search> }) {
  const [{ report }, sp, ctx] = await Promise.all([params, searchParams, requireTenant()]);
  const def = biDefinition(report);
  if (!def) notFound();
  if (!canOpen(def, ctx.active.permissions)) redirect("/not-allowed");

  const range = resolveRange(sp, "this_month");
  const area = def.area ? (sp.area ?? "").slice(0, 80) : "";
  const db = await createClient();
  const [result, areas] = await Promise.all([
    loadBiReport(db, def.key, { tenantId: ctx.active.tenantId, tenantName: ctx.active.tenantName, range, area }),
    def.area && ctx.active.permissions.has("customers:view") ? customerAreas(db, ctx.active.tenantId) : Promise.resolve(undefined),
  ]);
  const query = new URLSearchParams({ range: range.key, from: range.from, to: range.to, ...(area ? { area } : {}) }).toString();
  const download = `/reports/bi/${def.key}/export?${query}`;

  return (
    <>
      <Link href="/reports" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All reports
      </Link>
      <PageHeader
        title={def.title}
        description={def.summary}
        actions={
          <>
            <Button asChild variant="outline"><Link href={`${download}&format=pdf`} prefetch={false}><FileText aria-hidden /> PDF</Link></Button>
            <Button asChild variant="outline"><Link href={`${download}&format=csv`} prefetch={false}><Download aria-hidden /> CSV</Link></Button>
          </>
        }
      />
      <RangeFilter path={`/reports/bi/${def.key}`} range={range} area={area} areas={areas} />

      {!result.ok ? (
        <p className="text-sm text-danger" role="alert">{result.message}</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {biPeriodText(result.data)}{def.area ? ` · ${result.data.area ?? "All areas"}` : ""}
          </p>
          <dl className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="bi-figures">
            {result.data.figures.map((f) => (
              <div key={f.label} className="rounded-md border bg-card p-3">
                <dt className="text-xs text-muted-foreground">{f.label}</dt>
                <dd className="tabular text-lg font-semibold">{f.value}</dd>
                {f.hint ? <dd className="text-xs text-muted-foreground">{f.hint}</dd> : null}
              </div>
            ))}
          </dl>

          <div className="mb-6 grid gap-6">
            {result.data.sections.map((s) => <SectionTable key={s.title} section={s} />)}
            {result.data.bars ? (
              <Card>
                <CardHeader><CardTitle>{result.data.bars.title}</CardTitle></CardHeader>
                <CardContent>
                  <BarList rows={result.data.bars.rows} format={result.data.bars.format} emptyText={result.data.bars.empty} />
                </CardContent>
              </Card>
            ) : null}
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">How these figures are worked out</CardTitle>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {result.data.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            </CardHeader>
          </Card>
        </>
      )}
    </>
  );
}

function SectionTable({ section }: { section: BiSection }) {
  return (
    <Card>
      <CardHeader><CardTitle>{section.title}</CardTitle></CardHeader>
      <CardContent>
        {section.rows.length ? (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {section.columns.map((c) => <TableHead key={c.header} className={cn("whitespace-nowrap", c.align === "right" && "text-right")}>{c.header}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {section.rows.map((row, i) => (
                  <TableRow key={`${row[0]}-${i}`}>
                    {row.map((cell, ci) => (
                      <TableCell key={ci} className={cn(section.columns[ci]?.align === "right" && "tabular text-right whitespace-nowrap", ci === 0 && "font-medium")}>{cell}</TableCell>
                    ))}
                  </TableRow>
                ))}
                {section.totals ? (
                  <TableRow className="bg-muted/40 font-semibold">
                    {section.totals.map((cell, ci) => (
                      <TableCell key={ci} className={cn(section.columns[ci]?.align === "right" && "tabular text-right whitespace-nowrap")}>{cell}</TableCell>
                    ))}
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{section.empty}</p>
        )}
        {section.note ? <p className="mt-2 text-xs text-muted-foreground">{section.note}</p> : null}
      </CardContent>
    </Card>
  );
}
