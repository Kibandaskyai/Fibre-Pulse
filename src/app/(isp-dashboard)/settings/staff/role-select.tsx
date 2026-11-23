"use client";
import { useActionState } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import { TENANT_ROLES, ROLE_LABELS, type TenantRole } from "@/lib/auth/permissions";
import { changeRoleAction } from "@/modules/tenants/actions";

/** Changes a member's role as soon as a new role is picked. */
export function RoleSelect({ memberId, role, name, disabled }: { memberId: string; role: TenantRole; name: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState(changeRoleAction, null);
  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="memberId" value={memberId} />
      <NativeSelect
        name="role"
        defaultValue={role}
        disabled={disabled || pending}
        aria-label={`Role for ${name}`}
        className="h-8 min-w-44"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {TENANT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
      </NativeSelect>
      {state && !state.ok ? <span className="text-xs text-danger">{state.message}</span> : null}
    </form>
  );
}
