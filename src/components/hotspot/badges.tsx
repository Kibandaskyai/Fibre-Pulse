import { Badge } from "@/components/ui/badge";
import { VOUCHER_SOURCE_LABELS, VOUCHER_STATUS_LABELS, type VoucherSource, type VoucherStatus } from "@/modules/hotspot/service";

export function VoucherStatusBadge({ status }: { status: VoucherStatus }) {
  const variant = status === "active" ? "success" : status === "unused" ? "accent" : status === "awaiting_payment" ? "warning" : status === "payment_failed" || status === "cancelled" ? "danger" : "secondary";
  return <Badge variant={variant}>{VOUCHER_STATUS_LABELS[status]}</Badge>;
}

export function VoucherSourceText({ source }: { source: VoucherSource }) {
  return <span className="text-xs text-muted-foreground">{VOUCHER_SOURCE_LABELS[source]}</span>;
}

/** The ISP's own "Limited" / "Unlimited" label, as in their current system. */
export function UsageTypeBadge({ type }: { type: "limited" | "unlimited" }) {
  return <Badge variant={type === "unlimited" ? "success" : "warning"}>{type === "unlimited" ? "Unlimited" : "Limited"}</Badge>;
}
