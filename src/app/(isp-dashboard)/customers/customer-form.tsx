"use client";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { KENYAN_COUNTIES } from "@/lib/validation/common";
import { createCustomerAction, updateCustomerAction } from "@/modules/customers/actions";
import type { Customer } from "@/modules/customers/service";

const STATUS_OPTIONS = [
  ["pending_installation", "Pending installation"],
  ["active", "Active"],
  ["suspended", "Suspended"],
  ["disconnected", "Disconnected"],
  ["terminated", "Terminated"],
] as const;

export function CustomerForm({
  customer,
  location,
  canSetLocation,
}: {
  customer?: Customer;
  location?: { latitude: number; longitude: number } | null;
  canSetLocation: boolean;
}) {
  const { state, pending, formProps } = useFormAction(customer ? updateCustomerAction : createCustomerAction, { resetOnSuccess: false });
  const e = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      {customer ? <input type="hidden" name="id" value={customer.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="c-name" label="Full name" errors={e?.fullName}>
          <Input id="c-name" name="fullName" required autoComplete="off" defaultValue={customer?.full_name} />
        </Field>
        <Field id="c-phone" label="Phone" errors={e?.phone} hint="Kenyan mobile, e.g. 0712 345 678. Used for M-Pesa matching.">
          <Input id="c-phone" name="phone" type="tel" required inputMode="tel" defaultValue={customer?.phone} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="c-email" label="Email (optional)" errors={e?.email}>
          <Input id="c-email" name="email" type="email" defaultValue={customer?.email ?? ""} />
        </Field>
        <Field id="c-status" label="Status" errors={e?.status}>
          <NativeSelect id="c-status" name="status" defaultValue={customer?.status ?? "pending_installation"}>
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="c-address" label="Address or building" errors={e?.address}>
        <Input id="c-address" name="address" defaultValue={customer?.address ?? ""} placeholder="House 14, Garden Court" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="c-estate" label="Estate" errors={e?.estate}>
          <Input id="c-estate" name="estate" defaultValue={customer?.estate ?? ""} />
        </Field>
        <Field id="c-town" label="Town" errors={e?.town}>
          <Input id="c-town" name="town" defaultValue={customer?.town ?? ""} />
        </Field>
        <Field id="c-county" label="County" errors={e?.county}>
          <NativeSelect id="c-county" name="county" defaultValue={customer?.county ?? ""}>
            <option value="">Choose…</option>
            {KENYAN_COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="c-pppoe" label="PPPoE username (optional)" errors={e?.pppoeUsername} hint="Must match the router so sessions can be linked to this customer.">
        <Input id="c-pppoe" name="pppoeUsername" autoComplete="off" defaultValue={customer?.pppoe_username ?? ""} />
      </Field>
      {canSetLocation ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="c-lat" label="Latitude (optional)" errors={e?.latitude}>
            <Input id="c-lat" name="latitude" inputMode="decimal" defaultValue={location?.latitude ?? ""} placeholder="-1.2190" />
          </Field>
          <Field id="c-lng" label="Longitude (optional)" errors={e?.longitude} hint="Exact location is visible only to roles allowed to see it.">
            <Input id="c-lng" name="longitude" inputMode="decimal" defaultValue={location?.longitude ?? ""} placeholder="36.8890" />
          </Field>
        </div>
      ) : null}
      <Field id="c-notes" label="Notes" errors={e?.notes}>
        <Textarea id="c-notes" name="notes" rows={3} defaultValue={customer?.notes ?? ""} />
      </Field>
      <FormMessage state={state} />
      <div>
        <SubmitButton pending={pending} pendingText="Saving…">{customer ? "Save customer" : "Add customer"}</SubmitButton>
      </div>
    </form>
  );
}
