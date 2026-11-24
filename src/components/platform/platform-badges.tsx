import { Badge } from "@/components/ui/badge";

type V = "success" | "warning" | "secondary" | "danger" | "default";

const AGREEMENT: Record<string, { label: string; variant: V }> = {
  draft: { label: "Draft, not signed", variant: "warning" },
  active: { label: "In force", variant: "success" },
  superseded: { label: "Replaced", variant: "secondary" },
  terminated: { label: "Ended", variant: "secondary" },
  signed: { label: "Signed", variant: "success" },
  none: { label: "No agreement", variant: "danger" },
};

export function AgreementBadge({ status }: { status: string }) {
  const s = AGREEMENT[status] ?? { label: status, variant: "secondary" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

const INVOICE: Record<string, { label: string; variant: V }> = {
  draft: { label: "Draft", variant: "secondary" },
  issued: { label: "Unpaid", variant: "warning" },
  overdue: { label: "Overdue", variant: "danger" },
  paid: { label: "Paid", variant: "success" },
  void: { label: "Void", variant: "secondary" },
  calculated: { label: "Not invoiced yet", variant: "default" },
  invoiced: { label: "Invoiced", variant: "secondary" },
};

export function PlatformInvoiceBadge({ status }: { status: string }) {
  const s = INVOICE[status] ?? { label: status, variant: "secondary" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

const GRANT: Record<string, { label: string; variant: V }> = {
  waiting: { label: "Waiting for the owner", variant: "warning" },
  active: { label: "Access active", variant: "success" },
  expired: { label: "Expired", variant: "secondary" },
  revoked: { label: "Revoked", variant: "secondary" },
  declined: { label: "Declined", variant: "danger" },
};

export function GrantBadge({ state }: { state: string }) {
  const s = GRANT[state] ?? { label: state, variant: "secondary" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
