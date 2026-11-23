import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** One headline number. Tone is only used for status meaning (warning / danger). */
export function KpiCard({
  label,
  value,
  hint,
  tone,
  badge,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warning" | "danger" | "success";
  badge?: ReactNode;
  href?: string;
}) {
  const card = (
    <Card className={cn("h-full", href && "transition-colors group-hover:border-primary/50")}>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardDescription>{label}</CardDescription>
        {badge}
      </CardHeader>
      <CardContent>
        <p className={cn("tabular text-2xl font-semibold", tone === "warning" && "text-warning", tone === "danger" && "text-danger", tone === "success" && "text-success")}>
          {value}
        </p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="group">{card}</Link> : card;
}
