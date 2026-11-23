import type { Metadata } from "next";
import Link from "next/link";
import { Download, Upload, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CustomerStatusBadge } from "@/components/shared/billing-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Flash } from "@/components/shared/flash";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatKsh } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { customerFiltersSchema } from "@/lib/validation/billing";
import { listCustomers, PAGE_SIZE } from "@/modules/customers/service";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requirePagePermission("customers:view");
  const sp = await searchParams;
  const parsed = customerFiltersSchema.safeParse(sp);
  const f = parsed.success ? parsed.data : customerFiltersSchema.parse({});
  const canEdit = ctx.active.permissions.has("customers:edit");
  const seesMoney = ctx.active.permissions.has("invoices:view");
  const result = await listCustomers(await createClient(), ctx.active.tenantId, f);
  const filterParams = { q: f.q, status: f.status, area: f.area, balance: f.balance };
  const exportQs = new URLSearchParams(Object.entries(filterParams).filter(([, v]) => v)).toString();
  const filtered = Boolean(f.q || f.status || f.area || f.balance);

  return (
    <>
      <PageHeader
        title="Customers"
        description="Search by name, customer number, phone or PPPoE username."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/customers/export${exportQs ? `?${exportQs}` : ""}`} prefetch={false}><Download aria-hidden /> Export CSV</Link>
            </Button>
            {canEdit ? (
              <>
                <Button asChild variant="outline" size="sm"><Link href="/customers/import"><Upload aria-hidden /> Import CSV</Link></Button>
                <Button asChild size="sm"><Link href="/customers/new"><UserPlus aria-hidden /> Add customer</Link></Button>
              </>
            ) : null}
          </>
        }
      />
      <form className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_12rem_12rem_10rem_auto]" role="search">
        <Input name="q" defaultValue={f.q} placeholder="Name, FP-000123, 0712…" aria-label="Search customers" />
        <NativeSelect name="status" defaultValue={f.status} aria-label="Status">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="pending_installation">Pending installation</option>
          <option value="suspended">Suspended</option>
          <option value="disconnected">Disconnected</option>
          <option value="terminated">Terminated</option>
        </NativeSelect>
        <Input name="area" defaultValue={f.area} placeholder="Estate, town or county" aria-label="Area" />
        {seesMoney ? (
          <NativeSelect name="balance" defaultValue={f.balance} aria-label="Balance">
            <option value="">Any balance</option>
            <option value="owing">Owing</option>
            <option value="credit">In credit</option>
          </NativeSelect>
        ) : <span className="hidden lg:block" />}
        <div className="flex gap-2">
          <Button type="submit" variant="secondary">Filter</Button>
          {filtered ? <Button asChild variant="ghost"><Link href="/customers">Clear</Link></Button> : null}
        </div>
      </form>

      {!result.ok ? (
        <Flash error={result.message} />
      ) : result.data.total === 0 ? (
        <EmptyState
          icon={<Users />}
          title={filtered ? "No customers match" : "No customers yet"}
          description={filtered ? "Try a different search or clear the filters." : "Add customers one by one or import them from a CSV file."}
          action={!filtered && canEdit ? <Button asChild><Link href="/customers/new">Add the first customer</Link></Button> : null}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead className="hidden md:table-cell">Phone</TableHead>
                  <TableHead className="hidden lg:table-cell">Area</TableHead>
                  <TableHead>Status</TableHead>
                  {seesMoney ? <TableHead className="text-right">Balance</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/customers/${c.id}`} className="font-medium hover:underline">{c.full_name}</Link>
                      <p className="text-xs text-muted-foreground">
                        {c.customer_number} {c.data_source === "simulated" ? <DataSourceBadge source="simulated" /> : null}
                      </p>
                    </TableCell>
                    <TableCell className="hidden tabular md:table-cell">{c.phone}</TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">{[c.estate, c.town].filter(Boolean).join(", ") || "—"}</TableCell>
                    <TableCell><CustomerStatusBadge status={c.status} /></TableCell>
                    {seesMoney ? (
                      <TableCell className="tabular text-right">
                        {c.outstanding > 0 ? <span className="text-warning">{formatKsh(c.outstanding)} due</span>
                          : c.credit > 0 ? <span className="text-success">{formatKsh(c.credit)} credit</span>
                          : <span className="text-muted-foreground">Settled</span>}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination path="/customers" params={filterParams} page={f.page} pageSize={PAGE_SIZE} total={result.data.total} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
