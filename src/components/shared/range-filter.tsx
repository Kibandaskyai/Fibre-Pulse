import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RANGE_PRESETS, type DateRange } from "@/lib/date-range";

/**
 * One row of filters above the charts: date range preset (with custom
 * dates) and area. Plain GET form, so it works without JavaScript and the
 * URL can be shared.
 */
export function RangeFilter({
  path,
  range,
  area,
  areas,
  extra,
}: {
  path: string;
  range: DateRange;
  area?: string;
  areas?: { area: string; kind: string; customers: number }[];
  extra?: Record<string, string>;
}) {
  const kinds = ["county", "town", "estate"] as const;
  return (
    <form className="mb-6 flex flex-wrap items-end gap-2" role="search" aria-label="Filters">
      {extra ? Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <label className="grid gap-1 text-xs text-muted-foreground">
        Period
        <NativeSelect name="range" defaultValue={range.key} className="w-40">
          {RANGE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </NativeSelect>
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        From
        <Input type="date" name="from" defaultValue={range.from} className="w-38" />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        To
        <Input type="date" name="to" defaultValue={range.to} className="w-38" />
      </label>
      {areas ? (
        <label className="grid gap-1 text-xs text-muted-foreground">
          Area
          <NativeSelect name="area" defaultValue={area ?? ""} className="w-48">
            <option value="">All areas</option>
            {kinds.map((k) => {
              const list = areas.filter((a) => a.kind === k);
              return list.length ? (
                <optgroup key={k} label={k === "county" ? "Counties" : k === "town" ? "Towns" : "Estates"}>
                  {list.map((a) => <option key={`${k}-${a.area}`} value={a.area}>{a.area} ({a.customers})</option>)}
                </optgroup>
              ) : null;
            })}
          </NativeSelect>
        </label>
      ) : null}
      <Button type="submit" variant="secondary">Apply</Button>
      {range.key !== "30d" || area ? <Button asChild variant="ghost"><Link href={path}>Reset</Link></Button> : null}
      <p className="basis-full text-xs text-muted-foreground">
        Picking dates switches to custom dates automatically. All dates are Kenyan time.
      </p>
    </form>
  );
}
