import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, MapPin, Phone, Plus, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { JobStatusBadge, jobTypeLabel } from "@/components/operations/ops-badges";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { JOB_STATUSES, JOB_TYPES, jobFiltersSchema } from "@/lib/validation/operations";
import { JOB_PAGE_SIZE, listJobs, myTechnicianId, technicianDirectory, type JobRow } from "@/modules/field/service";
import { requireFieldAccess } from "./access";

export const metadata: Metadata = { title: "Field Operations" };

const overdue = (j: JobRow) => j.scheduled_for && j.status === "scheduled" && Date.parse(j.scheduled_for) < Date.now();

export default async function FieldOperationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx, supervisor, canPlan } = await requireFieldAccess();
  const f = jobFiltersSchema.parse(await searchParams);
  const db = await createClient();
  const tenantId = ctx.active.tenantId;
  const mine = supervisor ? null : await myTechnicianId(db, tenantId, ctx.userId);
  const [{ rows, total }, technicians] = await Promise.all([
    listJobs(db, tenantId, f, supervisor ? null : (mine ?? "00000000-0000-0000-0000-000000000000")),
    supervisor ? technicianDirectory(db, tenantId) : Promise.resolve([]),
  ]);
  const techName = new Map(technicians.map((t) => [t.technician_id, t.full_name]));
  const params = { status: f.status, type: f.type, technician: f.technician };

  const filters = (
    <form className="mb-4 grid gap-2 sm:grid-cols-[12rem_14rem_14rem_auto] sm:justify-start" role="search">
      <NativeSelect name="status" defaultValue={f.status} aria-label="Status">
        <option value="active">Open jobs</option>
        {JOB_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        <option value="all">All</option>
      </NativeSelect>
      <NativeSelect name="type" defaultValue={f.type} aria-label="Kind of job">
        <option value="">Any kind</option>
        {JOB_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </NativeSelect>
      {supervisor ? (
        <NativeSelect name="technician" defaultValue={f.technician} aria-label="Technician">
          <option value="">Any technician</option>
          {technicians.map((t) => <option key={t.technician_id} value={t.technician_id}>{t.full_name}</option>)}
        </NativeSelect>
      ) : null}
      <Button type="submit" variant="outline">Filter</Button>
    </form>
  );

  if (!supervisor) {
    return (
      <>
        <PageHeader title="My jobs" description="Installations and visits assigned to you. Open a job to start it, add notes and record the work when you finish." />
        {filters}
        {!mine ? (
          <EmptyState icon={<Wrench />} title="You are not set up as a technician" description="Ask the ISP owner to check your role." />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Wrench />} title="No jobs here" description="New jobs appear here and in your notifications." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2" data-testid="my-jobs">
            {rows.map((j) => (
              <Link key={j.id} href={`/field-operations/${j.id}`} className="group">
                <Card className="h-full transition-colors group-hover:border-primary/50">
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="mr-auto text-base">{jobTypeLabel(j.job_type)}</CardTitle>
                      <JobStatusBadge status={j.status} />
                    </div>
                    <CardDescription className="tabular">{j.job_number}</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-1.5 text-sm">
                    <p className="font-medium">{j.customers?.full_name ?? "Network work"}</p>
                    {j.customers ? <p className="flex items-center gap-1.5 text-muted-foreground"><Phone className="size-3.5" aria-hidden /> <span className="tabular">{j.customers.phone}</span></p> : null}
                    <p className="flex items-center gap-1.5 text-muted-foreground"><MapPin className="size-3.5" aria-hidden /> {j.address ?? ([j.customers?.estate, j.customers?.town].filter(Boolean).join(", ") || "No address")}</p>
                    <p className={`flex items-center gap-1.5 ${overdue(j) ? "text-warning" : "text-muted-foreground"}`}>
                      <CalendarClock className="size-3.5" aria-hidden /> {j.scheduled_for ? formatDateTime(j.scheduled_for) : "No time set"}{overdue(j) ? " · overdue" : ""}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
        <Pagination path="/field-operations" params={params} page={f.page} pageSize={JOB_PAGE_SIZE} total={total} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Field operations"
        description="Installations, maintenance visits, equipment replacement, disconnections and fault investigations."
        actions={canPlan ? <Button asChild size="sm"><Link href="/field-operations/new"><Plus aria-hidden /> New job</Link></Button> : null}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
        <div className="min-w-0">
          {filters}
          <Card>
            <CardContent className="p-0">
              {rows.length === 0 ? (
                <EmptyState className="m-5" icon={<Wrench />} title="No jobs match" description={canPlan ? "Create a job, or create one from a support ticket." : undefined} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Job</TableHead>
                      <TableHead className="hidden md:table-cell">Customer</TableHead>
                      <TableHead>Technician</TableHead>
                      <TableHead className="hidden sm:table-cell">Visit</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((j) => (
                      <TableRow key={j.id}>
                        <TableCell>
                          <Link href={`/field-operations/${j.id}`} className="font-medium hover:underline">{jobTypeLabel(j.job_type)}</Link>
                          <p className="text-xs text-muted-foreground tabular">{j.job_number}{j.support_tickets ? ` · ${j.support_tickets.ticket_number}` : ""}</p>
                        </TableCell>
                        <TableCell className="hidden text-sm md:table-cell">{j.customers?.full_name ?? <span className="text-muted-foreground">Network work</span>}</TableCell>
                        <TableCell className="text-sm">{j.technician_id ? (techName.get(j.technician_id) ?? "Technician") : <span className="text-warning">Not assigned</span>}</TableCell>
                        <TableCell className={`hidden text-sm sm:table-cell ${overdue(j) ? "text-warning" : ""}`}>{j.scheduled_for ? formatDateTime(j.scheduled_for) : "—"}{overdue(j) ? " · overdue" : ""}</TableCell>
                        <TableCell><JobStatusBadge status={j.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <Pagination path="/field-operations" params={params} page={f.page} pageSize={JOB_PAGE_SIZE} total={total} />
            </CardContent>
          </Card>
        </div>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Technicians</CardTitle>
            <CardDescription>Open jobs each</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {technicians.length ? technicians.map((t) => (
              <Link key={t.technician_id} href={`/field-operations?technician=${t.technician_id}`} className="flex items-center justify-between gap-2 hover:underline">
                <span className="min-w-0 truncate">{t.full_name}{t.zone ? <span className="text-muted-foreground"> · {t.zone}</span> : null}</span>
                <span className="tabular">{t.open_jobs}</span>
              </Link>
            )) : <p className="text-muted-foreground">No technicians yet. Invite staff with the Field Technician role in Settings, Staff.</p>}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
