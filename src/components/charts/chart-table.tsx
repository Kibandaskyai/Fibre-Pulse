import type { ReactNode } from "react";

/** "View as table" disclosure under a chart, for screen readers and exact values. */
export function ChartTable({ headers, rows, caption }: { headers: string[]; rows: ReactNode[][]; caption: string }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View as table</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border">
        <table className="w-full text-left">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-card">
            <tr>{headers.map((h) => <th key={h} className="px-3 py-1.5 font-medium text-muted-foreground">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                {r.map((c, j) => <td key={j} className="tabular px-3 py-1.5">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
