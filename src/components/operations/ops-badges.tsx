import { AlertOctagon, ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { JOB_STATUSES, JOB_TYPES, TICKET_CATEGORIES, TICKET_STATUSES, labelOf } from "@/lib/validation/operations";

type V = "success" | "warning" | "danger" | "secondary" | "default" | "accent";
const TICKET_STATUS_VARIANT: Record<string, V> = { open: "danger", assigned: "warning", in_progress: "default", resolved: "success", closed: "secondary" };
const JOB_STATUS_VARIANT: Record<string, V> = { scheduled: "default", in_progress: "warning", on_hold: "danger", completed: "success", cancelled: "secondary" };

export const TicketStatusBadge = ({ status }: { status: string }) => <Badge variant={TICKET_STATUS_VARIANT[status] ?? "secondary"}>{labelOf(TICKET_STATUSES, status)}</Badge>;
export const JobStatusBadge = ({ status }: { status: string }) => <Badge variant={JOB_STATUS_VARIANT[status] ?? "secondary"}>{labelOf(JOB_STATUSES, status)}</Badge>;
export const categoryLabel = (c: string) => labelOf(TICKET_CATEGORIES, c);
export const jobTypeLabel = (t: string) => labelOf(JOB_TYPES, t);

/** Priority with an icon and word, so it never depends on colour alone. */
export function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "urgent") return <Badge variant="danger"><AlertOctagon className="size-3" aria-hidden /> Urgent</Badge>;
  if (priority === "high") return <Badge variant="warning"><ArrowUp className="size-3" aria-hidden /> High</Badge>;
  if (priority === "low") return <Badge variant="secondary"><ArrowDown className="size-3" aria-hidden /> Low</Badge>;
  return <Badge variant="secondary"><Minus className="size-3" aria-hidden /> Medium</Badge>;
}

/** One line of ticket or job history in plain words. */
export function describeEvent(
  e: { event_type: string; from_value: string | null; to_value: string | null; note: string | null },
  names: Map<string, string>,
  kind: "ticket" | "job",
): string {
  const statusLabel = (s: string | null) => (s ? labelOf(kind === "ticket" ? TICKET_STATUSES : JOB_STATUSES, s) : "");
  switch (e.event_type) {
    case "created":
      return kind === "ticket" ? "Opened the ticket" : "Created the job";
    case "status":
      return `Changed status from ${statusLabel(e.from_value)} to ${statusLabel(e.to_value)}`;
    case "assigned":
      return e.to_value ? `Assigned to ${names.get(e.to_value) ?? "a staff member"}` : "Removed the assignee";
    case "priority":
      return `Changed priority from ${e.from_value} to ${e.to_value}`;
    case "scheduled":
      return e.to_value ? "Changed the visit time" : "Removed the visit time";
    case "job":
      return e.note ?? `Job ${e.to_value}`;
    case "comment":
    case "note":
      return "Added a note";
    default:
      return e.event_type;
  }
}
