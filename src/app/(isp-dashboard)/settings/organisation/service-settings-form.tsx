"use client";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { saveServiceSettingsAction } from "@/modules/hotspot/actions";
import type { ServiceSettings } from "@/modules/hotspot/service";

const METHODS: { value: ServiceSettings["methods"][number]; label: string }[] = [
  { value: "mpesa", label: "M-Pesa" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
];

/** Paybill, accepted payment methods and the internet provider whose line is watched. */
export function ServiceSettingsForm({ values }: { values: ServiceSettings }) {
  const { state, pending, formProps } = useFormAction(saveServiceSettingsAction);
  const fe = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Payment methods you accept</legend>
        <div className="flex flex-wrap gap-4">
          {METHODS.map((m) => (
            <label key={m.value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="methods" value={m.value} defaultChecked={values.methods.includes(m.value)} className="size-4 accent-primary" />
              {m.label}
            </label>
          ))}
        </div>
        {fe?.methods?.length ? <p className="text-xs text-danger">{fe.methods[0]}</p> : null}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="svc-paybill" label="M-Pesa paybill number" errors={fe?.paybill}>
          <Input id="svc-paybill" name="paybill" inputMode="numeric" defaultValue={values.paybill ?? ""} placeholder="123456" />
        </Field>
        <Field id="svc-account" label="Paybill account number" errors={fe?.accountNumber}>
          <Input id="svc-account" name="accountNumber" defaultValue={values.accountNumber ?? ""} placeholder="What buyers type as the account" />
        </Field>
        <Field id="svc-provider" label="Your internet provider" errors={fe?.upstreamProvider}>
          <Input id="svc-provider" name="upstreamProvider" defaultValue={values.upstreamProvider} />
        </Field>
        <Field id="svc-phone" label="Provider support phone" errors={fe?.upstreamPhone}>
          <Input id="svc-phone" name="upstreamPhone" type="tel" defaultValue={values.upstreamPhone ?? ""} placeholder="Shown on the outage banner" />
        </Field>
        <Field id="svc-target" label="Address the router pings to check the internet" errors={fe?.upstreamCheckTarget}>
          <Input id="svc-target" name="upstreamCheckTarget" inputMode="decimal" defaultValue={values.upstreamCheckTarget} />
        </Field>
        <Field id="svc-clock" label="Hotspot time starts" errors={fe?.hotspotClockStart}>
          <NativeSelect id="svc-clock" name="hotspotClockStart" defaultValue={values.hotspotClockStart}>
            <option value="payment">When the code is paid for</option>
            <option value="first_login">When the code is first used (unused codes never run out)</option>
          </NativeSelect>
        </Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">Save payment settings</SubmitButton></div>
    </form>
  );
}
