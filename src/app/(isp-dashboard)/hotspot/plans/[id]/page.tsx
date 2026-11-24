import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { PackageStatusBadge } from "@/components/shared/billing-badges";
import { requirePagePermission } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { setPlanStatusAction } from "@/modules/hotspot/actions";
import { getPlan } from "@/modules/hotspot/service";
import { PlanForm } from "../../forms";

export const metadata: Metadata = { title: "Hotspot plan" };

export default async function HotspotPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePagePermission("packages:edit");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const plan = await getPlan(await createClient(), ctx.active.tenantId, id);
  if (!plan) notFound();
  const statusButton = (status: "active" | "inactive" | "archived", label: string, variant: "outline" | "destructive" = "outline") => (
    <form action={setPlanStatusAction}>
      <input type="hidden" name="id" value={plan.id} />
      <input type="hidden" name="status" value={status} />
      <Button type="submit" size="sm" variant={variant}>{label}</Button>
    </form>
  );
  return (
    <>
      <PageHeader title={plan.name} actions={<PackageStatusBadge status={plan.status} />} />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <Card><CardContent className="pt-5"><PlanForm key={`${plan.id}-${plan.price}-${plan.duration_minutes}-${plan.name}`} plan={plan} /></CardContent></Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-sm">On sale</CardTitle>
            <CardDescription>Taking a plan off sale hides it from the buying page. Codes already bought keep working.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {plan.status !== "active" ? statusButton("active", "Put on sale") : statusButton("inactive", "Take off sale")}
            {plan.status !== "archived" ? statusButton("archived", "Archive", "destructive") : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
