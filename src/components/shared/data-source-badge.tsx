import { FlaskConical, PlugZap, ShieldCheck, PencilLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export type DataSource = "simulated" | "manual" | "connector" | "provider";

/**
 * Every figure built from network or payment rows shows where it came from.
 * SIMULATED data is always visibly labelled (spec Part 4 Module 1, Part 15).
 */
export function DataSourceBadge({ source }: { source: DataSource }) {
  switch (source) {
    case "simulated":
      return (
        <Badge variant="simulated" title="Generated test data. Not from real routers or payments.">
          <FlaskConical className="size-3" aria-hidden /> Simulated
        </Badge>
      );
    case "connector":
      return (
        <Badge variant="accent" title="Collected from a registered router by the FibrePulse Connector.">
          <PlugZap className="size-3" aria-hidden /> Live device
        </Badge>
      );
    case "provider":
      return (
        <Badge variant="success" title="Confirmed by the payment provider.">
          <ShieldCheck className="size-3" aria-hidden /> Provider verified
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary" title="Entered by a staff member. See the audit log.">
          <PencilLine className="size-3" aria-hidden /> Manual entry
        </Badge>
      );
  }
}
