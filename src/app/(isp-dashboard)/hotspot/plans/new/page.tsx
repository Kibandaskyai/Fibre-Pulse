import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { PlanForm } from "../../forms";

export const metadata: Metadata = { title: "New hotspot plan" };

export default async function NewHotspotPlanPage() {
  await requirePagePermission("packages:edit");
  return (
    <>
      <PageHeader title="New hotspot plan" description="Buyers see the name, time and price on the WiFi buying page." />
      <Card className="max-w-3xl"><CardContent className="pt-5"><PlanForm /></CardContent></Card>
    </>
  );
}
