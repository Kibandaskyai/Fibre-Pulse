import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AgreementBadge } from "@/components/platform/platform-badges";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformStaff } from "@/lib/auth/guards";
import { formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { allAgreements, FEE_BASIS_LABELS, ratePct, REVENUE_CATEGORY_LABELS } from "@/modules/platform/billing";

export const metadata: Metadata = { title: "Agreements" };

const monthName = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-KE", { month: "short", year: "numeric", timeZone: "UTC" });

export default async function AgreementsPage() {
  const ctx = await requirePlatformStaff();
  if (ctx.platformRole !== "super_admin") redirect("/not-allowed");
  const res = await allAgreements(await createClient());
  return (
    <>
      <PageHeader
        title="Commercial agreements"
        description="Every ISP's fee terms, by version. Signed versions are frozen; open an ISP to draft, sign or end a version."
      />
      {!res.ok ? (
        <p className="text-sm text-danger">{res.message}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ISP</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Fee</TableHead>
                    <TableHead>Not charged</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Signed</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {res.data.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell><Link href={`/admin/tenants/${a.tenant_id}`} className="font-medium text-primary hover:underline">{a.tenant_name}</Link></TableCell>
                      <TableCell className="tabular">v{a.version}</TableCell>
                      <TableCell>{ratePct(a.fee_rate)}<p className="text-xs text-muted-foreground">{FEE_BASIS_LABELS[a.fee_basis]}</p></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{a.excluded_categories.map((c) => REVENUE_CATEGORY_LABELS[c] ?? c).join(", ") || "Nothing"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{monthName(a.effective_from)}{a.effective_to ? ` to ${formatDate(a.effective_to)}` : " onwards"}</TableCell>
                      <TableCell className="text-xs">{a.signed_at ? `${a.signed_by_name}, ${formatDate(a.signed_at)}` : "Not signed"}</TableCell>
                      <TableCell><AgreementBadge status={a.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {!res.data.length ? <p className="px-5 py-6 text-sm text-muted-foreground">No agreements yet. Each ISP gets a draft at 2.75% when it registers.</p> : null}
          </CardContent>
        </Card>
      )}
    </>
  );
}
