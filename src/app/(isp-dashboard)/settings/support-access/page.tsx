import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { GrantBadge } from "@/components/platform/platform-badges";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { grantState, ispSupportGrants } from "@/modules/platform/billing";
import { DecideAccessForm } from "./decide-form";

export const metadata: Metadata = { title: "Support access" };

export default async function SupportAccessSettingsPage() {
  const ctx = await requirePagePermission("staff:manage");
  const res = await ispSupportGrants(await createClient(), ctx.active.tenantId);
  const rows = res.ok ? res.data.map((g) => ({ ...g, state: grantState(g) })) : [];
  const open = rows.filter((r) => r.state === "waiting" || r.state === "active");
  const past = rows.filter((r) => r.state !== "waiting" && r.state !== "active");
  return (
    <>
      <PageHeader
        title="Support access"
        description="FibrePulse support staff cannot see your customers, payments or network unless you approve a request here. Access is read-only, time-limited and every approval is audited."
      />
      {!res.ok ? <p className="text-sm text-danger">{res.message}</p> : null}
      <div className="grid gap-6 md:max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>Requests needing you</CardTitle>
            <CardDescription>Approve only what you are comfortable with. You can revoke at any time.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {open.map((g) => (
              <div key={g.id} className="grid gap-3 rounded-md border p-4" data-testid="grant-request">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">FibrePulse support</p>
                  <GrantBadge state={g.state} />
                </div>
                <p className="text-sm">{g.requested_reason}</p>
                <p className="text-xs text-muted-foreground">
                  Asked {formatDateTime(g.created_at)}
                  {g.state === "active" ? ` · access ends ${formatDateTime(g.expires_at)}` : ""}
                </p>
                <DecideAccessForm grantId={g.id} state={g.state as "waiting" | "active"} />
              </div>
            ))}
            {!open.length ? <p className="text-sm text-muted-foreground">No open requests. FibrePulse staff have no access to your data right now.</p> : null}
          </CardContent>
        </Card>
        {past.length ? (
          <Card>
            <CardHeader><CardTitle>Earlier requests</CardTitle></CardHeader>
            <CardContent className="grid gap-3">
              {past.map((g) => (
                <div key={g.id} className="flex flex-wrap items-start justify-between gap-2 border-b pb-3 last:border-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{g.requested_reason}</p>
                    <p className="text-xs text-muted-foreground">Asked {formatDateTime(g.created_at)}</p>
                  </div>
                  <GrantBadge state={g.state} />
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
