import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatKsh, plural } from "@/lib/format";
import { ratePct, type FeeRecord, type PlatformInvoice } from "@/modules/platform/billing";

const monthName = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-KE", { month: "long", year: "numeric", timeZone: "UTC" });

/** The invoice as both FibrePulse and the ISP see it. */
export function InvoiceDocument({ invoice: inv, lines }: { invoice: PlatformInvoice; lines: FeeRecord[] }) {
  return (
    <Card>
      <CardContent className="grid gap-5 pt-6">
        <div className="flex flex-wrap justify-between gap-4 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">From</p>
            <p className="font-medium">FibrePulse</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Billed to</p>
            <p className="font-medium">{inv.tenant_name}</p>
          </div>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Eligible collections</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    {l.adjustment_of ? `Adjustment for ${monthName(l.period_start)}` : `Platform fee, ${monthName(l.period_start)}`}
                    <p className="text-xs text-muted-foreground">{l.adjustment_of ? l.reason : plural(l.payment_count, "verified payment")}</p>
                  </TableCell>
                  <TableCell className="tabular text-right">{formatKsh(l.eligible_amount)}</TableCell>
                  <TableCell className="tabular text-right">{ratePct(l.fee_rate)}</TableCell>
                  <TableCell className="tabular text-right">{formatKsh(l.fee_amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <dl className="ml-auto grid w-full max-w-xs gap-1 text-sm">
          <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd className="tabular">{formatKsh(inv.subtotal)}</dd></div>
          {/* No VAT or KRA: the pilot ISP is not VAT registered. Older invoices that carried tax still show it. */}
          {inv.tax_amount > 0 ? (
            <div className="flex justify-between"><dt className="text-muted-foreground">Tax ({ratePct(inv.tax_rate)})</dt><dd className="tabular">{formatKsh(inv.tax_amount)}</dd></div>
          ) : null}
          <div className="flex justify-between border-t pt-1 font-semibold"><dt>Total</dt><dd className="tabular" data-testid="invoice-total">{formatKsh(inv.total)}</dd></div>
        </dl>
        <div className="grid gap-1 text-xs text-muted-foreground">
          {inv.notes ? <p>{inv.notes}</p> : null}
          {inv.status === "paid" ? <p>Paid on {formatDate(inv.paid_at)}, reference {inv.payment_reference}.</p> : null}
          {inv.status === "void" ? <p>Void: {inv.void_reason}</p> : null}
          <p>Fees are a percentage of verified internet subscription collections. Reversed, refunded, unverified and simulated payments are never charged.</p>
          {/* TODO: SOFTWARE ENGINEER - add FibrePulse's legal name and payment details once registered, and a PDF download. */}
        </div>
      </CardContent>
    </Card>
  );
}
