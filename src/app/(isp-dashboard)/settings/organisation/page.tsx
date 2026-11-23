import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { TenantStatusBadge } from "@/components/shared/status-badge";
import { requirePagePermission } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { OrganisationForm } from "./organisation-form";

export const metadata: Metadata = { title: "Organisation" };

export default async function OrganisationPage() {
  const ctx = await requirePagePermission("settings:manage");
  const db = await createClient();
  const { data: t } = await db
    .from("tenants")
    .select("name, legal_name, county, town, contact_phone, slug, status, currency, timezone")
    .eq("id", ctx.active.tenantId)
    .single();

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
      </div>
    </>
  );
}
