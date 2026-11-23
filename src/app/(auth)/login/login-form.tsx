"use client";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { signInAction } from "@/modules/auth/actions";

export function LoginForm({ next }: { next?: string }) {
  const { state, pending, formProps } = useFormAction(signInAction);
  const errors = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      <input type="hidden" name="next" value={next ?? ""} />
      <Field id="email" label="Email" errors={errors?.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required aria-invalid={Boolean(errors?.email)} />
      </Field>
      <Field id="password" label="Password" errors={errors?.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required aria-invalid={Boolean(errors?.password)} />
      </Field>
      <div className="-mt-2 text-right">
        <Link href="/forgot-password" className="text-xs text-primary hover:underline">
          Forgot password?
        </Link>
      </div>
      <FormMessage state={state} />
      <SubmitButton pending={pending} pendingText="Signing in…">Sign in</SubmitButton>
    </form>
  );
}
