import type { Metadata } from "next";
import Link from "next/link";
import { Bell, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Pagination } from "@/components/shared/pagination";
import { requireTenant } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { NOTIFICATION_TYPES, labelOf } from "@/lib/validation/operations";
import { markReadAction } from "@/modules/notifications/actions";
import { listNotifications } from "@/modules/notifications/service";

export const metadata: Metadata = { title: "Notifications" };
const PAGE_SIZE = 30;

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ unread?: string; page?: string }> }) {
  const ctx = await requireTenant();
  const sp = await searchParams;
  const f = { unread: sp.unread === "1", page: Math.max(1, Math.min(1000, Number.parseInt(sp.page ?? "1", 10) || 1)) };
  const db = await createClient();
  const { rows, total } = await listNotifications(db, ctx.userId, f, PAGE_SIZE);
  const anyUnread = rows.some((n) => !n.read_at);

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Tickets, jobs, payments, package expiry and network problems that need you. Choose what you get in notification settings."
        actions={<Button asChild variant="outline" size="sm"><Link href="/notifications/settings"><Settings2 aria-hidden /> Settings</Link></Button>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant={f.unread ? "outline" : "secondary"}><Link href="/notifications">All</Link></Button>
        <Button asChild size="sm" variant={f.unread ? "secondary" : "outline"}><Link href="/notifications?unread=1">Unread</Link></Button>
        {anyUnread ? <div className="ml-auto"><ActionForm action={markReadAction} hidden={{ id: "all" }} submitLabel="Mark all as read" variant="ghost" /></div> : null}
      </div>
      {!rows.length ? (
        <EmptyState icon={<Bell />} title={f.unread ? "Nothing unread" : "No notifications yet"} />
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {rows.map((n) => (
              <div key={n.id} className="flex items-start gap-3 px-5 py-3" data-testid="notification">
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-primary"}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  {n.link ? (
                    <Link href={`/notifications/open/${n.id}`} prefetch={false} className={`text-sm hover:underline ${n.read_at ? "" : "font-semibold"}`}>{n.title}</Link>
                  ) : <p className={`text-sm ${n.read_at ? "" : "font-semibold"}`}>{n.title}</p>}
                  {n.body ? <p className="text-sm text-muted-foreground">{n.body}</p> : null}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {labelOf(NOTIFICATION_TYPES, n.type)} · {formatDateTime(n.created_at)}
                    {n.read_at ? null : <span className="sr-only"> · unread</span>}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
          <Pagination path="/notifications" params={{ unread: f.unread ? "1" : "" }} page={f.page} pageSize={PAGE_SIZE} total={total} />
        </Card>
      )}
    </>
  );
}
