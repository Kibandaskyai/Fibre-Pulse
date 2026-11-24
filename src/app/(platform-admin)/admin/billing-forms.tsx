"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import {
  calculateAllFeesAction,
  calculateFeesAction,
  discardAgreementAction,
  endAgreementAction,
  issueInvoiceAction,
  recordPlatformPaymentAction,
  requestSupportAccessAction,
  saveAgreementAction,
  signAgreementAction,
  voidPlatformInvoiceAction,
} from "@/modules/platform/billing-actions";

const EXCLUDABLE = [
  ["installation", "Installation fees"],
  ["equipment", "Equipment and router sales"],
  ["other", "Other charges"],
] as const;

export function AgreementForm({
  tenantId,
  draft,
  defaultMonth,
}: {
  tenantId: string;
  draft?: { id: string; fee_rate: number; fee_basis: string; excluded_categories: string[]; effective_from: string; notes: string | null };
  defaultMonth: string;
}) {
  const { state, pending, formProps } = useFormAction(saveAgreementAction, { resetOnSuccess: false });
  const excluded = draft?.excluded_categories ?? ["installation", "equipment", "other"];
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="agreementId" value={draft?.id ?? ""} />
      <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
        <Field id="ag-rate" label="Fee (%)" hint="Pilot default 2.75">
          <Input id="ag-rate" name="feePercent" type="number" step="0.01" min="0.01" max="20" defaultValue={draft ? (draft.fee_rate * 100).toFixed(2) : "2.75"} />
        </Field>
        <input type="hidden" name="feeBasis" value="gross" />
        <Field id="ag-from" label="Starts (month)" hint="Fees are charged per calendar month">
          <Input id="ag-from" name="effectiveMonth" type="month" defaultValue={draft ? draft.effective_from.slice(0, 7) : defaultMonth} />
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Not charged (left out of the fee base)</legend>
        <p className="text-xs text-muted-foreground">Internet subscription collections are always charged. Reversed, refunded, unverified and simulated payments never are.</p>
        <div className="flex flex-wrap gap-4">
          {EXCLUDABLE.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="excluded" value={value} defaultChecked={excluded.includes(value)} className="size-4 accent-primary" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <Field id="ag-notes" label="Notes (optional)">
        <Textarea id="ag-notes" name="notes" rows={2} maxLength={1000} defaultValue={draft?.notes ?? ""} />
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">{draft ? "Save draft" : "Create draft"}</SubmitButton></div>
    </form>
  );
}

export function SignAgreementForm({ tenantId, agreementId }: { tenantId: string; agreementId: string }) {
  const sign = useFormAction(signAgreementAction);
  const discard = useFormAction(discardAgreementAction);
  return (
    <div className="grid gap-3">
      <form {...sign.formProps} className="flex flex-wrap items-end gap-2" noValidate>
        <input type="hidden" name="tenantId" value={tenantId} />
        <input type="hidden" name="agreementId" value={agreementId} />
        <Field id="sign-by" label="Signed for the ISP by">
          <Input id="sign-by" name="signedBy" placeholder="Name and title" className="w-64" />
        </Field>
        <SubmitButton pending={sign.pending} pendingText="Signing…">Mark as signed</SubmitButton>
      </form>
      <FormMessage state={sign.state} />
      <form {...discard.formProps}>
        <input type="hidden" name="tenantId" value={tenantId} />
        <input type="hidden" name="agreementId" value={agreementId} />
        <SubmitButton pending={discard.pending} variant="ghost" size="sm">Discard draft</SubmitButton>
        <FormMessage state={discard.state} />
      </form>
    </div>
  );
}

export function EndAgreementForm({ tenantId, agreementId, defaultMonth }: { tenantId: string; agreementId: string; defaultMonth: string }) {
  const [open, setOpen] = useState(false);
  const { state, pending, formProps } = useFormAction(endAgreementAction);
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>End agreement</Button>;
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="tenantId" value={tenantId} />
      <input type="hidden" name="agreementId" value={agreementId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field id="end-month" label="No fees from (month)">
          <Input id="end-month" name="endMonth" type="month" defaultValue={defaultMonth} className="w-44" />
        </Field>
        <Field id="end-reason" label="Reason (audited)">
          <Input id="end-reason" name="reason" className="w-64" />
        </Field>
        <SubmitButton pending={pending} variant="destructive">End agreement</SubmitButton>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function CalculateFeesForm({ tenantId, defaultMonth, maxMonth }: { tenantId: string; defaultMonth: string; maxMonth: string }) {
  const { state, pending, formProps } = useFormAction(calculateFeesAction, { resetOnSuccess: false });
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="tenantId" value={tenantId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field id="calc-month" label="Month">
          <Input id="calc-month" name="month" type="month" defaultValue={defaultMonth} max={maxMonth} className="w-44" />
        </Field>
        <SubmitButton pending={pending} pendingText="Calculating…">Calculate fees</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function CalculateAllForm({ defaultMonth, maxMonth }: { defaultMonth: string; maxMonth: string }) {
  const { state, pending, formProps } = useFormAction(calculateAllFeesAction, { resetOnSuccess: false });
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <div className="flex flex-wrap items-end gap-2">
        <Field id="run-month" label="Month">
          <Input id="run-month" name="month" type="month" defaultValue={defaultMonth} max={maxMonth} className="w-44" />
        </Field>
        <SubmitButton pending={pending} pendingText="Calculating…">Calculate for every ISP</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function IssueInvoiceForm({ tenantId }: { tenantId: string }) {
  const { state, pending, formProps } = useFormAction(issueInvoiceAction);
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="tenantId" value={tenantId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field id="inv-due" label="Pay within (days)">
          <Input id="inv-due" name="dueDays" type="number" min={1} max={90} defaultValue={14} className="w-28" />
        </Field>
        <Field id="inv-notes" label="Note on invoice (optional)">
          <Input id="inv-notes" name="notes" className="w-64" maxLength={1000} />
        </Field>
        <SubmitButton pending={pending} pendingText="Issuing…">Issue invoice</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function RecordPaymentForm({ invoiceId, tenantId, today }: { invoiceId: string; tenantId: string; today: string }) {
  const { state, pending, formProps } = useFormAction(recordPlatformPaymentAction);
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="tenantId" value={tenantId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field id="pay-ref" label="M-Pesa or bank reference">
          <Input id="pay-ref" name="reference" className="w-48" />
        </Field>
        <Field id="pay-date" label="Paid on">
          <Input id="pay-date" name="paidOn" type="date" defaultValue={today} max={today} className="w-44" />
        </Field>
        <SubmitButton pending={pending}>Record payment</SubmitButton>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function VoidInvoiceForm({ invoiceId, tenantId }: { invoiceId: string; tenantId: string }) {
  const [open, setOpen] = useState(false);
  const { state, pending, formProps } = useFormAction(voidPlatformInvoiceAction);
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Void invoice</Button>;
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="tenantId" value={tenantId} />
      <div className="flex flex-wrap items-end gap-2">
        <Field id="void-reason" label="Reason (audited)">
          <Input id="void-reason" name="reason" className="w-72" />
        </Field>
        <SubmitButton pending={pending} variant="destructive">Void</SubmitButton>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

export function RequestAccessForm({ tenants, tenantId }: { tenants: { id: string; name: string }[]; tenantId?: string }) {
  const { state, pending, formProps } = useFormAction(requestSupportAccessAction);
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      {tenantId ? (
        <input type="hidden" name="tenantId" value={tenantId} />
      ) : (
        <Field id="sa-tenant" label="ISP">
          <NativeSelect id="sa-tenant" name="tenantId" defaultValue="">
            <option value="" disabled>Choose an ISP</option>
            {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </NativeSelect>
        </Field>
      )}
      <Field id="sa-reason" label="What do you need to look at, and why?" hint="The ISP owner sees this and decides. Access is read-only and lasts at most 72 hours.">
        <Textarea id="sa-reason" name="reason" rows={3} maxLength={500} />
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Sending…">Request access</SubmitButton></div>
    </form>
  );
}
