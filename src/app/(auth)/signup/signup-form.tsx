"use client";
import { Input } from "@/components/ui/input";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { signUpAction } from "@/modules/auth/actions";

export function SignupForm() {
  const { state, pending, formProps } = useFormAction(signUpAction);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  if (state?.ok) return <FormMessage state={state} />;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      <Field id="fullName" label="Full name" errors={errors?.fullName}>
        <Input id="fullName" name="fullName" autoComplete="name" required aria-invalid={Boolean(errors?.fullName)} />
      </Field>
      <Field id="email" label="Work email" errors={errors?.email} hint="If you were invited, use the email the invitation was sent to.">
        <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(errors?.email)} />
      </Field>
      <Field id="password" label="Password" errors={errors?.password} hint="At least 10 characters, with upper and lower case letters and a number.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required aria-invalid={Boolean(errors?.password)} />
      </Field>
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingText="Creating account…">Create account</SubmitButton>
    </form>
  );
}
