"use client";
import { NativeSelect } from "@/components/ui/native-select";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { setAccessControlAction } from "@/modules/network/actions";

/** Owner-only: how customers are authenticated, so FibrePulse disconnects the right way. */
export function AccessControlForm({ mode }: { mode: "router_secrets" | "radius" }) {
  const { state, pending, formProps } = useFormAction(setAccessControlAction, { resetOnSuccess: false });
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <Field id="access-mode" label="Customers sign in with">
        <NativeSelect id="access-mode" name="mode" defaultValue={mode} className="max-w-sm">
          <option value="router_secrets">PPPoE secrets on the MikroTik router</option>
          <option value="radius">RADIUS server</option>
        </NativeSelect>
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">Save</SubmitButton></div>
    </form>
  );
}
