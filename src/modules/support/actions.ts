"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPermission, AuthorizationError, requireTenant } from "@/lib/auth/guards";
import type { Permission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { fieldErrorsOf, type ActionResult } from "@/lib/validation/common";
import { noteSchema, ticketSchema, ticketUpdateSchema } from "@/lib/validation/operations";
import * as support from "./service";

async function guarded(permission: Permission | null, run: (tenantId: string, userId: string) => Promise<ActionResult>): Promise<ActionResult> {
  try {
    const ctx = permission ? await assertPermission(permission) : await requireTenant();
    return await run(ctx.active.tenantId, ctx.userId);
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function createTicketAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  let id = "";
  const r = await guarded("tickets:edit", async (tenantId, userId) => {
    const parsed = ticketSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const res = await support.createTicket(await createClient(), tenantId, userId, parsed.data);
    if (!res.ok) return res;
    id = res.data.id;
    return { ok: true };
  });
  if (!r.ok) return r;
  revalidatePath("/support");
  redirect(`/support/${id}?created=1`);
}

/** Status, priority and assignment. The assignee may update their own ticket (RLS decides). */
export async function updateTicketAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded(null, async (tenantId) => {
    const parsed = ticketUpdateSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the form." };
    const { ticketId, ...patch } = parsed.data;
    const res = await support.updateTicket(await createClient(), tenantId, ticketId, patch);
    if (!res.ok) return res;
    revalidatePath(`/support/${ticketId}`);
    revalidatePath("/support");
    return { ok: true, message: "Ticket saved." };
  });
}

export async function addTicketCommentAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return guarded(null, async () => {
    const parsed = noteSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Write a note." };
    const res = await support.addTicketComment(await createClient(), parsed.data.id, parsed.data.note);
    if (!res.ok) return res;
    revalidatePath(`/support/${parsed.data.id}`);
    return { ok: true, message: "Note added." };
  });
}
