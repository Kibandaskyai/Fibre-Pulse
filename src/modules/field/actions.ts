"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPermission, AuthorizationError, requireTenant } from "@/lib/auth/guards";
import type { Permission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, type ActionResult } from "@/lib/validation/common";
import { jobPlanSchema, jobSchema, jobUpdateSchema, noteSchema } from "@/lib/validation/operations";
import * as field from "./service";

async function guarded(permission: Permission | null, run: (tenantId: string, userId: string) => Promise<ActionResult>): Promise<ActionResult> {
  try {
    const ctx = permission ? await assertPermission(permission) : await requireTenant();
    return await run(ctx.active.tenantId, ctx.userId);
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
}

const refresh = (id: string) => {
  revalidatePath(`/field-operations/${id}`);
  revalidatePath("/field-operations");
};

export async function createJobAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  let id = "";
  const r = await guarded("jobs:edit", async (tenantId, userId) => {
    const parsed = jobSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await field.createJob(await createClient(), tenantId, userId, parsed.data);
    if (!res.ok) return res;
    id = res.data.id;
    if (parsed.data.ticketId) revalidatePath(`/support/${parsed.data.ticketId}`);
    return { ok: true };
  });
  if (!r.ok) return r;
  revalidatePath("/field-operations");
  redirect(`/field-operations/${id}?created=1`);
}

/** Technicians update their own jobs; supervisors any job. RLS and the database rules decide. */
export async function updateJobStatusAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded(null, async (tenantId) => {
    const parsed = jobUpdateSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
    const res = await field.updateJobStatus(await createClient(), tenantId, parsed.data.jobId, parsed.data.status, parsed.data.completionNotes);
    if (!res.ok) return res;
    refresh(parsed.data.jobId);
    return { ok: true, message: parsed.data.status === "completed" ? "Job completed. Your supervisor has been told." : "Job updated." };
  });
}

export async function planJobAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded("jobs:edit", async (tenantId) => {
    const parsed = jobPlanSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
    const res = await field.planJob(await createClient(), tenantId, parsed.data.jobId, parsed.data.technicianId, parsed.data.scheduledFor);
    if (!res.ok) return res;
    refresh(parsed.data.jobId);
    return { ok: true, message: "Plan saved." };
  });
}

export async function addJobNoteAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded(null, async () => {
    const parsed = noteSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Write a note." };
    const res = await field.addJobNote(await createClient(), parsed.data.id, parsed.data.note);
    if (!res.ok) return res;
    revalidatePath(`/field-operations/${parsed.data.id}`);
    return { ok: true, message: "Note added." };
  });
}
