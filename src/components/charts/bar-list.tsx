import { formatKsh } from "@/lib/format";

/**
 * Horizontal bars in plain HTML: each row names its label and value in text,
 * so identity and magnitude never depend on colour alone.
 */
export function BarList({
  rows,
  format = "ksh",
  emptyText = "No data for this period.",
  total,
}: {
  rows: { label: string; value: number; detail?: string }[];
  format?: "ksh" | "count";
  emptyText?: string;
  total?: number;
}) {
  if (!rows.length || rows.every((r) => r.value === 0)) return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const sum = total ?? rows.reduce((s, r) => s + r.value, 0);
  return (
    <ul className="grid gap-3">
      {rows.map((r) => (
        <li key={r.label} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">{r.label}</span>
            <span className="tabular shrink-0 text-foreground">
              {format === "ksh" ? formatKsh(r.value) : r.value.toLocaleString("en-KE")}
              {sum > 0 ? <span className="ml-2 text-xs text-muted-foreground">{Math.round((r.value / sum) * 100)}%</span> : null}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted" aria-hidden>
            <div className="h-2 rounded-full bg-chart-1" style={{ width: `${Math.max((r.value / max) * 100, r.value > 0 ? 1.5 : 0)}%` }} />
          </div>
          {r.detail ? <p className="text-xs text-muted-foreground">{r.detail}</p> : null}
        </li>
      ))}
    </ul>
  );
}
