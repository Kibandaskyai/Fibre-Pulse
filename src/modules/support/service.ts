/**
 * Support desk. Tickets are written under RLS; status bookkeeping, history
 * and notifications happen in the database (migration 20261127000100).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TicketFilters, TicketInput } from "@/lib/validation/operations";
import { friendlyDbError } from "@/lib/validation/db-errors";
import { safeSearchTerm } from "@/modules/customers/service";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };
export const TICKET_PAGE_SIZE = 25;

export type TicketRow = {
  id: string; ticket_number: string; category: string; priority: string; status: string; subject: string; description: string | null;
  assigned_to: string | null; resolution_notes: string | null; resolved_at: string | null; closed_at: string | null; created_at: string; updated_at: string;
  customer_id: string | null; created_by: string | null; customers: { full_name: string; customer_number: string; phone: string } | null;
};
const COLUMNS =
  "id, ticket_number, category, priority, status, subject, description, assigned_to, resolution_notes, resolved_at, closed_at, created_at, updated_at, customer_id, created_by, customers(full_name, customer_number, phone)";

export async function staffDirectory(db: SupabaseClient, tenantId: string) {
  const { data } = await db.rpc("staff_directory", { p_tenant: tenantId });
  return (data ?? []) as { profile_id: string; full_name: string; role: string }[];
}

export async function listTickets(db: SupabaseClient, tenantId: string, userId: string, f: TicketFilters, pageSize = TICKET_PAGE_SIZE) {
  let q = db.from("support_tickets").select(COLUMNS, { count: "exact" }).eq("tenant_id", tenantId);
  if (f.status === "active") q = q.in("status", ["open", "assigned", "in_progress"]);
  else if (f.status !== "all") q = q.eq("status", f.status);
  if (f.category) q = q.eq("category", f.category);
  if (f.priority) q = q.eq("priority", f.priority);
  if (f.mine) q = q.eq("assigned_to", userId);
  const term = safeSearchTerm(f.q);
  if (term) q = q.or(`ticket_number.ilike.*${term}*,subject.ilike.*${term}*`);
  const from = (f.page - 1) * pageSize;
  const { data, count } = await q
    .order("status", { ascending: true })
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  return { rows: (data ?? []) as unknown as TicketRow[], total: count ?? 0 };
}

export async function ticketCounts(db: SupabaseClient, tenantId: string) {
  const { data } = await db.from("support_tickets").select("status, priority, created_at, resolved_at").eq("tenant_id", tenantId);
  const rows = data ?? [];
  const active = rows.filter((r) => ["open", "assigned", "in_progress"].includes(r.status));
  const resolved30 = rows.filter((r) => r.resolved_at && Date.now() - Date.parse(r.resolved_at) < 30 * 86400_000);
  const hours = resolved30.map((r) => (Date.parse(r.resolved_at!) - Date.parse(r.created_at)) / 3600_000);
  return {
    open: active.length,
    unassigned: active.filter((r) => r.status === "open").length,
    urgent: active.filter((r) => r.priority === "urgent" || r.priority === "high").length,
    resolved30: resolved30.length,
    medianHours: hours.length ? hours.sort((a, b) => a - b)[Math.floor(hours.length / 2)] : null,
  };
}

export type TicketEvent = { id: string; event_type: string; from_value: string | null; to_value: string | null; note: string | null; actor_id: string | null; created_at: string };

export async function getTicket(db: SupabaseClient, tenantId: string, id: string) {
  const { data } = await db.from("support_tickets").select(COLUMNS).eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!data) return null;
  const [events, jobs] = await Promise.all([
    db.from("ticket_events").select("id, event_type, from_value, to_value, note, actor_id, created_at").eq("ticket_id", id).order("created_at"),
    db.from("installation_jobs").select("id, job_number, job_type, status, scheduled_for, technician_id").eq("ticket_id", id).order("created_at"),
  ]);
  return {
    ticket: data as unknown as TicketRow,
    events: (events.data ?? []) as TicketEvent[],
    jobs: (jobs.data ?? []) as { id: string; job_number: string; job_type: string; status: string; scheduled_for: string | null; technician_id: string | null }[],
  };
}

export async function createTicket(db: SupabaseClient, tenantId: string, userId: string, input: TicketInput): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("support_tickets")
    .insert({
      tenant_id: tenantId,
      customer_id: input.customerId,
      category: input.category,
      priority: input.priority,
      subject: input.subject,
      description: input.description,
      assigned_to: input.assignedTo,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, message: friendlyDbError(error, "Could not create the ticket.") };
  return { ok: true, data: { id: data.id } };
}

export async function updateTicket(
  db: SupabaseClient,
  tenantId: string,
  id: string,
  patch: { status: string; priority: string; assignedTo: string | null; resolutionNotes: string | null },
): Promise<Result<null>> {
  const { data, error } = await db
    .from("support_tickets")
    .update({ status: patch.status, priority: patch.priority, assigned_to: patch.assignedTo, resolution_notes: patch.resolutionNotes })
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, message: friendlyDbError(error, "Could not save the ticket.") };
  if (!data?.length) return { ok: false, message: "Ticket not found or you cannot change it." };
  return { ok: true, data: null };
}

export async function addTicketComment(db: SupabaseClient, id: string, note: string): Promise<Result<null>> {
  const { error } = await db.rpc("add_ticket_comment", { p_ticket: id, p_note: note });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not add the note.") };
  return { ok: true, data: null };
}

/** Customers for the ticket and job pickers (name and number only). */
export async function customerOptions(db: SupabaseClient, tenantId: string) {
  const { data } = await db.from("customers").select("id, full_name, customer_number").eq("tenant_id", tenantId).neq("status", "terminated").order("full_name").limit(2000);
  return (data ?? []) as { id: string; full_name: string; customer_number: string }[];
}
