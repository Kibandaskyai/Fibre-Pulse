import { Badge } from "@/components/ui/badge";

type Variant = "success" | "warning" | "danger" | "secondary" | "default" | "accent";
const make = (map: Record<string, [string, Variant]>) =>
  function StatusBadge({ status }: { status: string }) {
    const [label, variant] = map[status] ?? [status, "secondary" as const];
    return <Badge variant={variant}>{label}</Badge>;
  };

export const CustomerStatusBadge = make({
  active: ["Active", "success"],
  suspended: ["Suspended", "danger"],
  pending_installation: ["Pending installation", "warning"],
  disconnected: ["Disconnected", "secondary"],
  terminated: ["Terminated", "secondary"],
});

export const PackageStatusBadge = make({
  active: ["Active", "success"],
  inactive: ["Not for sale", "warning"],
  archived: ["Archived", "secondary"],
});

export const SubscriptionStatusBadge = make({
  pending: ["Pending", "warning"],
  active: ["Active", "success"],
  suspended: ["Suspended", "danger"],
  expired: ["Expired", "secondary"],
  cancelled: ["Cancelled", "secondary"],
});

export const InvoiceStatusBadge = make({
  draft: ["Draft", "secondary"],
  issued: ["Unpaid", "warning"],
  partially_paid: ["Part paid", "accent"],
  paid: ["Paid", "success"],
  void: ["Void", "secondary"],
});

export const PaymentStatusBadge = make({
  pending: ["Pending", "warning"],
  successful: ["Successful", "success"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "secondary"],
  reversed: ["Reversed", "danger"],
  refunded: ["Refunded", "secondary"],
});

export const VerificationBadge = make({
  unverified: ["Awaiting verification", "warning"],
  verified: ["Verified", "success"],
  rejected: ["Rejected", "danger"],
});
