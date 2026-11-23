import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SubscriptionStatusBadge } from "@/components/shared/billing-badges";
import { EmptyState } from "@/components/shared/empty-state";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDateTime, formatKsh, periodLabel } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { expireDueSubscriptions, listSubscriptions, PAGE_SIZE, subscriptionCounts } from "@/modules/billing/service";

export const metadata: Metadata = { title: "Subscriptions" };

const VIEWS = [
  { key: "", label: "Live" },
  { key: "expiring", label: "Expiring in 3 days" },
  { key: "suspended", label: "Suspended" },
  { key: "expired", label: "Expired" },
  { key: "cancelled", label: "Cancelled" },
];

export default async function SubscriptionsPage({ searchParams }: { searchParams: Promise<{ view?: string; page?: string }> }) {
  const ctx = await requirePagePermission("subscriptions:view");
  const sp = await searchParams;
  const view = VIEWS.some((v) => v.key === sp.view) ? (sp.view ?? "") : "";
  const page = Math.max(1, Number(sp.page) || 1);
  const db = await createClient();
  await expireDueSubscriptions(db, ctx.active.tenantId);
  const [counts, result] = await Promise.all([
    subscriptionCounts(db, ctx.active.tenantId),
    listSubscriptions(db, ctx.active.tenantId, { status: view === "expiring" ? "" : view, expiring: view === "expiring", page }),
  ]);

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Activate, renew, change, suspend or restore from the customer's profile. Periods end at the same time of day in Kenyan time."
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        {[
          ["Active", counts.active, ""],
          ["Expiring in 3 days", counts.expiringSoon, counts.expiringSoon ? "text-warning" : ""],
          ["Suspended", counts.suspended, counts.suspended ? "text-danger" : ""],
        ].map(([label, value, tone]) => (
          <Card key={label as string}>
            <CardHeader className="pb-2"><CardDescription>{label}</CardDescription></CardHeader>
            <CardContent><p className={cn("tabular text-2xl font-semibold", tone as string)}>{value}</p></CardContent>
          </Card>
        ))}
      </div>
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Subscription views">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={v.key ? `/subscriptions?view=${v.key}` : "/subscriptions"}
            aria-current={v.key === view ? "page" : undefined}
            className={cn("rounded-full border px-3 py-1 text-sm", v.key === view ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground")}
          >
            {v.label}
          </Link>
        ))}
      </nav>
      {!result.ok ? (
        <Flash error={result.message} />
      ) : result.data.total === 0 ? (
        <EmptyState icon={<CalendarClock />} title="Nothing here" description="Subscriptions are created from a customer's profile when they buy a package." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Package</TableHead>
                  <TableHead className="hidden md:table-cell">Started</TableHead>
                  <TableHead>{view === "expired" || view === "cancelled" ? "Ended" : "Expires"}</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">Price</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link className="font-medium hover:underline" href={`/customers/${s.customer_id}?tab=subscriptions`}>{s.customers?.full_name}</Link>
                      <p className="text-xs text-muted-foreground">{s.customers?.customer_number}</p>
                    </TableCell>
                    <TableCell>{s.service_packages?.name}<p className="text-xs capitalize text-muted-foreground">{s.change_type} · {periodLabel(s.billing_period, null)}</p></TableCell>
                    <TableCell className="hidden text-xs md:table-cell">{formatDateTime(s.starts_at)}</TableCell>
                    <TableCell className="text-xs">{formatDateTime(s.expires_at)}</TableCell>
                    <TableCell className="hidden tabular sm:table-cell text-right">{formatKsh(s.price)}</TableCell>
                    <TableCell><SubscriptionStatusBadge status={s.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination path="/subscriptions" params={{ view }} page={page} pageSize={PAGE_SIZE} total={result.data.total} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
