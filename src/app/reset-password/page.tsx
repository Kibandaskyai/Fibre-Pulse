"use client";
import { BrandLogo } from "@/components/layout/brand";
import { Input } from "@/components/ui/input";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { resetPasswordAction } from "@/modules/auth/actions";

export default function ResetPasswordPage() {
  const { state, pending, formProps } = useFormAction(resetPasswordAction);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8"><BrandLogo className="w-56" /></div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <form {...formProps} className="mt-6 grid gap-4" noValidate>
          <Field id="password" label="New password" errors={errors?.password} hint="At least 10 characters, with upper and lower case letters and a number.">
            <Input id="password" name="password" type="password" autoComplete="new-password" required />
          </Field>
          <Field id="confirm" label="Confirm new password" errors={errors?.confirm}>
            <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
          </Field>
          <FormMessage state={state} />
          <SubmitButton pending={pending} pendingText="Saving…">Save password</SubmitButton>
        </form>
      </div>
    </div>
  );
}
