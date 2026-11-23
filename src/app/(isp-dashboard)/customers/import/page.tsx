import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { IMPORT_COLUMNS, MAX_IMPORT_ROWS } from "@/modules/customers/csv";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Import customers" };

export default async function ImportCustomersPage() {
  await requirePagePermission("customers:edit");
  return (
    <>
      <PageHeader
        title="Import customers"
        description="Check the file first. Nothing is saved until you confirm, and rows with problems are skipped."
        actions={<Link className="text-sm text-primary hover:underline" href="/customers">Back to customers</Link>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <ImportForm />
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>File format</CardTitle>
            <CardDescription>CSV with a header row, up to {MAX_IMPORT_ROWS.toLocaleString()} customers and 2 MB.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>Columns: <code className="text-xs">{IMPORT_COLUMNS.join(", ")}</code>. Only <strong>full_name</strong> and <strong>phone</strong> are required.</p>
            <p className="text-muted-foreground">Phones may be 0712…, 254712… or +254712…. Status may be active, pending, suspended, disconnected or terminated (default pending installation).</p>
            <p className="text-muted-foreground">Rows are skipped if the phone or PPPoE username already belongs to a customer, or repeats in the file.</p>
            <p className="text-muted-foreground">GPS locations are not imported; capture them on site.</p>
            <a
              className="text-primary hover:underline"
              download="fibrepulse-customer-template.csv"
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_COLUMNS.join(",") + "\r\nJane Wanjiku,0712345678,,House 4,Roysambu,Nairobi,Nairobi,active,jane.w,\r\n")}`}
            >
              Download a template
            </a>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
