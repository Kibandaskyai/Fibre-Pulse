import { z } from "zod";
import { kenyaLocalToIso } from "@/lib/format";

const optionalText = (max: number) =>
  z.string().trim().max(max, `Keep this under ${max} characters.`).transform((v) => (v === "" ? null : v)).prefault("");
const optionalUuid = (message: string) =>
  z
    .string()
    .prefault("")
    .refine((v) => v === "" || z.uuid().safeParse(v).success, message)
    .transform((v) => (v === "" ? null : v));

export const TICKET_CATEGORIES = [
  ["no_internet", "No internet"],
  ["slow_internet", "Slow internet"],
  ["payment_issue", "Payment issue"],
  ["installation_request", "Installation request"],
  ["subscription_issue", "Subscription issue"],
  ["equipment_fault", "Equipment fault"],
  ["general_enquiry", "General enquiry"],
] as const;
export const TICKET_PRIORITIES = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["urgent", "Urgent"],
] as const;
export const TICKET_STATUSES = [
  ["open", "Open"],
  ["assigned", "Assigned"],
  ["in_progress", "In progress"],
  ["resolved", "Resolved"],
  ["closed", "Closed"],
] as const;
export const JOB_TYPES = [
  ["installation", "New installation"],
  ["maintenance", "Maintenance visit"],
  ["equipment_replacement", "Equipment replacement"],
  ["disconnection", "Disconnection"],
  ["fault_investigation", "Fault investigation"],
] as const;
export const JOB_STATUSES = [
  ["scheduled", "Scheduled"],
  ["in_progress", "In progress"],
  ["on_hold", "On hold"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
] as const;

const values = <T extends readonly (readonly [string, string])[]>(list: T) => list.map(([v]) => v) as unknown as [T[number][0], ...T[number][0][]];
export const labelOf = (list: readonly (readonly [string, string])[], v: string) => list.find(([k]) => k === v)?.[1] ?? v;

export const ticketSchema = z.object({
  customerId: optionalUuid("Choose a customer."),
  category: z.enum(values(TICKET_CATEGORIES), { message: "Choose a category." }),
  priority: z.enum(values(TICKET_PRIORITIES)).prefault("medium"),
  subject: z.string().trim().min(3, "Give the ticket a short subject.").max(160),
  description: optionalText(4000),
  assignedTo: optionalUuid("Choose a staff member."),
});
export type TicketInput = z.infer<typeof ticketSchema>;

export const ticketUpdateSchema = z.object({
  ticketId: z.uuid(),
  status: z.enum(values(TICKET_STATUSES)),
  priority: z.enum(values(TICKET_PRIORITIES)),
  assignedTo: optionalUuid("Choose a staff member."),
  resolutionNotes: optionalText(2000),
});

export const noteSchema = z.object({
  id: z.uuid(),
  note: z.string().trim().min(1, "Write a note.").max(2000, "Keep notes under 2,000 characters."),
});

const localDateTime = z
  .string()
  .trim()
  .prefault("")
  .transform((v, ctx) => {
    if (v === "") return null;
    const iso = kenyaLocalToIso(v);
    if (!iso) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date and time." });
      return z.NEVER;
    }
    return iso;
  });

export const jobSchema = z.object({
  customerId: optionalUuid("Choose a customer."),
  ticketId: optionalUuid("Ticket not found."),
  technicianId: optionalUuid("Choose a technician."),
  jobType: z.enum(values(JOB_TYPES), { message: "Choose the kind of job." }),
  scheduledFor: localDateTime,
  address: optionalText(300),
  notes: optionalText(2000),
});
export type JobInput = z.infer<typeof jobSchema>;

export const jobUpdateSchema = z.object({
  jobId: z.uuid(),
  status: z.enum(values(JOB_STATUSES)),
  completionNotes: optionalText(2000),
});

export const jobPlanSchema = z.object({
  jobId: z.uuid(),
  technicianId: optionalUuid("Choose a technician."),
  scheduledFor: localDateTime,
});

export const ticketFiltersSchema = z.object({
  q: z.string().trim().max(80).prefault(""),
  status: z.enum(["active", "all", ...values(TICKET_STATUSES)]).catch("active"),
  category: z.enum(["", ...values(TICKET_CATEGORIES)]).catch(""),
  priority: z.enum(["", ...values(TICKET_PRIORITIES)]).catch(""),
  mine: z.enum(["", "1"]).catch(""),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});
export type TicketFilters = z.infer<typeof ticketFiltersSchema>;

export const jobFiltersSchema = z.object({
  status: z.enum(["active", "all", ...values(JOB_STATUSES)]).catch("active"),
  type: z.enum(["", ...values(JOB_TYPES)]).catch(""),
  technician: z.string().catch("").transform((v) => (z.uuid().safeParse(v).success ? v : "")),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
});
export type JobFilters = z.infer<typeof jobFiltersSchema>;

export const NOTIFICATION_TYPES = [
  ["subscription_expiry", "Package about to end"],
  ["payment_confirmation", "Payment confirmed"],
  ["payment_failure", "Payment failed, rejected or reversed"],
  ["router_offline", "Router offline"],
  ["network_outage", "Network outage"],
  ["customer_complaint", "Tickets and jobs (new, assigned to you)"],
  ["installation_completion", "Job completed"],
  ["critical_network_warning", "Network warnings"],
] as const;
