import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AgreementBadge, GrantBadge, PlatformInvoiceBadge } from "@/components/platform/platform-badges";
import { PageHeader } from "@/components/shared/page-header";
import { TenantStatusBadge } from "@/components/shared/status-badge";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { formatDate, formatDateTime, formatKsh, kenyaToday, plural } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import {
  agreementsFor,
  FEE_BASIS_LABELS,
  feeMonths,
  feeRecordsFor,
  invoicesFor,
  invoiceState,
  ratePct,
  REVENUE_CATEGORY_LABELS,
  supportGrants,
} from "@/modules/platform/billing";
import { listTenants } from "@/modules/platform/service";
import { AgreementForm, CalculateFeesForm, EndAgreementForm, IssueInvoiceForm, RequestAccessForm, SignAgreementForm } from "../../billing-forms";

export const metadata: Metadata = { title: "ISP account" };

const monthName = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-KE", { month: "long", year: "numeric", timeZone: "UTC" });
function shiftMonth(ym: string, by: number) {
  const d = new Date(`${ym}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
}

export default async function AdminTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, ctx] = await Promise.all([params, requirePlatformStaff()]);
  const isSuper = ctx.platformRole === "super_admin";
  const db = await createClient();
  const tenants = await listTenants(db);
  const t = tenants.ok ? tenants.data.find((x) => x.id === id) : undefined;
  if (!t) notFound();
  const today = kenyaToday();
  const thisMonth = today.slice(0, 7);
  const lastMonth = shiftMonth(thisMonth, -1);

  const grants = await supportGrants(db);
  const myGrant = grants.ok ? grants.data.find((g) => g.tenant_id === id && g.mine && (g.state === "active" || g.state === "waiting")) : undefined;

  const header = (
    <>
      <Link href="/admin/tenants" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All ISPs
      </Link>
      <PageHeader
        title={t.name}
        description={`${[t.town, t.county].filter(Boolean).join(", ") || "No location"} · owner ${t.ownerName || t.ownerEmail || "unknown"} · registered ${formatDate(t.createdAt)}`}
        actions={<TenantStatusBadge status={t.status} />}
      />
    </>
  );

  const supportCard = (
    <Card>
      <CardHeader>
        <CardTitle>Support access</CardTitle>
        <CardDescription>FibrePulse staff see this ISP&apos;s packages, subscriptions and network only while the owner allows it.</CardDescription>
      </CardHeader>
      <CardContent>
        {myGrant ? (
          <div className="grid gap-1 text-sm">
            <GrantBadge state={myGrant.state} />
            <p className="text-muted-foreground">{myGrant.reason}</p>
            {myGrant.expires_at ? <p className="text-xs text-muted-foreground">Ends {formatDateTime(myGrant.expires_at)}</p> : null}
          </div>
        ) : (
          <RequestAccessForm tenants={[]} tenantId={t.id} />
        )}
      </CardContent>
    </Card>
  );

  const network = myGrant?.state === "active" ? await networkSnapshot(db, t.id) : null;

  if (!isSuper) {
    return (
      <>
        {header}
        <div className="grid gap-6 lg:grid-cols-2">
          {supportCard}
          {network}
        </div>
      </>
    );
  }

  const [agreements, fees, invoices] = await Promise.all([agreementsFor(db, id), feeRecordsFor(db, id), invoicesFor(db, id)]);
  const ag = agreements.ok ? agreements.data : [];
  const draft = ag.find((a) => a.status === "draft");
  const inForce = ag.find((a) => a.status === "active" && !a.effective_to);
  const months = feeMonths(fees.ok ? fees.data : []);
  const uninvoiced = (fees.ok ? fees.data : []).filter((f) => f.status === "calculated").reduce((s, f) => s + f.fee_amount, 0);
  const latestStart = ag.filter((a) => a.status !== "draft").map((a) => a.effective_from.slice(0, 7)).sort().pop();
  const nextAgreementMonth = latestStart && latestStart >= thisMonth ? shiftMonth(latestStart, 1) : shiftMonth(thisMonth, 1);

  return (
    <>
      {header}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Commercial agreement</CardTitle>
            <CardDescription>Each version is frozen once signed. A new rate is a new version from a later month; past months keep their rate.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            {ag.filter((a) => a.status !== "draft").length ? (
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Version</TableHead><TableHead>Terms</TableHead><TableHead>Period</TableHead><TableHead>Status</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {ag.filter((a) => a.status !== "draft").map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="tabular">v{a.version}</TableCell>
                        <TableCell>
                          <p className="font-medium">{ratePct(a.fee_rate)} of {FEE_BASIS_LABELS[a.fee_basis].toLowerCase()}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.excluded_categories.length ? `Not charged: ${a.excluded_categories.map((c) => REVENUE_CATEGORY_LABELS[c] ?? c).join(", ")}` : "All verified collections charged"}
                          </p>
                          <p className="text-xs text-muted-foreground">Signed by {a.signed_by_name} on {formatDate(a.signed_at)}</p>
                        </TableCell>
                        <TableCell className="text-xs">{monthName(a.effective_from)}{a.effective_to ? ` to ${monthName(shiftMonth(a.effective_to.slice(0, 7), -1) + "-01")}` : " onwards"}</TableCell>
                        <TableCell><AgreementBadge status={a.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-warning">No signed agreement yet. Fees cannot be calculated until one is signed.</p>
            )}
            {inForce ? <EndAgreementForm tenantId={t.id} agreementId={inForce.id} defaultMonth={shiftMonth(thisMonth, 1)} /> : null}

            <div className="rounded-md border p-4" data-testid="agreement-draft">
              <h3 className="mb-1 font-medium">{draft ? `Draft version ${draft.version}` : "New version"}</h3>
              <p className="mb-4 text-xs text-muted-foreground">
                {draft ? "Check the terms with the ISP, then mark as signed." : "Start a new version when the ISP agrees different terms."}
              </p>
              <AgreementForm
                key={draft?.id ?? "new"}
                tenantId={t.id}
                draft={draft}
                defaultMonth={ag.some((a) => a.status !== "draft") ? nextAgreementMonth : thisMonth}
              />
              {draft ? <div className="mt-4 border-t pt-4"><SignAgreementForm tenantId={t.id} agreementId={draft.id} /></div> : null}
            </div>
          </CardContent>
        </Card>

        <div className="grid h-fit gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Platform fees</CardTitle>
              <CardDescription>Calculated per calendar month after it ends. Recalculating never charges twice: changes become adjustments.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <CalculateFeesForm tenantId={t.id} defaultMonth={lastMonth} maxMonth={lastMonth} />
              {months.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Month</TableHead>
                        <TableHead className="text-right">Eligible</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                        <TableHead className="text-right">Fee</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {months.map((m) => (
                        <TableRow key={m.period_start}>
                          <TableCell>
                            {monthName(m.period_start)}
                            <p className="text-xs text-muted-foreground">{plural(m.base?.payment_count ?? 0, "payment")}{m.adjustments.length ? ` · ${m.adjustments.length} adjustment${m.adjustments.length > 1 ? "s" : ""}` : ""}</p>
                            {m.adjustments.map((a) => <p key={a.id} className="text-xs text-muted-foreground">{a.reason} ({formatKsh(a.fee_amount)})</p>)}
                          </TableCell>
                          <TableCell className="tabular text-right">{formatKsh(m.eligible)}</TableCell>
                          <TableCell className="tabular text-right">{m.base ? ratePct(m.base.fee_rate) : ""}</TableCell>
                          <TableCell className="tabular text-right font-medium">{formatKsh(m.fee)}</TableCell>
                          <TableCell><PlatformInvoiceBadge status={m.status} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No months calculated yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Platform invoices</CardTitle>
              <CardDescription>
                {uninvoiced > 0 ? `${formatKsh(uninvoiced)} of calculated fees is waiting to be invoiced.` : "Every calculated fee is on an invoice."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {uninvoiced > 0 ? <IssueInvoiceForm tenantId={t.id} /> : null}
              {invoices.ok && invoices.data.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Invoice</TableHead><TableHead>Issued</TableHead><TableHead>Due</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Status</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoices.data.map((i) => (
                        <TableRow key={i.id}>
                          <TableCell><Link href={`/admin/invoices/${i.id}`} className="tabular whitespace-nowrap text-primary hover:underline">{i.invoice_number}</Link></TableCell>
                          <TableCell>{formatDate(i.issued_at)}</TableCell>
                          <TableCell>{formatDate(i.due_date)}</TableCell>
                          <TableCell className="tabular text-right">{formatKsh(i.total)}</TableCell>
                          <TableCell><PlatformInvoiceBadge status={invoiceState(i, today)} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No invoices yet.</p>
              )}
            </CardContent>
          </Card>
          {supportCard}
          {network}
        </div>
      </div>
    </>
  );
}

/** What support staff can see under an approved grant: router health and open alerts. */
async function networkSnapshot(db: Awaited<ReturnType<typeof createClient>>, tenantId: string) {
  const [routers, alerts] = await Promise.all([
    db.from("routers").select("id, name, status, routeros_version, last_synced_at, last_sync_error, data_source").eq("tenant_id", tenantId).order("name"),
    db.from("network_alerts").select("id, title, severity, opened_at").eq("tenant_id", tenantId).eq("status", "open").order("opened_at", { ascending: false }).limit(20),
  ]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Network (read-only, under support access)</CardTitle>
        <CardDescription>Every read here is covered by the owner&apos;s approval.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {(routers.data ?? []).map((r) => (
          <div key={r.id} className="rounded-md border p-3">
            <p className="font-medium">{r.name} <span className="text-xs text-muted-foreground">· {r.status}{r.data_source === "simulated" ? " · SIMULATED" : ""}</span></p>
            <p className="text-xs text-muted-foreground">RouterOS {r.routeros_version ?? "unknown"} · last sync {r.last_synced_at ? formatDateTime(r.last_synced_at) : "never"}</p>
            {r.last_sync_error ? <p className="text-xs text-danger">{r.last_sync_error}</p> : null}
          </div>
        ))}
        {!(routers.data ?? []).length ? <p className="text-muted-foreground">No routers.</p> : null}
        <p className="font-medium">Open alerts: {(alerts.data ?? []).length}</p>
        {(alerts.data ?? []).map((a) => <p key={a.id} className="text-xs">{a.severity}: {a.title} ({formatDateTime(a.opened_at)})</p>)}
      </CardContent>
    </Card>
  );
}
