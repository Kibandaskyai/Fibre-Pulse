"use client";
import { NativeSelect } from "@/components/ui/native-select";
import { FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { decideSupportAccessAction } from "@/modules/platform/billing-actions";

const HOURS = [1, 4, 8, 24, 48, 72];

export function DecideAccessForm({ grantId, state }: { grantId: string; state: "waiting" | "active" }) {
  const approve = useFormAction(decideSupportAccessAction);
  const other = useFormAction(decideSupportAccessAction);
  if (state === "active") {
    return (
      <form {...other.formProps} className="grid gap-2">
        <input type="hidden" name="grantId" value={grantId} />
        <input type="hidden" name="decision" value="revoke" />
        <div><SubmitButton pending={other.pending} variant="destructive" size="sm">Revoke now</SubmitButton></div>
        <FormMessage state={other.state ?? approve.state} />
      </form>
    );
  }
  return (
    <div className="grid gap-2">
      <form {...approve.formProps} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="grantId" value={grantId} />
        <input type="hidden" name="decision" value="approve" />
        <label htmlFor={`hours-${grantId}`} className="text-sm">For</label>
        <NativeSelect id={`hours-${grantId}`} name="hours" defaultValue="24" className="w-32">
          {HOURS.map((h) => <option key={h} value={h}>{h} hour{h === 1 ? "" : "s"}</option>)}
        </NativeSelect>
        <SubmitButton pending={approve.pending} size="sm">Approve</SubmitButton>
      </form>
      <form {...other.formProps}>
        <input type="hidden" name="grantId" value={grantId} />
        <input type="hidden" name="decision" value="decline" />
        <SubmitButton pending={other.pending} variant="ghost" size="sm">Decline</SubmitButton>
      </form>
      <FormMessage state={approve.state ?? other.state} />
    </div>
  );
}
