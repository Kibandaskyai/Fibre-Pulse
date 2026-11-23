"use client";
import type { ReactNode } from "react";
import { FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import type { ButtonProps } from "@/components/ui/button";
import type { ActionResult } from "@/lib/validation/common";
import { cn } from "@/lib/utils";

type Action = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/**
 * A small form bound to a server action that returns an ActionResult.
 * Renders its fields, a submit button and the result message. Usable from
 * Server Components, so field errors are folded into the message.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingText,
  variant,
  className,
  hidden,
}: {
  action: Action;
  children?: ReactNode;
  submitLabel: string;
  pendingText?: string;
  variant?: ButtonProps["variant"];
  className?: string;
  hidden?: Record<string, string>;
}) {
  const { state, pending, formProps } = useFormAction(action);
  return (
    <form {...formProps} className={cn("grid gap-3", className)} noValidate>
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      {children}
      <FormMessage state={state} />
      <div>
        <SubmitButton pending={pending} variant={variant} pendingText={pendingText}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
