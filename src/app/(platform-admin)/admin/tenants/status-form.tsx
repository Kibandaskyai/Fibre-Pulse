"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setTenantStatusAction } from "@/modules/platform/actions";
import type { TenantStatus } from "@/modules/platform/service";

const NEXT: Record<TenantStatus, { status: TenantStatus; label: string; variant: "default" | "destructive" | "outline" }[]> = {
  pending: [{ status: "active", label: "Activate", variant: "default" }],
  active: [{ status: "suspended", label: "Suspend", variant: "destructive" }],
  suspended: [
    { status: "active", label: "Reactivate", variant: "default" },
    { status: "deactivated", label: "Deactivate", variant: "outline" },
  ],
  deactivated: [{ status: "active", label: "Reactivate", variant: "outline" }],
};

export function TenantStatusForm({ tenantId, status }: { tenantId: string; status: TenantStatus }) {
  const [state, action, pending] = useActionState(setTenantStatusAction, null);
  const [open, setOpen] = useState<TenantStatus | null>(null);
  if (!open) {
    return (
      <div className="flex flex-wrap justify-end gap-2">
        {NEXT[status].map((n) => (
          <Button key={n.status} size="sm" variant={n.variant} onClick={() => setOpen(n.status)}>{n.label}</Button>
        ))}
        {state?.ok ? <span className="text-xs text-success">{state.message}</span> : null}
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-wrap items-start justify-end gap-2">
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="status" value={open} />
      <div className="grid gap-1">
        <Input name="reason" placeholder="Reason (audited)" required minLength={5} className="h-8 w-56" aria-label="Reason" />
        {state && !state.ok ? <span className="text-xs text-danger">{state.message}</span> : null}
      </div>
      <Button size="sm" type="submit" disabled={pending}>Confirm</Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(null)}>Cancel</Button>
    </form>
  );
}
