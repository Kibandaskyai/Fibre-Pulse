"use client";
import { useActionState } from "react";
import { Brand } from "@/components/layout/brand";
import { Input } from "@/components/ui/input";
import { Field, FormMessage, SubmitButton } from "@/components/shared/form-bits";
import { resetPasswordAction } from "@/modules/auth/actions";

export default function ResetPasswordPage() {
  const [state, action] = useActionState(resetPasswordAction, null);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8"><Brand /></div>
        <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
        <form action={action} className="mt-6 grid gap-4" noValidate>
          <Field id="password" label="New password" errors={errors?.password} hint="At least 10 characters, with upper and lower case letters and a number.">
            <Input id="password" name="password" type="password" autoComplete="new-password" required />
          </Field>
          <Field id="confirm" label="Confirm new password" errors={errors?.confirm}>
            <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
          </Field>
          <FormMessage state={state} />
          <SubmitButton pendingText="Saving…">Save password</SubmitButton>
        </form>
      </div>
    </div>
  );
}
