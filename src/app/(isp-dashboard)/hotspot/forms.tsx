"use client";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { formatKsh, formatPlanDuration } from "@/lib/format";
import { cancelCodeAction, compensateAction, giveFreeCodeAction, savePlanAction, sellCodeAction, resendCodeAction } from "@/modules/hotspot/actions";
import type { HotspotPlan } from "@/modules/hotspot/service";

type PlanOption = Pick<HotspotPlan, "id" | "name" | "price" | "duration_minutes">;

function PlanSelect({ id, plans, errors, free }: { id: string; plans: PlanOption[]; errors?: string[]; free?: boolean }) {
  return (
    <Field id={id} label="Plan" errors={errors}>
      <NativeSelect id={id} name="planId" defaultValue="">
        <option value="" disabled>Choose a plan</option>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {formatPlanDuration(p.duration_minutes)}{free ? "" : ` · ${formatKsh(p.price)}`}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

function IssuedCode({ code }: { code?: string }) {
  if (!code) return null;
  return (
    <p className="rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-center">
      <span className="block text-xs text-muted-foreground">Access code</span>
      <span className="tabular text-2xl font-semibold tracking-[0.3em]" data-testid="issued-code">{code}</span>
    </p>
  );
}

/** Owner: a customer paid to the paybill (or by Send Money) and called; issue their code. */
export function SellCodeForm({ plans }: { plans: PlanOption[] }) {
  const { state, pending, formProps } = useFormAction(sellCodeAction);
  const e = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <PlanSelect id="sell-plan" plans={plans} errors={e?.planId} />
      <Field id="sell-ref" label="M-Pesa transaction code" errors={e?.mpesaReference} hint="From the customer's M-Pesa message, e.g. SKL4H7XY2Q.">
        <Input id="sell-ref" name="mpesaReference" autoCapitalize="characters" required />
      </Field>
      <Field id="sell-phone" label="Customer phone (optional)" errors={e?.phone} hint="The code is sent here by SMS.">
        <Input id="sell-phone" name="phone" inputMode="tel" placeholder="0712 345 678" />
      </Field>
      <FormMessage state={state} />
      {state?.ok ? <IssuedCode code={state.data?.code} /> : null}
      <div><SubmitButton pending={pending} pendingText="Issuing…">Issue code</SubmitButton></div>
    </form>
  );
}

export function FreeCodeForm({ plans }: { plans: PlanOption[] }) {
  const { state, pending, formProps } = useFormAction(giveFreeCodeAction);
  const e = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <PlanSelect id="free-plan" plans={plans} errors={e?.planId} free />
      <Field id="free-reason" label="Reason" errors={e?.reason}>
        <Input id="free-reason" name="reason" placeholder="e.g. Lost 2 hours in Monday's outage" required />
      </Field>
      <Field id="free-phone" label="Customer phone (optional)" errors={e?.phone}>
        <Input id="free-phone" name="phone" inputMode="tel" placeholder="0712 345 678" />
      </Field>
      <FormMessage state={state} />
      {state?.ok ? <IssuedCode code={state.data?.code} /> : null}
      <div><SubmitButton pending={pending} variant="outline" pendingText="Issuing…">Give free code</SubmitButton></div>
    </form>
  );
}

export function CompensateForm() {
  const { state, pending, formProps } = useFormAction(compensateAction);
  const e = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <Field id="comp-minutes" label="Minutes to add to every running code" errors={e?.minutes}>
        <Input id="comp-minutes" name="minutes" inputMode="numeric" placeholder="60" required />
      </Field>
      <Field id="comp-reason" label="Reason" errors={e?.reason}>
        <Input id="comp-reason" name="reason" placeholder="Safaricom outage 2 pm to 3 pm" required />
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} variant="outline" pendingText="Adding…">Add time</SubmitButton></div>
    </form>
  );
}

export function ResendCodeForm({ id, phone }: { id: string; phone: string | null }) {
  const { state, pending, formProps } = useFormAction(resendCodeAction);
  return (
    <form {...formProps} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end" noValidate>
      <input type="hidden" name="id" value={id} />
      <Field id={`resend-${id}`} label="Send to">
        <Input id={`resend-${id}`} name="phone" type="tel" defaultValue={phone ? phone.replace(/^\+254/, "0") : ""} placeholder="0712 345 678" />
      </Field>
      <SubmitButton pending={pending} variant="outline" size="sm" pendingText="Sending…">Send code by SMS</SubmitButton>
      <div className="sm:col-span-2"><FormMessage state={state} /></div>
    </form>
  );
}

export function CancelCodeForm({ id, code }: { id: string; code: string }) {
  const { state, pending, formProps } = useFormAction(cancelCodeAction);
  return (
    <form {...formProps} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end" noValidate>
      <input type="hidden" name="id" value={id} />
      <Field id={`cancel-${id}`} label={`Reason for cancelling ${code}`}>
        <Input id={`cancel-${id}`} name="reason" placeholder="e.g. Paid twice by mistake" />
      </Field>
      <SubmitButton pending={pending} variant="destructive" size="sm" pendingText="Cancelling…">Cancel code</SubmitButton>
      <div className="sm:col-span-2"><FormMessage state={state} /></div>
    </form>
  );
}

function durationParts(minutes: number | undefined): { value: number | ""; unit: "minutes" | "hours" | "days" } {
  if (!minutes) return { value: "", unit: "hours" };
  if (minutes % 1440 === 0 && minutes > 1440) return { value: minutes / 1440, unit: "days" };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: "hours" };
  return { value: minutes, unit: "minutes" };
}

export function PlanForm({ plan }: { plan?: HotspotPlan }) {
  const { state, pending, formProps } = useFormAction(savePlanAction, { resetOnSuccess: false });
  const e = state && !state.ok ? state.fieldErrors : undefined;
  const d = durationParts(plan?.duration_minutes);
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      {plan ? <input type="hidden" name="id" value={plan.id} /> : null}
      <Field id="plan-name" label="Plan name" errors={e?.name} hint="What buyers see, e.g. 24 hours.">
        <Input id="plan-name" name="name" required defaultValue={plan?.name} placeholder="24 hours" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="plan-duration" label="Time bought" errors={e?.durationValue}>
          <Input id="plan-duration" name="durationValue" inputMode="numeric" required defaultValue={d.value} />
        </Field>
        <Field id="plan-unit" label="Unit">
          <NativeSelect id="plan-unit" name="durationUnit" defaultValue={d.unit}>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </NativeSelect>
        </Field>
        <Field id="plan-price" label="Price (Ksh)" errors={e?.price} hint="Whole shillings.">
          <Input id="plan-price" name="price" inputMode="numeric" required defaultValue={plan?.price ?? ""} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="plan-down" label="Download (Mbps)" errors={e?.downloadMbps}>
          <Input id="plan-down" name="downloadMbps" inputMode="decimal" required defaultValue={plan?.download_mbps ?? 10} />
        </Field>
        <Field id="plan-up" label="Upload (Mbps)" errors={e?.uploadMbps} hint="Blank = same as download.">
          <Input id="plan-up" name="uploadMbps" inputMode="decimal" defaultValue={plan?.upload_mbps ?? ""} />
        </Field>
        <Field id="plan-type" label="Plan type" errors={e?.usageType}>
          <NativeSelect id="plan-type" name="usageType" defaultValue={plan?.usage_type ?? "unlimited"}>
            <option value="unlimited">Unlimited</option>
            <option value="limited">Limited</option>
          </NativeSelect>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="plan-cap" label="Data for the period (GB)" errors={e?.dataLimitGb} hint="Limited plans only, e.g. 1 for 1 GB. The buyer is cut off when it runs out or the time ends, whichever comes first.">
          <Input id="plan-cap" name="dataLimitGb" inputMode="decimal" defaultValue={plan?.data_limit_mb ? String(Math.round((plan.data_limit_mb / 1024) * 100) / 100) : ""} />
        </Field>
        <Field id="plan-profile" label="Router profile" errors={e?.networkProfile} hint="Optional MikroTik/RADIUS profile.">
          <Input id="plan-profile" name="networkProfile" defaultValue={plan?.network_profile ?? ""} />
        </Field>
        <Field id="plan-order" label="Order on the WiFi page" errors={e?.sortOrder}>
          <Input id="plan-order" name="sortOrder" inputMode="numeric" defaultValue={plan?.sort_order ?? ""} />
        </Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">{plan ? "Save plan" : "Create plan"}</SubmitButton></div>
    </form>
  );
}
