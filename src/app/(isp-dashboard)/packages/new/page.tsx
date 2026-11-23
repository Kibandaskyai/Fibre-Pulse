import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { PackageForm } from "../package-form";

export const metadata: Metadata = { title: "New package" };

export default async function NewPackagePage() {
  await requirePagePermission("packages:edit");
  return (
    <>
      <PageHeader title="New package" description="Customers can be put on this package as soon as it is created." />
      <Card className="max-w-2xl">
        <CardContent className="pt-5">
          <PackageForm />
        </CardContent>
      </Card>
    </>
  );
}
