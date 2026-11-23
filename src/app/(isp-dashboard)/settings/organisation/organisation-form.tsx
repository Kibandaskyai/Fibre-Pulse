"use client";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { KENYAN_COUNTIES } from "@/lib/validation/common";
import { updateOrganisationAction } from "@/modules/tenants/actions";

export type OrganisationValues = { name: string; legalName: string; county: string; town: string; contactPhone: string };

export function OrganisationForm({ values }: { values: OrganisationValues }) {
  const { state, pending, formProps } = useFormAction(updateOrganisationAction, { resetOnSuccess: false });
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      <Field id="name" label="ISP name" errors={errors?.name}>
        <Input id="name" name="name" defaultValue={values.name} required />
      </Field>
      <Field id="legalName" label="Registered company name (optional)" errors={errors?.legalName}>
        <Input id="legalName" name="legalName" defaultValue={values.legalName} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="county" label="County" errors={errors?.county}>
          <NativeSelect id="county" name="county" defaultValue={values.county || "Nairobi"}>
            {KENYAN_COUNTIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </NativeSelect>
        </Field>
        <Field id="town" label="Town" errors={errors?.town}>
          <Input id="town" name="town" defaultValue={values.town} />
        </Field>
      </div>
      <Field id="contactPhone" label="Business phone" errors={errors?.contactPhone}>
        <Input id="contactPhone" name="contactPhone" inputMode="tel" defaultValue={values.contactPhone} placeholder="0712 345 678" />
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">Save changes</SubmitButton></div>
    </form>
  );
}
