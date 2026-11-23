"use client";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { INVITABLE_ROLES, ROLE_LABELS } from "@/lib/auth/permissions";
import { inviteStaffAction } from "@/modules/tenants/actions";

export function InviteForm() {
  const { state, pending, formProps } = useFormAction(inviteStaffAction);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      <Field id="invite-email" label="Email" errors={errors?.email}>
        <Input id="invite-email" name="email" type="email" required placeholder="name@yourisp.co.ke" />
      </Field>
      <Field id="invite-role" label="Role" errors={errors?.role}>
        <NativeSelect id="invite-role" name="role" defaultValue="support_agent">
          {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </NativeSelect>
      </Field>
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingText="Inviting…">Create invitation</SubmitButton>
    </form>
  );
}
