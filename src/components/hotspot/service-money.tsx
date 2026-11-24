import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatKsh } from "@/lib/format";
import type { ServiceRow } from "@/modules/hotspot/service";

const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-KE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const monthLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-KE", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Daily and monthly money, split hotspot / monthly customers. Verified money
 * only; owner-recorded sales waiting for the statement check are shown apart.
 */
export function ServiceMoneyTable({ rows, grain, title, description }: { rows: ServiceRow[]; grain: "day" | "month"; title: string; description: string }) {
  const ordered = [...rows].reverse();
  const total = rows.reduce(
    (t, r) => ({ hotspot: t.hotspot + r.hotspot, monthly: t.monthly + r.monthly, unlinked: t.unlinked + r.unlinked, sales: t.sales + r.hotspot_sales, waiting: t.waiting + r.awaiting_verification }),
    { hotspot: 0, monthly: 0, unlinked: 0, sales: 0, waiting: 0 },
  );
  const showUnlinked = total.unlinked > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0 pb-2">
        <div className="max-h-96 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{grain === "day" ? "Day" : "Month"}</TableHead>
                <TableHead className="text-right">Hotspot</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Codes</TableHead>
                <TableHead className="text-right">Monthly</TableHead>
                {showUnlinked ? <TableHead className="hidden md:table-cell text-right">Not linked</TableHead> : null}
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="hidden lg:table-cell text-right">Not yet checked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="font-semibold">
                <TableCell className="whitespace-nowrap">{grain === "day" ? "Month to date" : "12 months"}</TableCell>
                <TableCell className="tabular text-right">{formatKsh(total.hotspot)}</TableCell>
                <TableCell className="hidden sm:table-cell tabular text-right">{total.sales.toLocaleString("en-KE")}</TableCell>
                <TableCell className="tabular text-right">{formatKsh(total.monthly)}</TableCell>
                {showUnlinked ? <TableCell className="hidden md:table-cell tabular text-right">{formatKsh(total.unlinked)}</TableCell> : null}
                <TableCell className="tabular text-right">{formatKsh(total.hotspot + total.monthly + total.unlinked)}</TableCell>
                <TableCell className="hidden lg:table-cell tabular text-right text-muted-foreground">{formatKsh(total.waiting)}</TableCell>
              </TableRow>
              {ordered.map((r) => (
                <TableRow key={r.bucket}>
                  <TableCell className="whitespace-nowrap">{grain === "day" ? dayLabel(r.bucket) : monthLabel(r.bucket)}</TableCell>
                  <TableCell className="tabular text-right">{formatKsh(r.hotspot)}</TableCell>
                  <TableCell className="hidden sm:table-cell tabular text-right">{r.hotspot_sales.toLocaleString("en-KE")}</TableCell>
                  <TableCell className="tabular text-right">{formatKsh(r.monthly)}</TableCell>
                  {showUnlinked ? <TableCell className="hidden md:table-cell tabular text-right">{formatKsh(r.unlinked)}</TableCell> : null}
                  <TableCell className="tabular text-right">{formatKsh(r.hotspot + r.monthly + r.unlinked)}</TableCell>
                  <TableCell className="hidden lg:table-cell tabular text-right text-muted-foreground">{r.awaiting_verification ? formatKsh(r.awaiting_verification) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
