"use client";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { Label } from "@/components/ui/label";
import { recordPaymentAction } from "@/modules/billing/actions";

const METHOD_LABELS = { mpesa: "M-Pesa", bank_transfer: "Bank transfer", other: "Other" } as const;

export function RecordPaymentForm({ customerId, defaultTime, methods }: { customerId: string | null; defaultTime: string; methods: (keyof typeof METHOD_LABELS)[] }) {
  const only = methods.length === 1 ? methods[0] : null;
  const { state, pending, formProps } = useFormAction(recordPaymentAction);
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      <input type="hidden" name="customerId" value={customerId ?? ""} />
      {customerId ? <input type="hidden" name="returnTo" value={`/customers/${customerId}`} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="pay-method">Method</Label>
          {only ? (
            <>
              <input type="hidden" name="method" value={only} />
              <Input id="pay-method" value={METHOD_LABELS[only]} readOnly disabled />
            </>
          ) : (
            <NativeSelect id="pay-method" name="method" defaultValue={methods[0]}>
              {methods.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
            </NativeSelect>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pay-ref">{only === "mpesa" ? "M-Pesa receipt" : "M-Pesa receipt or bank reference"}</Label>
          <Input id="pay-ref" name="reference" autoComplete="off" className="uppercase" placeholder="SKL4H7XY2Q" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="pay-amount">Amount (Ksh)</Label>
          <Input id="pay-amount" name="amount" inputMode="decimal" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pay-time">Date and time paid (Kenya time)</Label>
          <Input id="pay-time" name="transactionAt" type="datetime-local" defaultValue={defaultTime} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="pay-phone">Payer phone (optional)</Label>
          <Input id="pay-phone" name="payerPhone" type="tel" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pay-name">Payer name (optional)</Label>
          <Input id="pay-name" name="payerName" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pay-desc">Note (optional)</Label>
        <Input id="pay-desc" name="description" />
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Recording…">Record payment</SubmitButton></div>
    </form>
  );
}
