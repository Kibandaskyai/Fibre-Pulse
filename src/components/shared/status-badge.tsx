import { Badge } from "@/components/ui/badge";

const TENANT: Record<string, { label: string; variant: "success" | "warning" | "danger" | "secondary" }> = {
  active: { label: "Active", variant: "success" },
  pending: { label: "Pending activation", variant: "warning" },
  suspended: { label: "Suspended", variant: "danger" },
  deactivated: { label: "Deactivated", variant: "secondary" },
  disabled: { label: "Disabled", variant: "secondary" },
};

export function TenantStatusBadge({ status }: { status: string }) {
  const s = TENANT[status] ?? { label: status, variant: "secondary" as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}
