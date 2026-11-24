"use client";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormMessage, SubmitButton, useFormAction } from "@/components/shared/form-bits";
import { JOB_STATUSES, JOB_TYPES } from "@/lib/validation/operations";
import { createJobAction, planJobAction, updateJobStatusAction } from "@/modules/field/actions";
import type { Technician } from "@/modules/field/service";

const techLabel = (t: Technician) => `${t.full_name}${t.zone ? ` · ${t.zone}` : ""} · ${t.open_jobs} open`;

export function NewJobForm({
  customers, technicians, defaults,
}: {
  customers: { id: string; full_name: string; customer_number: string }[];
  technicians: Technician[];
  defaults: { customerId?: string; ticketId?: string; jobType?: string; ticketLabel?: string };
}) {
  const { state, pending, formProps } = useFormAction(createJobAction, { resetOnSuccess: false });
  const e = state && !state.ok ? state.fieldErrors : undefined;
  return (
    <form {...formProps} className="grid gap-4" noValidate>
      {defaults.ticketId ? <input type="hidden" name="ticketId" value={defaults.ticketId} /> : null}
      {defaults.ticketLabel ? <p className="text-sm text-muted-foreground">For ticket {defaults.ticketLabel}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="j-type" label="Kind of job" errors={e?.jobType}>
          <NativeSelect id="j-type" name="jobType" defaultValue={defaults.jobType ?? ""}>
            <option value="" disabled>Choose…</option>
            {JOB_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </Field>
        <Field id="j-customer" label="Customer" errors={e?.customerId} hint="Empty for work on the network itself.">
          <NativeSelect id="j-customer" name="customerId" defaultValue={defaults.customerId ?? ""}>
            <option value="">No customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.full_name} · {c.customer_number}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="j-tech" label="Technician" errors={e?.technicianId} hint={technicians.length ? undefined : "No technicians yet. Invite staff with the Field Technician role."}>
          <NativeSelect id="j-tech" name="technicianId" defaultValue="">
            <option value="">Not assigned yet</option>
            {technicians.map((t) => <option key={t.technician_id} value={t.technician_id}>{techLabel(t)}</option>)}
          </NativeSelect>
        </Field>
        <Field id="j-when" label="Visit time (optional)" errors={e?.scheduledFor} hint="Kenyan time.">
          <Input id="j-when" name="scheduledFor" type="datetime-local" />
        </Field>
      </div>
      <Field id="j-address" label="Where (optional)" errors={e?.address} hint="Directions for the technician, e.g. house number and a landmark.">
        <Input id="j-address" name="address" maxLength={300} />
      </Field>
      <Field id="j-notes" label="Instructions (optional)" errors={e?.notes}>
        <Textarea id="j-notes" name="notes" rows={3} maxLength={2000} />
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Creating…">Create job</SubmitButton></div>
    </form>
  );
}

export function JobStatusForm({ job, isSupervisor }: { job: { id: string; status: string; completion_notes: string | null }; isSupervisor: boolean }) {
  const { state, pending, formProps } = useFormAction(updateJobStatusAction, { resetOnSuccess: false });
  const closed = job.status === "completed" || job.status === "cancelled";
  const choices = JOB_STATUSES.filter(([v]) => isSupervisor || v !== "cancelled");
  if (closed && !isSupervisor) return <p className="text-sm text-muted-foreground">This job is closed. Ask your supervisor if it needs to be reopened.</p>;
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="jobId" value={job.id} />
      <Field id="js-status" label="Status">
        <NativeSelect id="js-status" name="status" defaultValue={job.status}>
          {choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </NativeSelect>
      </Field>
      <Field id="js-notes" label="Work done" hint="Needed to complete: what you did, equipment used, test results.">
        <Textarea id="js-notes" name="completionNotes" rows={3} maxLength={2000} defaultValue={job.completion_notes ?? ""} />
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} pendingText="Saving…">Update job</SubmitButton></div>
    </form>
  );
}

export function JobPlanForm({ job, technicians, scheduledLocal }: { job: { id: string; technician_id: string | null }; technicians: Technician[]; scheduledLocal: string }) {
  const { state, pending, formProps } = useFormAction(planJobAction, { resetOnSuccess: false });
  return (
    <form {...formProps} className="grid gap-3" noValidate>
      <input type="hidden" name="jobId" value={job.id} />
      <Field id="jp-tech" label="Technician">
        <NativeSelect id="jp-tech" name="technicianId" defaultValue={job.technician_id ?? ""}>
          <option value="">Not assigned</option>
          {technicians.map((t) => <option key={t.technician_id} value={t.technician_id}>{techLabel(t)}</option>)}
        </NativeSelect>
      </Field>
      <Field id="jp-when" label="Visit time" hint="Kenyan time.">
        <Input id="jp-when" name="scheduledFor" type="datetime-local" defaultValue={scheduledLocal} />
      </Field>
      <FormMessage state={state} />
      <div><SubmitButton pending={pending} variant="outline" pendingText="Saving…">Save plan</SubmitButton></div>
    </form>
  );
}
