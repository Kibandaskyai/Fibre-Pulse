"use client";
import { FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { Badge } from "@/components/ui/badge";
import { setRouterEnforcementAction } from "@/modules/network/actions";

/** Owner-only switch: whether suspending a customer disconnects them on the MikroTik router. */
export function EnforcementForm({ enabled }: { enabled: boolean }) {
  const { state, pending, formProps } = useFormAction(setRouterEnforcementAction);
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <p className="text-sm">
        Status: {enabled ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>}
      </p>
      <FormMessage state={state} />
      <div>
        <SubmitButton pending={pending} variant={enabled ? "outline" : "default"} pendingText="Saving…">
          {enabled ? "Turn off" : "Turn on"}
        </SubmitButton>
      </div>
    </form>
  );
}
