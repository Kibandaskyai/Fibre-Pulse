import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarList } from "@/components/charts/bar-list";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { KpiCard } from "@/components/shared/kpi-card";
import { PageHeader } from "@/components/shared/page-header";
import { NetworkStatusCard } from "@/components/hotspot/network-status";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatKsh, plural } from "@/lib/format";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { hotspotSummary, listPlans, networkStatus } from "@/modules/hotspot/service";
import { CompensateForm, FreeCodeForm, SellCodeForm } from "./forms";

export const metadata: Metadata = { title: "Hotspot" };

export default async function HotspotPage() {
  const ctx = await requirePagePermission("subscriptions:view");
  const db = await createClient();
  const tenantId = ctx.active.tenantId;
  const p = ctx.active.permissions;
  const canSell = p.has("subscriptions:edit") && p.has("payments:record");
  const canGive = p.has("subscriptions:suspend");
  const [summary, status, plans, tenant] = await Promise.all([
    hotspotSummary(db, tenantId),
    networkStatus(db, tenantId),
    listPlans(db, tenantId, { onSaleOnly: true }),
    db.from("tenants").select("slug").eq("id", tenantId).maybeSingle(),
  ]);
  const onSale = plans.ok ? plans.data : [];
  const portalUrl = `${publicEnv().NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "")}/wifi/${tenant.data?.slug ?? ""}`;
  const s = summary;

  return (
    <>
      <PageHeader
        title="Hotspot"
        description="People buy time for one phone or gadget at a time and are cut off automatically when it runs out. Money counts once M-Pesa confirms it."
        actions={
          <>
            <Button asChild variant="outline" size="sm"><Link href="/hotspot/codes"><ListChecks aria-hidden /> Codes and sales</Link></Button>
            <Button asChild variant="outline" size="sm"><Link href="/hotspot/plans"><Tag aria-hidden /> Plans</Link></Button>
          </>
        }
      />
      <div className="grid gap-6">
        <NetworkStatusCard status={status} />

        {s ? (
          <section aria-label="Hotspot today" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Running codes" value={s.active_codes.toLocaleString("en-KE")} hint={`${s.expiring_hour} ending within the hour`} href="/hotspot/codes?status=active"
              badge={s.simulated ? <DataSourceBadge source="simulated" /> : undefined} />
            <KpiCard label="Sold today" value={formatKsh(s.sales_today)} hint={`${plural(s.sold_today, "code")}${s.free_today ? ` · ${s.free_today} free` : ""}`} href="/hotspot/codes" />
            <KpiCard label="Paid, not used yet" value={s.unused_codes.toLocaleString("en-KE")} hint={s.awaiting_payment ? `${s.awaiting_payment} waiting for M-Pesa` : "Not used on a device yet"} href="/hotspot/codes?status=unused" />
            <KpiCard label="Devices" value={s.devices.toLocaleString("en-KE")} hint={`${s.devices_30d.toLocaleString("en-KE")} used in the last 30 days`} />
          </section>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Sales today by plan</CardTitle>
              <CardDescription>Codes bought today (Kenyan time), including those waiting for statement verification.</CardDescription>
            </CardHeader>
            <CardContent>
              <BarList rows={(s?.by_plan_today ?? []).map((r) => ({ label: r.plan, value: r.amount, detail: plural(r.count, "code") }))} emptyText="No sales yet today." />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>WiFi buying page</CardTitle>
              <CardDescription>
                Point your MikroTik hotspot login page here. Buyers choose a plan, pay with an M-Pesa prompt and get a code that works on their device only.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <code className="break-all rounded-md border bg-secondary/40 px-3 py-2">{portalUrl}</code>
              <p className="text-xs text-muted-foreground">{plural(onSale.length, "plan")} on sale. See the connector guide for the hotspot login page and walled garden settings.</p>
              <div><Button asChild size="sm" variant="outline"><Link href={`/wifi/${tenant.data?.slug ?? ""}`} target="_blank">Open the buying page</Link></Button></div>
            </CardContent>
          </Card>
        </div>

        {canSell || canGive ? (
          <div className="grid gap-6 lg:grid-cols-3">
            {canSell ? (
              <Card>
                <CardHeader>
                  <CardTitle>Issue a code for an M-Pesa payment</CardTitle>
                  <CardDescription>
                    For a customer who paid but did not get a code, for example while the system was down. One code per M-Pesa transaction:
                    if the payment is already in FibrePulse the code is tied to it, and a payment that already has a code is refused. The code is sent by SMS.
                  </CardDescription>
                </CardHeader>
                <CardContent><SellCodeForm plans={onSale} /></CardContent>
              </Card>
            ) : null}
            {canGive ? (
              <Card>
                <CardHeader>
                  <CardTitle>Give a free code</CardTitle>
                  <CardDescription>Free time is never counted as money and is always recorded with your reason.</CardDescription>
                </CardHeader>
                <CardContent><FreeCodeForm plans={onSale} /></CardContent>
              </Card>
            ) : null}
            {canGive ? (
              <Card>
                <CardHeader>
                  <CardTitle>Make up for an outage</CardTitle>
                  <CardDescription>Adds the minutes lost to every code that is running now.</CardDescription>
                </CardHeader>
                <CardContent><CompensateForm /></CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
