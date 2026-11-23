import { Activity } from "lucide-react";

export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-accent text-white shadow-sm">
        <Activity className="size-4.5" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight">FibrePulse</span>
        {subtitle ? <span className="block max-w-40 truncate text-[11px] text-muted-foreground">{subtitle}</span> : null}
      </span>
    </div>
  );
}
