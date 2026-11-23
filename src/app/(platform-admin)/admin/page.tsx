import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { listTenants } from "@/modules/platform/service";

export const metadata: Metadata = { title: "Platform overview" };

export default async function PlatformOverviewPage() {
  await requirePlatformStaff();
  const db = await createClient();
  const tenants = await listTenants(db);
  const rows = tenants.ok ? tenants.data : [];
  const by = (s: string) => rows.filter((r) => r.status === s).length;
  const stats = [
    { label: "Registered ISPs", value: rows.length },
    { label: "Active ISPs", value: by("active") },
    { label: "Awaiting activation", value: by("pending") },
    { label: "Suspended or deactivated", value: by("suspended") + by("deactivated") },
  ];

  return (
    <>
      <PageHeader
        title="Platform overview"
        description="Collections, platform fees, invoices and growth trends arrive with the fee engine in Phase 6. Until then only tenant counts are shown."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2"><CardDescription>{s.label}</CardDescription></CardHeader>
            <CardContent><p className="tabular text-3xl font-semibold">{s.value}</p></CardContent>
          </Card>
        ))}
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Next step</CardTitle>
          <CardDescription>
            Review ISPs awaiting activation on the <Link className="text-primary hover:underline" href="/admin/tenants">ISP tenants</Link> page.
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
