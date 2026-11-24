import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { platformAudit } from "@/modules/platform/billing";
import { listTenants } from "@/modules/platform/service";

export const metadata: Metadata = { title: "Audit log" };

const ENTITIES = [
  ["", "Everything"],
  ["tenants", "ISP status"],
  ["commercial_agreements", "Agreements"],
  ["platform_fee_records", "Fee calculations"],
  ["platform_invoices", "Invoices"],
  ["support_access_grants", "Support access"],
] as const;

/** One readable line per change, using only fields relevant to the platform. */
function describe(entity: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
  const a = after ?? {};
  const b = before ?? {};
  switch (entity) {
    case "tenants":
      return action === "insert" ? `ISP registered: ${a.name}` : a.status !== b.status ? `Status ${b.status} → ${a.status}` : "ISP details changed";
    case "commercial_agreements":
      if (action === "insert") return `Agreement v${a.version} drafted at ${(Number(a.fee_rate) * 100).toFixed(2)}%`;
      if (action === "delete") return `Draft v${b.version} discarded`;
      return a.status !== b.status ? `Agreement v${a.version}: ${b.status} → ${a.status}` : `Agreement v${a.version} draft edited`;
    case "platform_fee_records":
      if (action === "insert") return `${a.adjustment_of ? "Adjustment" : "Fee"} for ${String(a.period_start).slice(0, 7)}: KSh ${Number(a.fee_amount).toFixed(2)}`;
      return `Fee record ${b.status} → ${a.status}`;
    case "platform_invoices":
      return action === "insert" ? `Invoice ${a.invoice_number} issued: KSh ${Number(a.total).toFixed(2)}` : `Invoice ${a.invoice_number}: ${b.status} → ${a.status}`;
    case "support_access_grants":
      if (action === "insert") return "Support access requested";
      if (a.revoked_at && !b.revoked_at) return b.approved_at ? "Support access revoked" : "Support access declined";
      if (a.approved_at && !b.approved_at) return "Support access approved";
      return "Support access changed";
    default:
      return `${entity} ${action}`;
  }
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const ctx = await requirePlatformStaff();
  if (ctx.platformRole !== "super_admin") redirect("/not-allowed");
  const { entity = "" } = await searchParams;
  const db = await createClient();
  const [log, tenants] = await Promise.all([platformAudit(db, ENTITIES.some(([k]) => k === entity) && entity ? entity : undefined), listTenants(db)]);
  const tenantName = new Map(tenants.ok ? tenants.data.map((t) => [t.id, t.name]) : []);
  const { data: people } = log.ok
    ? await db.from("profiles").select("id, full_name, email").in("id", [...new Set(log.data.map((r) => r.actor_id).filter(Boolean))] as string[])
    : { data: [] };
  const who = new Map((people ?? []).map((p) => [p.id as string, (p.full_name as string) || (p.email as string)]));

  return (
    <>
      <PageHeader title="Audit log" description="The latest 200 platform changes: ISP status, agreements, fee calculations, invoices and support access. Entries cannot be edited or deleted." />
      <div className="mb-3 flex flex-wrap gap-2">
        {ENTITIES.map(([key, label]) => (
          <Button key={key} asChild size="sm" variant={entity === key ? "secondary" : "ghost"}>
            <Link href={key ? `/admin/audit?entity=${key}` : "/admin/audit"}>{label}</Link>
          </Button>
        ))}
      </div>
      {!log.ok ? (
        <p className="text-sm text-danger">{log.message}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>When</TableHead><TableHead>ISP</TableHead><TableHead>What</TableHead><TableHead>Who</TableHead><TableHead>Reason</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {log.data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.created_at)}</TableCell>
                      <TableCell>{r.tenant_id ? tenantName.get(r.tenant_id) ?? "Unknown ISP" : "Platform"}</TableCell>
                      <TableCell>{describe(r.entity_type, r.action, r.before_data as Record<string, unknown> | null, r.after_data as Record<string, unknown> | null)}</TableCell>
                      <TableCell className="text-xs">{r.actor_id ? who.get(r.actor_id) ?? "Unknown" : "System"}</TableCell>
                      <TableCell className="max-w-xs text-xs text-muted-foreground">{r.reason ?? ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {!log.data.length ? <p className="px-5 py-6 text-sm text-muted-foreground">Nothing recorded yet.</p> : null}
          </CardContent>
        </Card>
      )}
    </>
  );
}
