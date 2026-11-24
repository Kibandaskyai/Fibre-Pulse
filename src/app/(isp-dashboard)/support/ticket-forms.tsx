"use client";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/validation/operations";
import { addTicketCommentAction, createTicketAction, updateTicketAction } from "@/modules/support/actions";

type Person = { profile_id: string; full_name: string; role: string };
const ROLE: Record<string, string> = { owner: "Owner", finance: "Finance", network_admin: "Network", support_agent: "Support", technician: "Technician" };

export function NewTicketForm({ customers, staff, customerId }: { customers: { id: string; full_name: string; customer_number: string }[]; staff: Person[]; customerId?: string }) {
  const { state, pending, formProps } = useFormAction(createTicketAction, { resetOnSuccess: false });
  const e = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="t-customer" label="Customer" errors={e?.customerId} hint="Leave empty for a general enquiry from a non-customer.">
          <NativeSelect id="t-customer" name="customerId" defaultValue={customerId ?? ""}>
            <option value="">No customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.customer_number}</option>)}
          </NativeSelect>
        </Field>
        <Field id="t-category" label="Issue" errors={e?.category}>
          <NativeSelect id="t-category" name="category" defaultValue="">
            <option value="" disabled>Choose…</option>
            {TICKET_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="t-subject" label="Subject" errors={e?.subject}>
        <Input id="t-subject" name="subject" required maxLength={160} placeholder="No internet since this morning" />
      </Field>
      <Field id="t-desc" label="What the customer said (optional)" errors={e?.description}>
        <Textarea id="t-desc" name="description" rows={4} maxLength={4000} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="t-priority" label="Priority" errors={e?.priority} hint="Urgent: many customers or a business customer down.">
          <NativeSelect id="t-priority" name="priority" defaultValue="medium">
            {TICKET_PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </Field>
        <Field id="t-assign" label="Assign to (optional)" errors={e?.assignedTo}>
          <NativeSelect id="t-assign" name="assignedTo" defaultValue="">
            <option value="">Nobody yet</option>
            {staff.map((p) => <option key={p.profile_id} value={p.profile_id}>{p.full_name} · {ROLE[p.role] ?? p.role}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Creating…">Create ticket</SubmitButton></div>
    </form>
  );
}

export function TicketUpdateForm({
  ticket, staff,
}: { ticket: { id: string; status: string; priority: string; assigned_to: string | null; resolution_notes: string | null }; staff: Person[] }) {
  const { state, pending, formProps } = useFormAction(updateTicketAction, { resetOnSuccess: false });
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="ticketId" value={ticket.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="u-status" label="Status">
          <NativeSelect id="u-status" name="status" defaultValue={ticket.status}>
            {TICKET_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </Field>
        <Field id="u-priority" label="Priority">
          <NativeSelect id="u-priority" name="priority" defaultValue={ticket.priority}>
            {TICKET_PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="u-assign" label="Assigned to">
        <NativeSelect id="u-assign" name="assignedTo" defaultValue={ticket.assigned_to ?? ""}>
          <option value="">Nobody</option>
          {staff.map((p) => <option key={p.profile_id} value={p.profile_id}>{p.full_name} · {ROLE[p.role] ?? p.role}</option>)}
        </NativeSelect>
      </Field>
      <Field id="u-resolution" label="Resolution" hint="Needed to resolve or close. The customer-facing answer.">
        <Textarea id="u-resolution" name="resolutionNotes" rows={3} maxLength={2000} defaultValue={ticket.resolution_notes ?? ""} />
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">Save ticket</SubmitButton></div>
    </form>
  );
}

export function NoteForm({ id, action, label = "Add note" }: { id: string; action: typeof addTicketCommentAction; label?: string }) {
  const { state, pending, formProps } = useFormAction(action);
  return (
    <form {...formProps} className="grid gap-2" noValidate>
      <input type="hidden" name="id" value={id} />
      <Textarea name="note" rows={3} maxLength={2000} aria-label="Note" placeholder="What happened, what you told the customer, what is next" />
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} variant="outline" pendingText="Saving…">{label}</SubmitButton></div>
    </form>
  );
}
