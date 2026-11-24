import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { customerOptions, staffDirectory } from "@/modules/support/service";
import { NewTicketForm } from "../ticket-forms";

export const metadata: Metadata = { title: "New ticket" };

export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const ctx = await requirePagePermission("tickets:edit");
  const { customer } = await searchParams;
  const db = await createClient();
  const [customers, staff] = await Promise.all([customerOptions(db, ctx.active.tenantId), staffDirectory(db, ctx.active.tenantId)]);
  return (
    <>
      <PageHeader title="New ticket" description="Record the problem in the customer's words. Everyone who handles tickets is notified." />
      <Card className="max-w-3xl">
        <CardContent className="pt-5">
          <NewTicketForm customers={customers} staff={staff} customerId={customers.some((c) => c.id === customer) ? customer : undefined} />
        </CardContent>
      </Card>
    </>
  );
}
