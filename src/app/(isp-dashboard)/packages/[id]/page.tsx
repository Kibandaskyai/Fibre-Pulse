import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { PackageStatusBadge } from "@/components/shared/billing-badges";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatKsh, periodLabel } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { setPackageStatusAction } from "@/modules/packages/actions";
import { getPackage } from "@/modules/packages/service";
import { PackageForm } from "../package-form";

export const metadata: Metadata = { title: "Package" };

const SAVED: Record<string, string> = {
  active: "Package is on sale again.",
  inactive: "Package is no longer offered for new purchases.",
  archived: "Package archived.",
};

export default async function PackagePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const ctx = await requirePagePermission("packages:view");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await getPackage(await createClient(), ctx.active.tenantId, id);
  if (!result.ok) notFound();
  const pkg = result.data;
  const canEdit = ctx.active.permissions.has("packages:edit");

  const statusButton = (status: "active" | "inactive" | "archived", label: string, variant: "outline" | "secondary" | "destructive" = "outline") => (
    <form action={setPackageStatusAction}>
      <input type="hidden" name="id" value={pkg.id} />
      <input type="hidden" name="status" value={status} />
      <Button size="sm" variant={variant} type="submit">{label}</Button>
    </form>
  );

  return (
    <>
      <PageHeader
        title={pkg.name}
        description={`${Number(pkg.download_mbps)}/${Number(pkg.upload_mbps)} Mbps · ${formatKsh(pkg.price)} · ${periodLabel(pkg.billing_period, pkg.duration_days)}`}
        actions={<PackageStatusBadge status={pkg.status} />}
      />
      <Flash success={sp.saved ? SAVED[sp.saved] : null} />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardContent className="pt-5">
            {canEdit ? <PackageForm pkg={pkg} /> : <p className="text-sm text-muted-foreground">You can view packages but not change them.</p>}
          </CardContent>
        </Card>
        {canEdit ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>Availability</CardTitle>
              <CardDescription>Stopping sales or archiving does not affect customers already on this package.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {pkg.status !== "active" ? statusButton("active", "Put on sale", "secondary") : null}
              {pkg.status === "active" ? statusButton("inactive", "Stop selling") : null}
              {pkg.status !== "archived" ? statusButton("archived", "Archive", "destructive") : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
