import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, PlugZap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionForm } from "@/components/shared/action-form";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { publicEnv } from "@/lib/env";
import { formatDate, plural, timeAgo } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { revokeConnectorAction } from "@/modules/network/actions";
import { listConnectors, runWatchdog } from "@/modules/network/service";
import { ConnectorForm } from "./connector-form";

export const metadata: Metadata = { title: "Connectors" };

const fresh = (t: string | null) => !!t && Date.now() - Date.parse(t) < 3 * 60_000;

export default async function ConnectorsPage() {
  const ctx = await requirePagePermission("network:view");
  const db = await createClient();
  await runWatchdog(db, ctx.active.tenantId);
  const connectors = await listConnectors(db, ctx.active.tenantId);
  const canEdit = ctx.active.permissions.has("network:edit");

  return (
    <>
      <PageHeader
        title="Connectors"
        description="The FibrePulse Connector runs on a small computer inside your network. It reads your MikroTik routers and reports to FibrePulse, so routers never need to be opened to the internet."
        actions={<Button asChild variant="outline" size="sm"><Link href="/network"><ArrowLeft aria-hidden /> Network</Link></Button>}
      />
      {canEdit ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Register a connector</CardTitle>
            <CardDescription>Each connector gets its own token. One connector can watch many routers.</CardDescription>
          </CardHeader>
          <CardContent><ConnectorForm siteUrl={publicEnv().NEXT_PUBLIC_SITE_URL} /></CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Registered connectors</CardTitle>
          <CardDescription>Active means it reported in the last 3 minutes.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {connectors.length === 0 ? (
            <EmptyState className="m-5" icon={<PlugZap />} title="No connectors yet" description="Register one above, then install it on a computer that can reach your routers." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last report</TableHead>
                  <TableHead>Routers</TableHead>
                  <TableHead className="hidden md:table-cell">Token starts</TableHead>
                  <TableHead className="hidden md:table-cell">Version</TableHead>
                  {canEdit ? <TableHead><span className="sr-only">Actions</span></TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {connectors.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}<p className="text-xs text-muted-foreground">Added {formatDate(c.created_at)}</p></TableCell>
                    <TableCell>
                      {c.status === "revoked" ? <Badge variant="secondary">Revoked</Badge>
                        : c.status === "pending" ? <Badge variant="warning">Not installed yet</Badge>
                        : fresh(c.last_seen_at) ? <Badge variant="success">Reporting</Badge>
                        : <Badge variant="danger">Not reporting</Badge>}
                    </TableCell>
                    <TableCell className="text-sm">{timeAgo(c.last_seen_at)}</TableCell>
                    <TableCell className="tabular">{plural(c.routers, "router")}</TableCell>
                    <TableCell className="hidden font-mono text-xs md:table-cell">{c.token_prefix}…</TableCell>
                    <TableCell className="hidden text-xs md:table-cell">{c.agent_version ?? "—"}</TableCell>
                    {canEdit ? (
                      <TableCell className="text-right">
                        {c.status !== "revoked" ? (
                          <ActionForm action={revokeConnectorAction} hidden={{ id: c.id }} submitLabel="Revoke" variant="outline" pendingText="Revoking…" />
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
