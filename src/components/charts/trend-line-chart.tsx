"use client";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatBps } from "@/lib/format";

type Point = { label: string; value: number; detail?: string };
type Unit = "count" | "bps" | "pct";

const full = (v: number, unit: Unit) => (unit === "bps" ? formatBps(v) : unit === "pct" ? `${v}%` : v.toLocaleString("en-KE"));
const tick = (v: number, unit: Unit) => (unit === "bps" ? formatBps(v).replace(/\.0 /, " ").replace(/ ?([kMG]?)bps$/, "$1") : unit === "pct" ? `${v}%` : String(v));

/** Single-series line (2px) with a crosshair tooltip. */
export function TrendLineChart({ data, valueLabel, height = 220, unit = "count", domainMax }: { data: Point[]; valueLabel: string; height?: number; unit?: Unit; domainMax?: number }) {
  return (
    <div style={{ height }} role="img" aria-label={`${valueLabel} chart. A table view is available below.`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--chart-grid)" }} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} minTickGap={8} />
          <YAxis tickLine={false} axisLine={false} width={unit === "bps" ? 44 : 36} tick={{ fill: "var(--chart-axis)", fontSize: 11 }} allowDecimals={false} tickFormatter={(v: number) => tick(v, unit)} domain={domainMax ? [0, domainMax] : undefined} />
          <Tooltip
            cursor={{ stroke: "var(--chart-axis)", strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Point;
              return (
                <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
                  <p className="font-medium text-foreground">{p.label}</p>
                  <p className="tabular text-foreground">{valueLabel}: {full(p.value, unit)}</p>
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
