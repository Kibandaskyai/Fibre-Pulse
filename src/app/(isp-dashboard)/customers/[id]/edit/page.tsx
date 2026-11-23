import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { getCustomer } from "@/modules/customers/service";
import { CustomerForm } from "../../customer-form";

export const metadata: Metadata = { title: "Edit customer" };

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requirePagePermission("customers:edit");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const result = await getCustomer(await createClient(), ctx.active.tenantId, id);
  if (!result.ok) notFound();
  const c = result.data;
  return (
    <>
      <PageHeader
        title={`Edit ${c.full_name}`}
        description={c.customer_number}
        actions={<Link className="text-sm text-primary hover:underline" href={`/customers/${c.id}`}>Back to profile</Link>}
      />
      <Card className="max-w-3xl">
        <CardContent className="pt-5">
          <CustomerForm customer={c} location={c.location} canSetLocation={ctx.active.permissions.has("customers:view_location")} />
        </CardContent>
      </Card>
    </>
  );
}
