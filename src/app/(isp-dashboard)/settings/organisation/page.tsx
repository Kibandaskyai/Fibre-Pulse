import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { TenantStatusBadge } from "@/components/shared/status-badge";
import { requirePagePermission } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { OrganisationForm } from "./organisation-form";
import { EnforcementForm } from "./enforcement-form";
import { AccessControlForm } from "./access-control-form";

export const metadata: Metadata = { title: "Organisation" };

export default async function OrganisationPage() {
  const ctx = await requirePagePermission("settings:manage");
  const db = await createClient();
  const { data: t } = await db
    .from("tenants")
    .select("name, legal_name, county, town, contact_phone, slug, status, currency, timezone, settings")
    .eq("id", ctx.active.tenantId)
    .single();
  const settings = (t?.settings ?? {}) as { router_enforcement?: boolean; access_control?: string };
  const enforcement = Boolean(settings.router_enforcement);
  const accessMode = settings.access_control === "radius" ? "radius" : "router_secrets";

  return (
    <>
      <PageHeader title="Organisation" description="Details shown on receipts and reports." actions={t ? <TenantStatusBadge status={t.status} /> : null} />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardContent className="pt-5">
            <OrganisationForm
              values={{
                name: t?.name ?? "",
                legalName: t?.legal_name ?? "",
                county: t?.county ?? "",
                town: t?.town ?? "",
                contactPhone: t?.contact_phone ? t.contact_phone.replace(/^\+254/, "0") : "",
              }}
            />
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-sm">Fixed settings</CardTitle>
            <CardDescription>Set at registration. Contact FibrePulse to change.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Workspace</span><span>{t?.slug}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Currency</span><span>{t?.currency}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Time zone</span><span>{t?.timezone}</span></div>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Disconnect customers who are suspended or whose package has ended</CardTitle>
            <CardDescription>
              When on, suspending a customer, or a package running out without renewal, tells the FibrePulse Connector to cut their
              service; restoring or renewing lets them back on. Nothing else on the router is ever changed. The connector must also have
              ALLOW_ROUTER_WRITES=true and its router user needs the write policy. Only the owner can change this.
            </CardDescription>
          </CardHeader>
          <CardContent><EnforcementForm key={String(enforcement)} enabled={enforcement} /></CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Access control</CardTitle>
            <CardDescription>
              With PPPoE secrets on the router, a disconnect disables the customer&apos;s secret. With RADIUS, the connector tells your RADIUS
              server who has a live package and at what speed (passwords stay in your RADIUS), and a disconnect only drops the live session.
              See the connector guide for the FreeRADIUS settings.
            </CardDescription>
          </CardHeader>
          <CardContent><AccessControlForm mode={accessMode} /></CardContent>
        </Card>
      </div>
    </>
  );
}
