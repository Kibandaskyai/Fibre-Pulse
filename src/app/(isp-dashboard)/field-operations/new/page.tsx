import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { JOB_TYPES } from "@/lib/validation/operations";
import { technicianDirectory } from "@/modules/field/service";
import { customerOptions } from "@/modules/support/service";
import { NewJobForm } from "../job-forms";

export const metadata: Metadata = { title: "New job" };

const isUuid = (v?: string) => !!v && /^[0-9a-f-]{36}$/i.test(v);

export default async function NewJobPage({ searchParams }: { searchParams: Promise<{ customer?: string; ticket?: string; type?: string }> }) {
  const ctx = await requirePagePermission("jobs:edit");
  const sp = await searchParams;
  const db = await createClient();
  const [customers, technicians, ticket] = await Promise.all([
    customerOptions(db, ctx.active.tenantId),
    technicianDirectory(db, ctx.active.tenantId),
    isUuid(sp.ticket) ? db.from("support_tickets").select("id, ticket_number, subject").eq("id", sp.ticket!).maybeSingle().then((r) => r.data) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader title="New field job" description="The technician is notified as soon as the job is assigned." />
      <Card className="max-w-3xl">
        <CardContent className="pt-5">
          <NewJobForm
            customers={customers}
            technicians={technicians}
            defaults={{
              customerId: customers.some((c) => c.id === sp.customer) ? sp.customer : undefined,
              ticketId: ticket?.id,
              ticketLabel: ticket ? `${ticket.ticket_number}: ${ticket.subject}` : undefined,
              jobType: JOB_TYPES.some(([v]) => v === sp.type) ? sp.type : undefined,
            }}
          />
        </CardContent>
      </Card>
    </>
  );
}
