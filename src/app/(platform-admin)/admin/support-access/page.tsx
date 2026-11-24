import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { GrantBadge } from "@/components/platform/platform-badges";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { supportGrants } from "@/modules/platform/billing";
import { listTenants } from "@/modules/platform/service";
import { RequestAccessForm } from "../billing-forms";

export const metadata: Metadata = { title: "Support access" };

export default async function SupportAccessPage() {
  const ctx = await requirePlatformStaff();
  const db = await createClient();
  const [grants, tenants] = await Promise.all([supportGrants(db), listTenants(db)]);
  const choices = tenants.ok ? tenants.data.filter((t) => t.status !== "deactivated").map((t) => ({ id: t.id, name: t.name })) : [];
  return (
    <>
      <PageHeader
        title="Support access"
        description="FibrePulse staff cannot see an ISP's packages, subscriptions or network unless its owner approves a request. Access is read-only, ends after at most 72 hours, and every step is audited."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Ask an ISP for access</CardTitle>
            <CardDescription>The owner gets a notification and decides how long you may look.</CardDescription>
          </CardHeader>
          <CardContent><RequestAccessForm tenants={choices} /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{ctx.platformRole === "super_admin" ? "All requests" : "Your requests"}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!grants.ok ? (
              <p className="px-5 py-6 text-sm text-danger">{grants.message}</p>
            ) : grants.data.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>ISP</TableHead><TableHead>Requested by</TableHead><TableHead>Reason</TableHead><TableHead>Status</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {grants.data.map((g) => (
                      <TableRow key={g.id}>
                        <TableCell><Link href={`/admin/tenants/${g.tenant_id}`} className="text-primary hover:underline">{g.tenant_name}</Link><p className="text-xs text-muted-foreground">{formatDateTime(g.created_at)}</p></TableCell>
                        <TableCell>{g.requested_by}</TableCell>
                        <TableCell className="max-w-xs text-sm">{g.reason}</TableCell>
                        <TableCell>
                          <GrantBadge state={g.state} />
                          {g.state === "active" && g.expires_at ? <p className="mt-1 text-xs text-muted-foreground">until {formatDateTime(g.expires_at)}</p> : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="px-5 py-6 text-sm text-muted-foreground">No requests yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
