"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertPermission, AuthorizationError } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { customerSchema } from "@/lib/validation/billing";
import { fieldErrorsOf, type ActionResult } from "@/lib/validation/common";
import { buildImportReport, type ImportReport } from "./csv";
import * as customers from "./service";

function denied(e: unknown): ActionResult {
  if (e instanceof AuthorizationError) return { ok: false, message: e.message };
  throw e;
}

export async function createCustomerAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  let id: string;
  let warning: string | null;
  try {
    const ctx = await assertPermission("customers:edit");
    const parsed = customerSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const result = await customers.createCustomer(
      await createClient(),
      ctx.active.tenantId,
      ctx.userId,
      parsed.data,
      ctx.active.permissions.has("customers:view_location"),
    );
    if (!result.ok) return { ok: false, message: result.message };
    ({ id, warning } = result.data);
  } catch (e) {
    return denied(e);
  }
  revalidatePath("/customers");
  redirect(`/customers/${id}?${warning ? `error=${encodeURIComponent(warning)}` : "created=1"}`);
}

export async function updateCustomerAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await assertPermission("customers:edit");
    const id = z.uuid().safeParse(formData.get("id"));
    if (!id.success) return { ok: false, message: "Customer not found." };
    const parsed = customerSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return { ok: false, message: "Check the form.", fieldErrors: fieldErrorsOf(parsed.error) };
    const result = await customers.updateCustomer(
      await createClient(),
      ctx.active.tenantId,
      id.data,
      parsed.data,
      ctx.active.permissions.has("customers:view_location"),
    );
    if (!result.ok) return { ok: false, message: result.message };
    revalidatePath(`/customers/${id.data}`);
    return { ok: true, message: result.data.warning ?? "Customer saved." };
  } catch (e) {
    return denied(e);
  }
}

export type ImportState =
  | null
  | { stage: "checked"; csv: string; report: ImportReport }
  | { stage: "done"; inserted: number }
  | { stage: "error"; message: string; csv?: string; report?: ImportReport };

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Two steps: "check" validates the file and returns a duplicate report
 * without writing anything; "import" re-validates the same text and inserts
 * only the valid rows.
 */
export async function importCustomersAction(_prev: ImportState, formData: FormData): Promise<ImportState> {
  try {
    const ctx = await assertPermission("customers:edit");
    const step = formData.get("step");
    let csv = String(formData.get("csv") ?? "");
    const file = formData.get("file");
    if (step === "check" && file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) return { stage: "error", message: "The file is larger than 2 MB. Split it into smaller files." };
      csv = await file.text();
    }
    if (!csv.trim()) return { stage: "error", message: "Choose a CSV file first." };
    if (csv.length > MAX_FILE_BYTES) return { stage: "error", message: "The file is larger than 2 MB. Split it into smaller files." };

    const db = await createClient();
    const report = buildImportReport(csv, await customers.existingCustomerKeys(db, ctx.active.tenantId));
    if (report.fatal) return { stage: "error", message: report.fatal };
    if (step !== "import") return { stage: "checked", csv, report };

    const valid = report.rows.flatMap((r) => (r.ok ? [r.data] : []));
    if (!valid.length) return { stage: "error", message: "No valid rows to import.", csv, report };
    const result = await customers.importCustomers(db, ctx.active.tenantId, ctx.userId, valid);
    revalidatePath("/customers");
    if (!result.ok) return { stage: "error", message: result.message };
    return { stage: "done", inserted: result.data.inserted };
  } catch (e) {
    if (e instanceof AuthorizationError) return { stage: "error", message: e.message };
    throw e;
  }
}
