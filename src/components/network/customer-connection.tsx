import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionForm } from "@/components/shared/action-form";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { Badge } from "@/components/ui/badge";
import { COMMAND_LABELS, CommandStatusBadge } from "@/components/network/network-badges";
import { formatDateTime, timeAgo } from "@/lib/format";
import { assignCustomerRouterAction, retryRouterCommandAction } from "@/modules/network/actions";
import type { customerConnection } from "@/modules/network/service";

type Connection = Awaited<ReturnType<typeof customerConnection>>;

/** Connection status, router assignment and router disconnect history for one customer. */
export function CustomerConnectionCard({
  customerId, connection, routers, canSeeNetwork, canAssign, canRetry, enforcement,
}: {
  customerId: string; connection: Connection; routers: { id: string; name: string }[];
  canSeeNetwork: boolean; canAssign: boolean; canRetry: boolean; enforcement: boolean;
}) {
  const { sessions, router, routerId, pppoeUsername, commands, lastEnded } = connection;
  const online = sessions && sessions.length > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Connection
          {canSeeNetwork && sessions ? (
            online ? <Badge variant="success">Online</Badge> : <Badge variant="secondary">Offline</Badge>
          ) : null}
          {online && sessions?.some((s) => s.data_source === "simulated") ? <DataSourceBadge source="simulated" /> : null}
        </CardTitle>
        <CardDescription>
          {pppoeUsername ? `PPPoE user ${pppoeUsername}` : "No PPPoE username yet. Add it on Edit so sessions and disconnects can find this customer."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {canSeeNetwork && sessions ? (
          online ? (
            <ul className="grid gap-1">
              {sessions.map((s) => (
                <li key={s.id}>
                  {s.routers?.name ?? "Router"} · {s.ip_address ?? "no IP"} · connected {timeAgo(s.started_at)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No active session.{lastEnded ? ` Last seen ${formatDateTime(lastEnded)}.` : ""}</p>
          )
        ) : null}

        {canAssign ? (
          <ActionForm action={assignCustomerRouterAction} submitLabel="Save router" variant="outline" hidden={{ customerId }}>
            <Label htmlFor="cust-router">Router</Label>
            <NativeSelect id="cust-router" name="routerId" defaultValue={routerId ?? ""}>
              <option value="">Learn from the first session</option>
              {routers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </NativeSelect>
          </ActionForm>
        ) : (
          <p>Router: {router?.name ?? <span className="text-muted-foreground">not known yet</span>}</p>
        )}

        <div className="grid gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            {enforcement ? "Suspending disconnects this customer on the router; restoring reconnects them." : "Router disconnect is off for your ISP. The owner can turn it on in Settings > Organisation."}
          </p>
          {commands.length ? (
            <ul className="grid gap-3">
              {commands.map((cmd) => (
                <li key={cmd.id} className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{COMMAND_LABELS[cmd.command_type] ?? cmd.command_type}</span>
                    <CommandStatusBadge status={cmd.status} />
                    <span className="text-xs text-muted-foreground">{formatDateTime(cmd.created_at)}</span>
                  </div>
                  {cmd.result_message ? <p className="text-xs text-muted-foreground">{cmd.result_message}</p> : null}
                  {canRetry && ["failed", "blocked", "expired"].includes(cmd.status) ? (
                    <ActionForm action={retryRouterCommandAction} submitLabel="Try again" variant="outline" pendingText="Queuing…" hidden={{ id: cmd.id, customerId }} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {canSeeNetwork && routerId ? <Link className="text-xs text-primary hover:underline" href={`/network/routers/${routerId}`}>Open router</Link> : null}
        </div>
      </CardContent>
    </Card>
  );
}
