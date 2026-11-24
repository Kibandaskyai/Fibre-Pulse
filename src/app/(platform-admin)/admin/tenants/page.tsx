import type { Metadata } from "next";
import Link from "next/link";
import { Building2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { TenantStatusBadge } from "@/components/shared/status-badge";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { listTenants } from "@/modules/platform/service";
import { TenantStatusForm } from "./status-form";

export const metadata: Metadata = { title: "ISP tenants" };

const dateFmt = new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeZone: "Africa/Nairobi" });

export default async function TenantsPage() {
  const ctx = await requirePlatformStaff();
  const isSuper = ctx.platformRole === "super_admin";
  const db = await createClient();
  const tenants = await listTenants(db);

  return (
    <>
      <PageHeader title="ISP tenants" description="Every ISP on FibrePulse. Status changes need a reason and are recorded in the audit log." />
      {!tenants.ok ? (
        <p className="text-sm text-danger">{tenants.message}</p>
      ) : tenants.data.length === 0 ? (
        <EmptyState icon={<Building2 />} title="No ISPs registered yet" description="ISPs appear here when an owner registers on the sign-up page." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ISP</TableHead>
                  <TableHead className="hidden md:table-cell">Owner</TableHead>
                  <TableHead className="hidden lg:table-cell">Location</TableHead>
                  <TableHead className="hidden sm:table-cell">Staff</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Registered</TableHead>
                  {isSuper ? <TableHead className="text-right">Actions</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.data.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link href={`/admin/tenants/${t.id}`} className="font-medium text-primary hover:underline">{t.name}</Link>
                      <p className="text-xs text-muted-foreground">{t.slug}</p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <p>{t.ownerName || "—"}</p>
                      <p className="text-xs text-muted-foreground">{t.ownerEmail}</p>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{[t.town, t.county].filter(Boolean).join(", ") || "—"}</TableCell>
                    <TableCell className="tabular hidden sm:table-cell">{t.staffCount}</TableCell>
                    <TableCell><TenantStatusBadge status={t.status} /></TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{dateFmt.format(new Date(t.createdAt))}</TableCell>
                    {isSuper ? (
                      <TableCell className="text-right"><TenantStatusForm tenantId={t.id} status={t.status} /></TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
