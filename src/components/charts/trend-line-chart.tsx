"use client";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { label: string; value: number; detail?: string };

/** Single-series line (2px) with a crosshair tooltip. */
export function TrendLineChart({ data, valueLabel, height = 220 }: { data: Point[]; valueLabel: string; height?: number }) {
  return (
    <div style={{ height }} role="img" aria-label={`${valueLabel} chart. A table view is available below.`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} minTickGap={8} />
          <YAxis tickLine={false} axisLine={false} width={36} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} allowDecimals={false} />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Point;
              return (
                <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
                  <p className="font-medium text-foreground">{p.label}</p>
                  <p className="tabular text-foreground">{valueLabel}: {p.value.toLocaleString("en-KE")}</p>
                  {p.detail ? <p className="text-muted-foreground">{p.detail}</p> : null}
                </div>
              );
            }}
          />
          <Line type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
