import type { Metadata } from "next";
import { Bell } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireTenant } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Notifications" };

const dateFmt = new Intl.DateTimeFormat("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" });

export default async function NotificationsPage() {
  const ctx = await requireTenant();
  const db = await createClient();
  const { data } = await db
    .from("notifications")
    .select("id, title, body, created_at, read_at")
    .eq("recipient_id", ctx.userId)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <>
      <PageHeader title="Notifications" description="Expiry, payment and network notifications appear here. Email and SMS delivery come later." />
      {!data?.length ? (
        <EmptyState icon={<Bell />} title="No notifications yet" />
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {data.map((n) => (
              <div key={n.id} className="flex items-start gap-3 px-5 py-3">
                <span className={`mt-1.5 size-2 rounded-full ${n.read_at ? "bg-transparent" : "bg-primary"}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{n.title}</p>
                  {n.body ? <p className="text-sm text-muted-foreground">{n.body}</p> : null}
                </div>
                <time className="shrink-0 text-xs text-muted-foreground">{dateFmt.format(new Date(n.created_at))}</time>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
