import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { listConnectors } from "@/modules/network/service";
import { RouterForm } from "../../router-form";

export const metadata: Metadata = { title: "Add router" };

export default async function NewRouterPage() {
  const ctx = await requirePagePermission("network:edit");
  const connectors = (await listConnectors(await createClient(), ctx.active.tenantId)).filter((c) => c.status !== "revoked");
  return (
    <>
      <PageHeader title="Add a MikroTik router" description="FibrePulse reads routers through the RouterOS REST API (RouterOS 7.1 or later) via your connector. You add the API password on the next screen." />
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Router details</CardTitle>
          <CardDescription>Nothing on the router changes. Reading is all FibrePulse does unless your owner turns on disconnecting suspended customers.</CardDescription>
        </CardHeader>
        <CardContent><RouterForm connectors={connectors} /></CardContent>
      </Card>
    </>
  );
}
