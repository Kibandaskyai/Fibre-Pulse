import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { VoucherSourceText, VoucherStatusBadge } from "@/components/hotspot/badges";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatData, formatDateTime, formatKsh, formatPlanDuration, timeLeft } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { listCodes, PAGE_SIZE, VOUCHER_STATUS_LABELS } from "@/modules/hotspot/service";
import { CancelCodeForm, ResendCodeForm } from "../forms";

export const metadata: Metadata = { title: "Hotspot codes" };

const STATUSES = ["live", "active", "unused", "expired", "cancelled", "payment_failed", "awaiting_payment"] as const;

export default async function HotspotCodesPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const ctx = await requirePagePermission("subscriptions:view");
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 40);
  const status = STATUSES.includes(sp.status as (typeof STATUSES)[number]) ? (sp.status as string) : "";
  const page = Math.max(1, Number(sp.page) || 1);
  const canCancel = ctx.active.permissions.has("subscriptions:suspend");
  const canResend = ctx.active.permissions.has("subscriptions:edit");
  const result = await listCodes(await createClient(), ctx.active.tenantId, { q, status, page });

  return (
    <>
      <PageHeader
        title="Hotspot codes and sales"
        description="Every purchase, newest first. Search by code or the buyer's phone number to help someone who calls."
        actions={<Button asChild variant="outline" size="sm"><Link href="/hotspot">Back to Hotspot</Link></Button>}
      />
      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_14rem_auto]" role="search">
        <label className="sr-only" htmlFor="codes-q">Code or phone</label>
        <Input id="codes-q" name="q" defaultValue={q} placeholder="Code (e.g. K7PX2M) or phone (0712 345 678)" />
        <label className="sr-only" htmlFor="codes-status">Status</label>
        <NativeSelect id="codes-status" name="status" defaultValue={status}>
          <option value="">All except unpaid prompts</option>
          <option value="live">Running or not used yet</option>
          {STATUSES.filter((s) => s !== "live").map((s) => <option key={s} value={s}>{VOUCHER_STATUS_LABELS[s as keyof typeof VOUCHER_STATUS_LABELS]}</option>)}
        </NativeSelect>
        <Button type="submit" variant="outline"><Search aria-hidden /> Search</Button>
      </form>
      {!result.ok ? (
        <Flash error={result.message} />
      ) : (
        <Card>
          <CardContent className="p-0 pb-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Phone / device</TableHead>
                  <TableHead className="hidden lg:table-cell">Bought</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.rows.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No codes match.</TableCell></TableRow>
                ) : null}
                {result.data.rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <span className="tabular font-semibold tracking-widest">{c.code}</span>
                      {c.data_source === "simulated" ? <div className="mt-1"><DataSourceBadge source="simulated" /></div> : null}
                      {canResend && (c.status === "unused" || c.status === "active") ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-muted-foreground">Send by SMS…</summary>
                          <div className="mt-2 min-w-64"><ResendCodeForm id={c.id} phone={c.phone} /></div>
                        </details>
                      ) : null}
                      {canCancel && (c.status === "unused" || c.status === "active") ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-muted-foreground">Cancel…</summary>
                          <div className="mt-2 min-w-64"><CancelCodeForm id={c.id} code={c.code} /></div>
                        </details>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {c.plan_name}
                      <p className="text-xs text-muted-foreground">
                        {formatPlanDuration(c.duration_minutes)}
                        {c.data_limit_mb ? ` · ${formatData(c.used_mb)} of ${formatData(c.data_limit_mb)} used` : ""}
                      </p>
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {c.source === "complimentary" ? "Free" : formatKsh(c.price)}
                      <div><VoucherSourceText source={c.source} /></div>
                    </TableCell>
                    <TableCell>
                      <VoucherStatusBadge status={c.status} />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {c.status === "active" || (c.status === "unused" && c.expires_at) ? `${timeLeft(c.expires_at)} left` : c.end_reason ?? c.reason ?? ""}
                      </p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs">
                      <p>{c.phone ? c.phone.replace(/^\+254/, "0") : "—"}</p>
                      <p className="tabular text-muted-foreground">{c.mac_address ?? ""}</p>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{formatDateTime(c.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination path="/hotspot/codes" params={{ q, status }} page={page} pageSize={PAGE_SIZE} total={result.data.total} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
