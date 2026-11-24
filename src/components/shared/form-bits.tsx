"use client";
import { startTransition, useActionState, useEffect, useRef, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ActionResult } from "@/lib/validation/common";

export function SubmitButton({ children, pendingText, pending: pendingProp, ...props }: ButtonProps & { pendingText?: string; pending?: boolean }) {
  const status = useFormStatus();
  const pending = pendingProp ?? status.pending;
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {pending ? (pendingText ?? "Working…") : children}
    </Button>
  );
}

export function Field({ id, label, hint, errors, children }: { id: string; label: string; hint?: string; errors?: string[]; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !errors?.length ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {errors?.length ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {errors[0]}
        </p>
      ) : null}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function FormMessage({ state }: { state: ActionResult<any> | null }) {
  if (!state?.message) return null;
  return (
    <Alert variant={state.ok ? "success" : "danger"} aria-live="polite">
      <AlertDescription className="text-foreground">{state.message}</AlertDescription>
    </Alert>
  );
}

/**
 * Bind a form to a server action without React's automatic form reset, so a
 * validation error never wipes what the person typed. The form is cleared
 * only after a successful result (unless resetOnSuccess is false).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useFormAction<T extends ActionResult<any> | null>(
  action: (prev: T | null, formData: FormData) => Promise<T>,
  { resetOnSuccess = true }: { resetOnSuccess?: boolean } = {},
) {
  const [state, dispatch, pending] = useActionState<T | null, FormData>(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Include the clicked button's name/value, so one form can offer several actions.
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const fd = new FormData(e.currentTarget, submitter?.name ? submitter : undefined);
    startTransition(() => dispatch(fd));
  };
  return { state, pending, formProps: { ref, onSubmit } };
}
