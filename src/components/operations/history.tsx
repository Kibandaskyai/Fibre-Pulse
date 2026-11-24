import { describeEvent } from "@/components/operations/ops-badges";
import { formatDateTime } from "@/lib/format";

type Event = { id: string; event_type: string; from_value: string | null; to_value: string | null; note: string | null; actor_id: string | null; created_at: string };

/** Ticket or job history, oldest first. Notes are shown in full. */
export function History({ events, names, kind }: { events: Event[]; names: Map<string, string>; kind: "ticket" | "job" }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">No history yet.</p>;
  return (
    <ol className="grid gap-4" aria-label="History">
      {events.map((e) => (
        <li key={e.id} className="relative border-l pl-4">
          <span className="absolute -left-[5px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary" aria-hidden />
          <p className="text-sm">
            <span className="font-medium">{e.actor_id ? (names.get(e.actor_id) ?? "Staff member") : "FibrePulse"}</span>{" "}
            <span className="text-muted-foreground">· {formatDateTime(e.created_at)}</span>
          </p>
          <p className="text-sm text-muted-foreground">{describeEvent(e, names, kind)}</p>
          {e.note && e.event_type !== "job" ? <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 text-sm">{e.note}</p> : null}
        </li>
      ))}
    </ol>
  );
}
