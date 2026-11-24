import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MapPin, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { History } from "@/components/operations/history";
import { JobStatusBadge, jobTypeLabel } from "@/components/operations/ops-badges";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { formatDateTime, isoToKenyaLocal } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { addJobNoteAction } from "@/modules/field/actions";
import { getJob, technicianDirectory } from "@/modules/field/service";
import { staffDirectory } from "@/modules/support/service";
import { NoteForm } from "../../support/ticket-forms";
import { requireFieldAccess } from "../access";
import { JobPlanForm, JobStatusForm } from "../job-forms";

export const metadata: Metadata = { title: "Job" };

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { ctx, supervisor, canPlan } = await requireFieldAccess();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await createClient();
  const [detail, technicians, staff] = await Promise.all([
    getJob(db, ctx.active.tenantId, id),
    supervisor ? technicianDirectory(db, ctx.active.tenantId) : Promise.resolve([]),
    staffDirectory(db, ctx.active.tenantId),
  ]);
  if (!detail) notFound();
  const { job: j, events, location } = detail;
  const perms = ctx.active.permissions;
  const names = new Map(staff.map((s) => [s.profile_id, s.full_name]));
  for (const t of technicians) names.set(t.technician_id, t.full_name);
  const tech = technicians.find((t) => t.technician_id === j.technician_id);
  const where = j.address ?? ([j.customers?.estate, j.customers?.town].filter(Boolean).join(", ") || null);

  return (
    <>
      <PageHeader
        title={`${jobTypeLabel(j.job_type)}${j.customers ? ` for ${j.customers.full_name}` : ""}`}
        description={`${j.job_number}${j.support_tickets ? ` · ticket ${j.support_tickets.ticket_number}` : ""} · created ${formatDateTime(j.created_at)}`}
        actions={
          <>
            <JobStatusBadge status={j.status} />
            <Button asChild variant="outline" size="sm"><Link href="/field-operations"><ArrowLeft aria-hidden /> {supervisor ? "All jobs" : "My jobs"}</Link></Button>
          </>
        }
      />
      <Flash success={sp.created ? "Job created. The technician has been notified." : null} />
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader><CardTitle>Visit</CardTitle></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {j.customers ? (
                <>
                  <p className="font-medium">
                    {perms.has("customers:view") ? <Link className="hover:underline" href={`/customers/${j.customer_id}`}>{j.customers.full_name}</Link> : j.customers.full_name}
                    <span className="font-normal text-muted-foreground"> · {j.customers.customer_number}</span>
                  </p>
                  <p className="flex items-center gap-1.5"><Phone className="size-3.5" aria-hidden /> <a className="tabular hover:underline" href={`tel:${j.customers.phone}`}>{j.customers.phone}</a></p>
                </>
              ) : <p className="text-muted-foreground">Network work, no customer.</p>}
              <p className="flex items-center gap-1.5"><MapPin className="size-3.5" aria-hidden /> {where ?? <span className="text-muted-foreground">No address</span>}</p>
              {location ? (
                <a className="text-primary hover:underline" href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=18/${location.latitude}/${location.longitude}`} target="_blank" rel="noreferrer">
                  Open the customer&apos;s location in a map
                </a>
              ) : null}
              <p>When: {j.scheduled_for ? formatDateTime(j.scheduled_for) : <span className="text-muted-foreground">not set</span>}</p>
              <p>Technician: {j.technician_id ? (names.get(j.technician_id) ?? (supervisor ? "Technician" : "You")) : <span className="text-warning">not assigned</span>}</p>
              {j.started_at ? <p className="text-muted-foreground">Started {formatDateTime(j.started_at)}</p> : null}
              {j.completed_at ? <p className="text-muted-foreground">Completed {formatDateTime(j.completed_at)}</p> : null}
              {j.notes ? <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2">{j.notes}</p> : null}
              {j.support_tickets && perms.has("tickets:view") ? <Link className="text-primary hover:underline" href={`/support/${j.ticket_id}`}>Ticket: {j.support_tickets.subject}</Link> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History and notes</CardTitle></CardHeader>
            <CardContent className="grid gap-5">
              <History events={events} names={names} kind="job" />
              <NoteForm id={j.id} action={addJobNoteAction} />
            </CardContent>
          </Card>
        </div>
        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Progress</CardTitle>
              <CardDescription>Start the job when you arrive. Completing it tells your supervisor.</CardDescription>
            </CardHeader>
            <CardContent><JobStatusForm key={j.status} job={j} isSupervisor={supervisor && canPlan} /></CardContent>
          </Card>
          {canPlan ? (
            <Card>
              <CardHeader><CardTitle>Plan</CardTitle><CardDescription>{tech ? `${tech.full_name} has ${tech.open_jobs} open jobs` : "Choose who goes and when"}</CardDescription></CardHeader>
              <CardContent><JobPlanForm key={`${j.technician_id ?? ""}-${j.scheduled_for ?? ""}`} job={j} technicians={technicians} scheduledLocal={isoToKenyaLocal(j.scheduled_for)} /></CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
