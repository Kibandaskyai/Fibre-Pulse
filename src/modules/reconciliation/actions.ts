"use server";

import { revalidatePath } from "next/cache";
import { assertPermission, AuthorizationError } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import type { ReconcileReport } from "./report";
import { reconcileStatement } from "./service";
import { parseStatement, type StatementSource } from "./statement";

export type ReconcileState =
  | null
  | {
      stage: "checked" | "done";
      csv: string;
      source: StatementSource;
      detected: StatementSource;
      fileName: string;
      columns: { reference: string; amount: string; date: string | null; details: string | null };
      skipped: number;
      report: ReconcileReport;
    }
  | { stage: "error"; message: string };

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Two steps, like the customer import: "check" parses the statement and asks
 * the database what would match without changing anything; "apply" sends the
 * same text again and verifies the exact matches.
 */
export async function reconcileStatementAction(_prev: ReconcileState, formData: FormData): Promise<ReconcileState> {
  try {
    const ctx = await assertPermission("payments:reconcile");
    const step = formData.get("step");
    let csv = String(formData.get("csv") ?? "");
    let fileName = String(formData.get("fileName") ?? "statement.csv").slice(0, 120);
    const file = formData.get("file");
    if (step === "check" && file instanceof File && file.size > 0) {
      if (file.size > MAX_FILE_BYTES) return { stage: "error", message: "The file is larger than 2 MB. Export one month at a time." };
      csv = await file.text();
      fileName = file.name.slice(0, 120);
    }
    if (!csv.trim()) return { stage: "error", message: "Choose a statement CSV file first." };
    if (csv.length > MAX_FILE_BYTES) return { stage: "error", message: "The file is larger than 2 MB. Export one month at a time." };

    const parsed = parseStatement(csv);
    if (!parsed.ok) return { stage: "error", message: parsed.message };
    const chosen = formData.get("source");
    const source: StatementSource = chosen === "mpesa_statement" || chosen === "bank_statement" ? chosen : parsed.source;

    const apply = step === "apply";
    const result = await reconcileStatement(await createClient(), ctx.active.tenantId, source, parsed.lines, apply);
    if (!result.ok) return { stage: "error", message: result.message };
    if (apply) {
      revalidatePath("/payments");
      revalidatePath("/overview");
      revalidatePath("/revenue");
    }
    return {
      stage: apply ? "done" : "checked",
      csv,
      source,
      detected: parsed.source,
      fileName,
      columns: parsed.columns,
      skipped: parsed.skipped.length,
      report: result.data,
    };
  } catch (e) {
    if (e instanceof AuthorizationError) return { stage: "error", message: e.message };
    throw e;
  }
}
