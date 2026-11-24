/**
 * Field operations: installation, maintenance, replacement, disconnection
 * and fault jobs. Technicians see and progress only their own jobs (RLS).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobFilters, JobInput } from "@/lib/validation/operations";
import { friendlyDbError } from "@/lib/validation/db-errors";

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };
export const JOB_PAGE_SIZE = 25;

export type JobRow = {
  id: string; job_number: string; job_type: string; status: string; scheduled_for: string | null; started_at: string | null; completed_at: string | null;
  address: string | null; notes: string | null; completion_notes: string | null; created_at: string; customer_id: string | null; ticket_id: string | null;
  technician_id: string | null; customers: { full_name: string; customer_number: string; phone: string; estate: string | null; town: string | null } | null;
  support_tickets: { ticket_number: string; subject: string } | null;
};
const COLUMNS =
  "id, job_number, job_type, status, scheduled_for, started_at, completed_at, address, notes, completion_notes, created_at, customer_id, ticket_id, technician_id, customers(full_name, customer_number, phone, estate, town), support_tickets(ticket_number, subject)";

export type Technician = { technician_id: string; profile_id: string; full_name: string; zone: string | null; phone: string | null; open_jobs: number };

export async function technicianDirectory(db: SupabaseClient, tenantId: string): Promise<Technician[]> {
  const { data } = await db.rpc("technician_directory", { p_tenant: tenantId });
  return ((data ?? []) as Technician[]).map((t) => ({ ...t, open_jobs: Number(t.open_jobs) }));
}

export async function myTechnicianId(db: SupabaseClient, tenantId: string, userId: string) {
  const { data } = await db.from("technicians").select("id").eq("tenant_id", tenantId).eq("profile_id", userId).eq("active", true).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

export async function listJobs(db: SupabaseClient, tenantId: string, f: JobFilters, onlyTechnician: string | null, pageSize = JOB_PAGE_SIZE) {
  let q = db.from("installation_jobs").select(COLUMNS, { count: "exact" }).eq("tenant_id", tenantId);
  if (f.status === "active") q = q.in("status", ["scheduled", "in_progress", "on_hold"]);
  else if (f.status !== "all") q = q.eq("status", f.status);
  if (f.type) q = q.eq("job_type", f.type);
  const tech = onlyTechnician ?? f.technician;
  if (tech) q = q.eq("technician_id", tech);
  const from = (f.page - 1) * pageSize;
  const { data, count } = await q.order("scheduled_for", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }).range(from, from + pageSize - 1);
  return { rows: (data ?? []) as unknown as JobRow[], total: count ?? 0 };
}

export type JobEvent = { id: string; event_type: string; from_value: string | null; to_value: string | null; note: string | null; actor_id: string | null; created_at: string };

export async function getJob(db: SupabaseClient, tenantId: string, id: string) {
  const { data } = await db.from("installation_jobs").select(COLUMNS).eq("tenant_id", tenantId).eq("id", id).maybeSingle();
  if (!data) return null;
  const job = data as unknown as JobRow;
  const [events, location] = await Promise.all([
    db.from("job_events").select("id, event_type, from_value, to_value, note, actor_id, created_at").eq("job_id", id).order("created_at"),
    job.customer_id ? db.from("customer_locations").select("latitude, longitude").eq("customer_id", job.customer_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const loc = location.data as { latitude: number; longitude: number } | null;
  return { job, events: (events.data ?? []) as JobEvent[], location: loc ? { latitude: Number(loc.latitude), longitude: Number(loc.longitude) } : null };
}

export async function createJob(db: SupabaseClient, tenantId: string, userId: string, input: JobInput): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("installation_jobs")
    .insert({
      tenant_id: tenantId,
      customer_id: input.customerId,
      ticket_id: input.ticketId,
      technician_id: input.technicianId,
      job_type: input.jobType,
      scheduled_for: input.scheduledFor,
      address: input.address,
      notes: input.notes,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, message: friendlyDbError(error, "Could not create the job.") };
  return { ok: true, data: { id: data.id } };
}

async function patchJob(db: SupabaseClient, tenantId: string, id: string, patch: Record<string, unknown>, fallback: string): Promise<Result<null>> {
  const { data, error } = await db.from("installation_jobs").update(patch).eq("tenant_id", tenantId).eq("id", id).select("id");
  if (error) return { ok: false, message: friendlyDbError(error, fallback) };
  if (!data?.length) return { ok: false, message: "Job not found or you cannot change it." };
  return { ok: true, data: null };
}

export const updateJobStatus = (db: SupabaseClient, tenantId: string, id: string, status: string, completionNotes: string | null) =>
  patchJob(db, tenantId, id, completionNotes !== null ? { status, completion_notes: completionNotes } : { status }, "Could not update the job.");

export const planJob = (db: SupabaseClient, tenantId: string, id: string, technicianId: string | null, scheduledFor: string | null) =>
  patchJob(db, tenantId, id, { technician_id: technicianId, scheduled_for: scheduledFor }, "Could not save the plan.");

export async function addJobNote(db: SupabaseClient, id: string, note: string): Promise<Result<null>> {
  const { error } = await db.rpc("add_job_note", { p_job: id, p_note: note });
  if (error) return { ok: false, message: friendlyDbError(error, "Could not add the note.") };
  return { ok: true, data: null };
}
