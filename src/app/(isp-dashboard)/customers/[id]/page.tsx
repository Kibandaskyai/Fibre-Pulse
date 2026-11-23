import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm } from "@/components/shared/action-form";
import {
  CustomerStatusBadge,
  InvoiceStatusBadge,
  PaymentStatusBadge,
  SubscriptionStatusBadge,
  VerificationBadge,
} from "@/components/shared/billing-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDate, formatDateTime, formatKsh, PAYMENT_METHOD_LABELS, periodLabel } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { changeSubscriptionAction, createInvoiceAction, purchaseSubscriptionAction } from "@/modules/billing/actions";
import { expireDueSubscriptions } from "@/modules/billing/service";
import { getCustomer, getCustomerHistory } from "@/modules/customers/service";
import { listPackages } from "@/modules/packages/service";
import { CustomerConnectionCard } from "@/components/network/customer-connection";
import { customerConnection, listRouters, routerEnforcementEnabled } from "@/modules/network/service";

export const metadata: Metadata = { title: "Customer" };

const TABS = [
  { key: "subscriptions", label: "Subscriptions", permission: "subscriptions:view" },
  { key: "invoices", label: "Invoices", permission: "invoices:view" },
  { key: "payments", label: "Payments", permission: "payments:view" },
  { key: "support", label: "Support", permission: "tickets:view" },
] as const;

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; created?: string; error?: string }>;
}) {
  const ctx = await requirePagePermission("customers:view");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = await createClient();
  const perms = ctx.active.permissions;
  await expireDueSubscriptions(db, ctx.active.tenantId);

  const result = await getCustomer(db, ctx.active.tenantId, id);
  if (!result.ok) notFound();
  const c = result.data;
  const canSeeNetwork = perms.has("network:view");
  const [history, packages, connection, routers, enforcement] = await Promise.all([
    getCustomerHistory(db, ctx.active.tenantId, id),
    perms.has("subscriptions:edit") ? listPackages(db, ctx.active.tenantId, { activeOnly: true }) : Promise.resolve(null),
    customerConnection(db, ctx.active.tenantId, id, canSeeNetwork),
    perms.has("network:edit") ? listRouters(db, ctx.active.tenantId) : Promise.resolve([]),
    routerEnforcementEnabled(db, ctx.active.tenantId),
  ]);
  const live = history.subscriptions.find((s) => s.status === "active" || s.status === "suspended");
  const tabs = TABS.filter((t) => perms.has(t.permission));
  const tab = tabs.find((t) => t.key === sp.tab)?.key ?? tabs[0]?.key;
  const seesMoney = perms.has("invoices:view");

  return (
    <>
      <PageHeader
        title={c.full_name}
        description={`${c.customer_number} · Registered ${formatDate(c.registered_on)}`}
        actions={
          <>
            <CustomerStatusBadge status={c.status} />
            {c.data_source === "simulated" ? <DataSourceBadge source="simulated" /> : null}
            {perms.has("customers:edit") ? (
              <Button asChild size="sm" variant="outline"><Link href={`/customers/${c.id}/edit`}><Pencil aria-hidden /> Edit</Link></Button>
            ) : null}
          </>
        }
      />
      <Flash error={sp.error} success={sp.created ? "Customer added." : null} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Current package</CardDescription></CardHeader>
          <CardContent>
            {live ? (
              <>
                <p className="font-semibold">{live.service_packages?.name ?? "Package"}</p>
                <p className="text-xs text-muted-foreground">
                  <SubscriptionStatusBadge status={live.status} /> until {formatDateTime(live.expires_at)}
                </p>
              </>
            ) : <p className="text-sm text-muted-foreground">No live subscription</p>}
          </CardContent>
        </Card>
        {seesMoney ? (
          <>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Outstanding</CardDescription></CardHeader>
              <CardContent><p className={cn("tabular text-xl font-semibold", c.outstanding > 0 && "text-warning")}>{formatKsh(c.outstanding)}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Unapplied credit</CardDescription></CardHeader>
              <CardContent>
                <p className="tabular text-xl font-semibold">{formatKsh(c.credit)}</p>
                <p className="text-xs text-muted-foreground">Last verified payment {formatDate(c.last_payment_at)}</p>
              </CardContent>
            </Card>
          </>
        ) : null}
        <Card>
          <CardHeader className="pb-2"><CardDescription>Contact</CardDescription></CardHeader>
          <CardContent className="text-sm">
            <p className="tabular">{c.phone}</p>
            {c.email ? <p className="text-muted-foreground">{c.email}</p> : null}
            <p className="text-muted-foreground">{[c.address, c.estate, c.town, c.county].filter(Boolean).join(", ") || "No address"}</p>
            {c.pppoe_username ? <p className="text-xs text-muted-foreground">PPPoE: {c.pppoe_username}</p> : null}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Card className="h-fit">
          <nav className="flex gap-1 overflow-x-auto border-b px-3 pt-3" aria-label="Customer history">
            {tabs.map((t) => (
              <Link
                key={t.key}
                href={`/customers/${c.id}?tab=${t.key}`}
                aria-current={t.key === tab ? "page" : undefined}
                className={cn("rounded-t-md px-3 py-2 text-sm", t.key === tab ? "border-b-2 border-primary font-medium" : "text-muted-foreground hover:text-foreground")}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          <CardContent className="p-0 pb-2">
            {tab === "subscriptions" ? (
              history.subscriptions.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Package</TableHead><TableHead>Type</TableHead><TableHead>Period</TableHead><TableHead className="text-right">Price</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {history.subscriptions.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>{s.service_packages?.name}<p className="text-xs text-muted-foreground">{periodLabel(s.billing_period, null)}</p></TableCell>
                        <TableCell className="capitalize">{s.change_type}</TableCell>
                        <TableCell className="text-xs">{formatDate(s.starts_at)} to {formatDate(s.expires_at)}{s.suspension_reason ? <p className="text-danger">Suspended: {s.suspension_reason}</p> : null}</TableCell>
                        <TableCell className="tabular text-right">{formatKsh(s.price)}</TableCell>
                        <TableCell><SubscriptionStatusBadge status={s.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="px-5 py-6 text-sm text-muted-foreground">No subscriptions yet.</p>
            ) : null}

            {tab === "invoices" ? (
              history.invoices.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Invoice</TableHead><TableHead>Issued</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Paid</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {history.invoices.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell className="tabular">{i.invoice_number}</TableCell>
                        <TableCell>{formatDate(i.issue_date)}</TableCell>
                        <TableCell className="tabular text-right">{formatKsh(i.total)}</TableCell>
                        <TableCell className="tabular text-right">{formatKsh(i.amount_paid)}</TableCell>
                        <TableCell><InvoiceStatusBadge status={i.status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="px-5 py-6 text-sm text-muted-foreground">No invoices yet.</p>
            ) : null}

            {tab === "payments" ? (
              history.payments.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Reference</TableHead><TableHead>When</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {history.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <Link className="tabular hover:underline" href={`/payments/${p.id}`}>{p.provider_reference ?? "—"}</Link>
                          <p className="text-xs text-muted-foreground">{PAYMENT_METHOD_LABELS[p.method]} {p.data_source === "simulated" ? <DataSourceBadge source="simulated" /> : null}</p>
                        </TableCell>
                        <TableCell className="text-xs">{formatDateTime(p.transaction_at)}</TableCell>
                        <TableCell className="tabular text-right">{formatKsh(p.amount)}</TableCell>
                        <TableCell className="space-x-1"><PaymentStatusBadge status={p.status} /> <VerificationBadge status={p.verification_status} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="px-5 py-6 text-sm text-muted-foreground">No payments recorded.</p>
            ) : null}

            {tab === "support" ? (
              history.tickets.length ? (
                <Table>
                  <TableHeader><TableRow><TableHead>Ticket</TableHead><TableHead>Subject</TableHead><TableHead>Opened</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {history.tickets.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="tabular">{t.ticket_number}</TableCell>
                        <TableCell>{t.subject}</TableCell>
                        <TableCell className="text-xs">{formatDate(t.created_at)}</TableCell>
                        <TableCell className="capitalize">{t.status.replace("_", " ")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : <p className="px-5 py-6 text-sm text-muted-foreground">No support tickets. The full support desk arrives in Phase 5.</p>
            ) : null}
            {!tab ? <p className="px-5 py-6 text-sm text-muted-foreground">Your role has no history views for this customer.</p> : null}
          </CardContent>
        </Card>

        <div className="grid h-fit gap-6">
          <CustomerConnectionCard
            customerId={c.id}
            connection={connection}
            routers={routers.map((r) => ({ id: r.id, name: r.name }))}
            canSeeNetwork={canSeeNetwork}
            canAssign={perms.has("network:edit")}
            canRetry={perms.has("subscriptions:suspend")}
            enforcement={enforcement}
          />
          {packages?.ok && c.status !== "terminated" ? (
            <Card>
              <CardHeader>
                <CardTitle>{live ? "Renew or change package" : "Activate a package"}</CardTitle>
                <CardDescription>
                  Issues an invoice for the package price. Renewing the same package adds a period after the current one ends;
                  a different package starts now.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {live?.status === "suspended" ? (
                  <p className="text-sm text-muted-foreground">Restore the suspended subscription before renewing or changing package.</p>
                ) : packages.data.length ? (
                  <ActionForm action={purchaseSubscriptionAction} submitLabel={live ? "Renew / change" : "Activate"} pendingText="Activating…" hidden={{ customerId: c.id }}>
                    <Label htmlFor="buy-package">Package</Label>
                    <NativeSelect id="buy-package" name="packageId" defaultValue={live && packages.data.some((p) => p.id === live.package_id) ? live.package_id : ""}>
                      <option value="">Choose…</option>
                      {packages.data.map((p) => <option key={p.id} value={p.id}>{p.name} · {formatKsh(p.price)} {periodLabel(p.billing_period, p.duration_days).toLowerCase()}</option>)}
                    </NativeSelect>
                  </ActionForm>
                ) : (
                  <p className="text-sm text-muted-foreground">No packages on sale. <Link className="text-primary hover:underline" href="/packages/new">Create one</Link>.</p>
                )}
              </CardContent>
            </Card>
          ) : null}

          {live && (perms.has("subscriptions:suspend") || perms.has("subscriptions:edit")) ? (
            <Card>
              <CardHeader>
                <CardTitle>Subscription status</CardTitle>
                <CardDescription>{enforcement ? "Changes are recorded with your reason. Suspending disconnects the customer on the router through the connector; restoring reconnects them." : "Changes are recorded with your reason. Router disconnect is off, so also disconnect a suspended customer on the router yourself."}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5">
                {perms.has("subscriptions:suspend") && live.status === "active" ? (
                  <ActionForm action={changeSubscriptionAction} submitLabel="Suspend" variant="outline" hidden={{ subscriptionId: live.id, action: "suspend", customerId: c.id }}>
                    <Label htmlFor="suspend-reason">Reason for suspending</Label>
                    <Input id="suspend-reason" name="reason" placeholder="e.g. Customer requested a pause" />
                  </ActionForm>
                ) : null}
                {perms.has("subscriptions:suspend") && live.status === "suspended" ? (
                  <ActionForm action={changeSubscriptionAction} submitLabel="Restore" variant="secondary" hidden={{ subscriptionId: live.id, action: "restore", customerId: c.id }}>
                    <Label htmlFor="restore-reason">Note (optional)</Label>
                    <Input id="restore-reason" name="reason" />
                  </ActionForm>
                ) : null}
                {perms.has("subscriptions:edit") ? (
                  <ActionForm action={changeSubscriptionAction} submitLabel="Cancel subscription" variant="destructive" hidden={{ subscriptionId: live.id, action: "cancel", customerId: c.id }}>
                    <Label htmlFor="cancel-reason">Reason for cancelling</Label>
                    <Input id="cancel-reason" name="reason" placeholder="e.g. Moved out of coverage area" />
                  </ActionForm>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {perms.has("payments:record") ? (
            <Card>
              <CardHeader>
                <CardTitle>Payments</CardTitle>
                <CardDescription>Record an M-Pesa or bank payment you have received. It counts once verified against the statement.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild variant="secondary"><Link href={`/payments/new?customer=${c.id}`}><Wallet aria-hidden /> Record payment</Link></Button>
              </CardContent>
            </Card>
          ) : null}

          {perms.has("invoices:edit") && c.status !== "terminated" ? (
            <Card>
              <CardHeader>
                <CardTitle>Other charges</CardTitle>
                <CardDescription>Installation, equipment or other one-off charges.</CardDescription>
              </CardHeader>
              <CardContent>
                <ActionForm action={createInvoiceAction} submitLabel="Issue invoice" variant="outline" hidden={{ customerId: c.id, quantity: "1" }}>
                  <Label htmlFor="inv-desc">Description</Label>
                  <Input id="inv-desc" name="description" placeholder="Router installation" />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="inv-cat">Category</Label>
                      <NativeSelect id="inv-cat" name="category" defaultValue="installation">
                        <option value="installation">Installation</option>
                        <option value="equipment">Equipment</option>
                        <option value="other">Other</option>
                      </NativeSelect>
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="inv-amount">Amount (Ksh)</Label>
                      <Input id="inv-amount" name="unitPrice" inputMode="decimal" />
                    </div>
                  </div>
                </ActionForm>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
