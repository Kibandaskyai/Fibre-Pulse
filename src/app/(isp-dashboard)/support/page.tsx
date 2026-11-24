import type { Metadata } from "next";
import Link from "next/link";
import { LifeBuoy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { categoryLabel, PriorityBadge, TicketStatusBadge } from "@/components/operations/ops-badges";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiCard } from "@/components/shared/kpi-card";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { requirePagePermission } from "@/lib/auth/guards";
import { timeAgo } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES, ticketFiltersSchema } from "@/lib/validation/operations";
import { listTickets, staffDirectory, TICKET_PAGE_SIZE, ticketCounts } from "@/modules/support/service";

export const metadata: Metadata = { title: "Support Desk" };

export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePagePermission("tickets:view");
  const f = ticketFiltersSchema.parse(await searchParams);
  const db = await createClient();
  const tenantId = ctx.active.tenantId;
  const [{ rows, total }, counts, staff] = await Promise.all([listTickets(db, tenantId, ctx.userId, f), ticketCounts(db, tenantId), staffDirectory(db, tenantId)]);
  const names = new Map(staff.map((s) => [s.profile_id, s.full_name]));
  const canEdit = ctx.active.permissions.has("tickets:edit");

  return (
    <>
      <PageHeader
        title="Support desk"
        description="Customer complaints and requests, from first call to resolution. Every change is kept in the ticket's history."
        actions={canEdit ? <Button asChild size="sm"><Link href="/support/new"><Plus aria-hidden /> New ticket</Link></Button> : null}
      />
      <section aria-label="Ticket summary" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Open tickets" value={String(counts.open)} href="/support" />
        <KpiCard label="Not assigned" value={String(counts.unassigned)} tone={counts.unassigned ? "warning" : undefined} href="/support?status=open" />
        <KpiCard label="High or urgent" value={String(counts.urgent)} tone={counts.urgent ? "danger" : undefined} href="/support?priority=urgent" />
        <KpiCard
          label="Resolved, last 30 days"
          value={String(counts.resolved30)}
          hint={counts.medianHours === null ? "No resolutions yet" : `Typical time to resolve: ${counts.medianHours < 24 ? `${Math.round(counts.medianHours)} h` : `${(counts.medianHours / 24).toFixed(1)} days`}`}
        />
      </section>

      <form className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_11rem_12rem_9rem_auto_auto]" role="search">
        <Input name="q" defaultValue={f.q} placeholder="Ticket number or subject" aria-label="Search tickets" />
        <NativeSelect name="status" defaultValue={f.status} aria-label="Status">
          <option value="active">Not resolved</option>
          {TICKET_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          <option value="all">All</option>
        </NativeSelect>
        <NativeSelect name="category" defaultValue={f.category} aria-label="Issue">
          <option value="">Any issue</option>
          {TICKET_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </NativeSelect>
        <NativeSelect name="priority" defaultValue={f.priority} aria-label="Priority">
          <option value="">Any priority</option>
          {TICKET_PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </NativeSelect>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="mine" value="1" defaultChecked={f.mine === "1"} className="size-4" /> Mine
        </label>
        <Button type="submit" variant="outline">Filter</Button>
      </form>

      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <EmptyState className="m-5" icon={<LifeBuoy />} title="No tickets match" description={canEdit ? "Create a ticket when a customer calls or messages with a problem." : undefined} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ticket</TableHead>
                  <TableHead className="hidden md:table-cell">Customer</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Assigned</TableHead>
                  <TableHead className="hidden sm:table-cell">Opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link href={`/support/${t.id}`} className="font-medium hover:underline">{t.subject}</Link>
                      <p className="text-xs text-muted-foreground"><span className="tabular">{t.ticket_number}</span> · {categoryLabel(t.category)}</p>
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{t.customers?.full_name ?? <span className="text-muted-foreground">No customer</span>}</TableCell>
                    <TableCell><PriorityBadge priority={t.priority} /></TableCell>
                    <TableCell><TicketStatusBadge status={t.status} /></TableCell>
                    <TableCell className="hidden text-sm lg:table-cell">{t.assigned_to ? (names.get(t.assigned_to) ?? "Staff member") : <span className="text-muted-foreground">Nobody</span>}</TableCell>
                    <TableCell className="hidden text-sm sm:table-cell">{timeAgo(t.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pagination path="/support" params={{ q: f.q, status: f.status, category: f.category, priority: f.priority, mine: f.mine }} page={f.page} pageSize={TICKET_PAGE_SIZE} total={total} />
        </CardContent>
      </Card>
    </>
  );
}
