"use client";
import { useActionState, useState } from "react";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Field, FormMessage, SubmitButton } from "@/components/shared/form-bits";
import { KENYAN_COUNTIES } from "@/lib/validation/common";
import { slugify } from "@/lib/validation/tenants";
import { registerTenantAction } from "@/modules/tenants/actions";

export function RegisterIspForm({ defaultOwnerName }: { defaultOwnerName: string }) {
  const [state, action] = useActionState(registerTenantAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  return (
    <form action={action} className="grid gap-4" noValidate>
      <Field id="name" label="ISP name" errors={errors?.name}>
        <Input
          id="name"
          name="name"
          required
          placeholder="e.g. Kilimani Fibre Networks"
          onChange={(e) => {
            if (!slugEdited) setSlug(slugify(e.target.value));
          }}
          aria-invalid={Boolean(errors?.name)}
        />
      </Field>
      <Field id="slug" label="Workspace address" errors={errors?.slug} hint="Lowercase letters, numbers and hyphens. This cannot be changed later.">
        <div className="flex items-center rounded-md border border-input bg-background/60 text-sm focus-within:ring-2 focus-within:ring-ring">
          <span className="pl-3 text-muted-foreground">fibrepulse/</span>
          <input
            id="slug"
            name="slug"
            value={slug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
            }}
            className="h-9 w-full bg-transparent pr-3 outline-none"
            required
            aria-invalid={Boolean(errors?.slug)}
          />
        </div>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="county" label="County" errors={errors?.county}>
          <NativeSelect id="county" name="county" defaultValue="Nairobi" aria-invalid={Boolean(errors?.county)}>
            {KENYAN_COUNTIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="town" label="Town (optional)" errors={errors?.town}>
          <Input id="town" name="town" placeholder="e.g. Ruaka" />
        </Field>
      </div>
      <Field id="contactPhone" label="Business phone (optional)" errors={errors?.contactPhone}>
        <Input id="contactPhone" name="contactPhone" inputMode="tel" placeholder="0712 345 678" aria-invalid={Boolean(errors?.contactPhone)} />
      </Field>
      <input type="hidden" name="ownerName" value={defaultOwnerName} />
      <FormMessage state={state} />
      <SubmitButton pendingText="Creating workspace…">Register ISP</SubmitButton>
    </form>
  );
}
