import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { CustomerForm } from "../customer-form";

export const metadata: Metadata = { title: "Add customer" };

export default async function NewCustomerPage() {
  const ctx = await requirePagePermission("customers:edit");
  return (
    <>
      <PageHeader title="Add customer" description="A customer number is assigned automatically. Duplicate phone numbers are refused." />
      <Card className="max-w-3xl">
        <CardContent className="pt-5">
          <CustomerForm canSetLocation={ctx.active.permissions.has("customers:view_location")} />
        </CardContent>
      </Card>
    </>
  );
}
