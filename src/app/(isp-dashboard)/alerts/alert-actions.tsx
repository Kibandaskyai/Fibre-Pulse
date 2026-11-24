"use client";
import { Input } from "@/components/ui/input";
import { FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { updateAlertAction } from "@/modules/network/actions";

/** Acknowledge or resolve one alert, with an optional note for the audit log. */
export function AlertActions({ alertId, status }: { alertId: string; status: string }) {
  const { state, pending, formProps } = useFormAction(updateAlertAction);
  if (status === "resolved") return null;
  return (
    <form {...formProps} className="grid gap-2" noValidate>
      <input type="hidden" name="alertId" value={alertId} />
      <Input name="note" placeholder="Note (optional)" aria-label="Note" maxLength={300} className="h-8 text-xs" />
      <div className="flex flex-wrap gap-2">
        {status === "open" ? (
          <SubmitButton pending={pending} size="sm" variant="outline" name="action" value="acknowledge">Acknowledge</SubmitButton>
        ) : null}
        <SubmitButton pending={pending} size="sm" variant="outline" name="action" value="resolve">Resolve</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
