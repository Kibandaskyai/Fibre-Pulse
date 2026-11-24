import Link from "next/link";
import { CloudOff, PhoneCall, Users, Wifi, WifiOff } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { formatDateTime, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { NetworkStatus } from "@/modules/hotspot/service";

const tel = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

/**
 * The bar across the top of every ISP page when the internet is down: the
 * owner sees at once that it is the provider (Safaricom) and whom to call.
 */
export function NetworkBanner({ status }: { status: NetworkStatus | null }) {
  if (!status || (status.state !== "upstream_down" && status.state !== "site_unreachable")) return null;
  const down = status.state === "upstream_down";
  return (
    <div
      role="alert"
      data-testid="network-banner"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-sm text-foreground sm:px-6",
        down ? "border-danger/40 bg-danger/15" : "border-warning/40 bg-warning/15",
      )}
    >
      {down ? <WifiOff className="size-4 shrink-0 text-danger" aria-hidden /> : <CloudOff className="size-4 shrink-0 text-warning" aria-hidden />}
      <span className="font-semibold">{down ? `Network unavailable: no internet from ${status.provider}` : "FibrePulse cannot reach your network"}</span>
      <span className="text-muted-foreground">
        {down
          ? `since ${formatDateTime(status.since)} (${timeAgo(status.since)}). Customers cannot browse. Contact ${status.provider} to report the outage.`
          : `since ${formatDateTime(status.since)}. Power, the server or its internet link may be down.`}
      </span>
      {down && status.provider_phone ? (
        <a href={tel(status.provider_phone)} className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline">
          <PhoneCall className="size-3.5" aria-hidden /> Call {status.provider} ({status.provider_phone})
        </a>
      ) : null}
      {status.simulated ? <DataSourceBadge source="simulated" /> : null}
    </div>
  );
}

/** Network state and people online right now, for the Overview and Hotspot pages. */
export function NetworkStatusCard({ status }: { status: NetworkStatus | null }) {
  if (!status) return null;
  const state = status.state;
  const label =
    state === "ok"
      ? "Network up"
      : state === "upstream_down"
        ? `Network unavailable: ${status.provider} is down`
        : state === "site_unreachable"
          ? "Cannot reach your network"
          : "Not monitored yet";
  const tone = state === "ok" ? "text-success" : state === "upstream_down" ? "text-danger" : "text-warning";
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-KE"));
  return (
    <Card data-testid="network-status">
      <CardContent className="grid gap-4 pt-5 sm:grid-cols-[1.2fr_1fr_1fr_1fr] sm:items-center">
        <div className="flex items-start gap-3">
          {state === "ok" ? <Wifi className={cn("mt-0.5 size-5", tone)} aria-hidden /> : <WifiOff className={cn("mt-0.5 size-5", tone)} aria-hidden />}
          <div>
            <p className={cn("font-semibold", tone)}>{label}</p>
            <p className="text-xs text-muted-foreground">
              {state === "not_monitored" ? (
                <>Install the <Link href="/network/connectors" className="underline">FibrePulse Connector</Link> to see who is online and when {status.provider} is down.</>
              ) : state === "ok" ? (
                `Internet from ${status.provider} is reaching your routers.`
              ) : state === "upstream_down" ? (
                `Since ${formatDateTime(status.since)}.${status.provider_phone ? ` Call ${status.provider} on ${status.provider_phone}.` : ""}`
              ) : (
                `Last heard ${timeAgo(status.since)}.`
              )}
            </p>
            {status.simulated || status.online_simulated ? <div className="mt-1"><DataSourceBadge source="simulated" /></div> : null}
          </div>
        </div>
        <Stat label="People online now" value={fmt(status.online_total)} strong />
        <Stat label="Hotspot devices" value={fmt(status.online_hotspot)} />
        <Stat label="Monthly (own router)" value={fmt(status.online_pppoe)} />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">{strong ? <Users className="size-3.5" aria-hidden /> : null}{label}</p>
      <p className={cn("tabular font-semibold", strong ? "text-3xl" : "text-xl")} data-testid={strong ? "people-online" : undefined}>{value}</p>
    </div>
  );
}
