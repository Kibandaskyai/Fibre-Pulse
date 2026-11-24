import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { History } from "@/components/operations/history";
import { categoryLabel, JobStatusBadge, jobTypeLabel, PriorityBadge, TicketStatusBadge } from "@/components/operations/ops-badges";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { requireTenant } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { addTicketCommentAction } from "@/modules/support/actions";
import { getTicket, staffDirectory } from "@/modules/support/service";
import { NoteForm, TicketUpdateForm } from "../ticket-forms";

export const metadata: Metadata = { title: "Ticket" };

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const ctx = await requireTenant();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await createClient();
  // RLS shows the ticket to tickets:view staff and to its assignee.
  const [detail, staff] = await Promise.all([getTicket(db, ctx.active.tenantId, id), staffDirectory(db, ctx.active.tenantId)]);
  if (!detail) notFound();
  const { ticket: t, events, jobs } = detail;
  const perms = ctx.active.permissions;
  const names = new Map(staff.map((s) => [s.profile_id, s.full_name]));
  const canEdit = perms.has("tickets:edit") || t.assigned_to === ctx.userId;

  return (
    <>
      <PageHeader
        title={t.subject}
        description={`${t.ticket_number} · ${categoryLabel(t.category)} · opened ${formatDateTime(t.created_at)}`}
        actions={
          <>
            <TicketStatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
            {perms.has("tickets:view") ? <Button asChild variant="outline" size="sm"><Link href="/support"><ArrowLeft aria-hidden /> Support desk</Link></Button> : null}
          </>
        }
      />
      <Flash success={sp.created ? "Ticket created. Staff who handle tickets have been notified." : null} />
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {t.customers ? (
                <p>
                  Customer:{" "}
                  {perms.has("customers:view") ? <Link className="font-medium hover:underline" href={`/customers/${t.customer_id}`}>{t.customers.full_name}</Link> : <span className="font-medium">{t.customers.full_name}</span>}
                  <span className="text-muted-foreground"> · {t.customers.customer_number} · <span className="tabular">{t.customers.phone}</span></span>
                </p>
              ) : <p className="text-muted-foreground">No customer linked.</p>}
              <p>Assigned to: {t.assigned_to ? (names.get(t.assigned_to) ?? "Staff member") : <span className="text-muted-foreground">nobody</span>}</p>
              {t.description ? <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2">{t.description}</p> : null}
              {t.resolution_notes ? (
                <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2">
                  <p className="text-xs font-medium text-success">Resolution{t.resolved_at ? ` · ${formatDateTime(t.resolved_at)}` : ""}</p>
                  <p className="whitespace-pre-wrap">{t.resolution_notes}</p>
                </div>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle><CardDescription>Every change and note, oldest first</CardDescription></CardHeader>
            <CardContent className="grid gap-5">
              <History events={events} names={names} kind="ticket" />
              {canEdit ? <NoteForm id={t.id} action={addTicketCommentAction} /> : null}
            </CardContent>
          </Card>
        </div>
        <div className="grid h-fit gap-6">
          {canEdit ? (
            <Card>
              <CardHeader><CardTitle>Update</CardTitle></CardHeader>
              <CardContent><TicketUpdateForm key={`${t.status}-${t.priority}-${t.assigned_to ?? ""}`} ticket={t} staff={staff} /></CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Field jobs</CardTitle>
              <CardDescription>Send a technician to the customer for this ticket.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              {jobs.length ? (
                <ul className="grid gap-2">
                  {jobs.map((j) => (
                    <li key={j.id} className="flex flex-wrap items-center gap-2">
                      {perms.has("jobs:view") ? <Link className="font-medium hover:underline" href={`/field-operations/${j.id}`}>{j.job_number}</Link> : <span className="font-medium">{j.job_number}</span>}
                      <span className="text-muted-foreground">{jobTypeLabel(j.job_type)}</span>
                      <JobStatusBadge status={j.status} />
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted-foreground">No jobs yet.</p>}
              {perms.has("jobs:edit") ? (
                <div>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/field-operations/new?ticket=${t.id}${t.customer_id ? `&customer=${t.customer_id}` : ""}&type=${t.category === "installation_request" ? "installation" : "fault_investigation"}`}>
                      <Wrench aria-hidden /> Create job
                    </Link>
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
