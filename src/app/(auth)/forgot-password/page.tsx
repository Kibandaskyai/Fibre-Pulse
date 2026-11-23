"use client";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { forgotPasswordAction } from "@/modules/auth/actions";

export default function ForgotPasswordPage() {
  const { state, pending, formProps } = useFormAction(forgotPasswordAction);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">We will email you a link to choose a new one.</p>
      <form {...formProps} className="grid gap-4" noValidate>
        <Field id="email" label="Email" errors={errors?.email}>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <FormMessage state={state} />
        <SubmitButton pending={pending} pendingText="Sending…">Send reset link</SubmitButton>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
