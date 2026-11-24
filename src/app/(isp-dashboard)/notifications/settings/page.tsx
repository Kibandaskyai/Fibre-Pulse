import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/shared/page-header";
import { requireTenant } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import { preferences } from "@/modules/notifications/service";
import { IspPreferencesForm, MyPreferencesForm } from "./preference-forms";

export const metadata: Metadata = { title: "Notification settings" };

export default async function NotificationSettingsPage() {
  const ctx = await requireTenant();
  const rows = await preferences(await createClient(), ctx.active.tenantId, ctx.userId);
  const isOwner = ctx.active.permissions.has("settings:manage");
  return (
    <>
      <PageHeader
        title="Notification settings"
        description="You only get notifications your role is involved in. Email and SMS choices are saved now and start once FibrePulse connects an email and SMS provider."
        actions={<Button asChild variant="outline" size="sm"><Link href="/notifications"><ArrowLeft aria-hidden /> Notifications</Link></Button>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader><CardTitle>My notifications</CardTitle></CardHeader>
          <CardContent><MyPreferencesForm rows={rows} /></CardContent>
        </Card>
        {isOwner ? (
          <Card className="h-fit">
            <CardHeader>
              <CardTitle>For everyone in your ISP</CardTitle>
              <CardDescription>Untick a notification to stop it for all staff.</CardDescription>
            </CardHeader>
            <CardContent><IspPreferencesForm rows={rows} /></CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
