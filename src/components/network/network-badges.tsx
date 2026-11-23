import { AlertOctagon, AlertTriangle, CheckCircle2, CircleHelp, Info, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Router reachability. Status colours carry an icon and a word, never colour alone. */
export function RouterStatusBadge({ status }: { status: string }) {
  if (status === "online") return <Badge variant="success"><CheckCircle2 className="size-3" aria-hidden /> Online</Badge>;
  if (status === "offline") return <Badge variant="danger"><WifiOff className="size-3" aria-hidden /> Offline</Badge>;
  return <Badge variant="secondary" title="No recent report from the connector."><CircleHelp className="size-3" aria-hidden /> Unknown</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  if (severity === "critical") return <Badge variant="danger"><AlertOctagon className="size-3" aria-hidden /> Critical</Badge>;
  if (severity === "warning") return <Badge variant="warning"><AlertTriangle className="size-3" aria-hidden /> Warning</Badge>;
  return <Badge variant="secondary"><Info className="size-3" aria-hidden /> Info</Badge>;
}

const ALERT_STATUS: Record<string, { label: string; variant: "danger" | "warning" | "secondary" }> = {
  open: { label: "Open", variant: "danger" },
  acknowledged: { label: "Acknowledged", variant: "warning" },
  resolved: { label: "Resolved", variant: "secondary" },
};
export function AlertStatusBadge({ status }: { status: string }) {
  const s = ALERT_STATUS[status] ?? { label: status, variant: "secondary" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

const COMMAND_STATUS: Record<string, { label: string; variant: "success" | "warning" | "danger" | "secondary" }> = {
  queued: { label: "Waiting for connector", variant: "warning" },
  sent: { label: "Sent to router", variant: "warning" },
  succeeded: { label: "Done", variant: "success" },
  failed: { label: "Failed", variant: "danger" },
  blocked: { label: "Blocked", variant: "danger" },
  cancelled: { label: "Cancelled", variant: "secondary" },
  expired: { label: "Expired", variant: "secondary" },
};
export function CommandStatusBadge({ status }: { status: string }) {
  const s = COMMAND_STATUS[status] ?? { label: status, variant: "secondary" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

export const COMMAND_LABELS: Record<string, string> = { disconnect_pppoe: "Disconnect", reconnect_pppoe: "Reconnect" };

/** A percentage with the status colour only past the alert thresholds. */
export function LoadValue({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const cls = value >= 90 ? "text-danger" : value >= 75 ? "text-warning" : "";
  return <span className={`tabular ${cls}`}>{Math.round(value)}%</span>;
}
