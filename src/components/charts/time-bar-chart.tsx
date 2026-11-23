"use client";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { label: string; value: number; detail?: string };

/** Single-series column chart over time (one hue, thin bars, rounded data ends). */
export function TimeBarChart({
  data,
  valueLabel,
  format = "ksh",
  height = 240,
}: {
  data: Point[];
  valueLabel: string;
  format?: "ksh" | "count";
  height?: number;
}) {
  const fmt = (v: number) => (format === "ksh" ? `KSh ${v.toLocaleString("en-KE", { maximumFractionDigits: 0 })}` : v.toLocaleString("en-KE"));
  const short = (v: number) => (format === "ksh" ? (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)) : String(v));
  return (
    <div style={{ height }} role="img" aria-label={`${valueLabel} chart. A table view is available below.`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap={data.length > 40 ? 1 : "20%"}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={{ stroke: "var(--chart-grid)" }}
            tick={{ fill: "var(--chart-axis)", fontSize: 11 }}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis tickLine={false} axisLine={false} width={44} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} tickFormatter={short} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "rgba(148,163,184,0.08)" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Point;
              return (
                <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
                  <p className="font-medium text-foreground">{p.label}</p>
                  <p className="tabular text-foreground">{valueLabel}: {fmt(p.value)}</p>
                  {p.detail ? <p className="text-muted-foreground">{p.detail}</p> : null}
                </div>
              );
            }}
          />
          <Bar dataKey="value" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
