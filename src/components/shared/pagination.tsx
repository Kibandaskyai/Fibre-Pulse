import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Previous/next links that keep the current filters. */
export function Pagination({ path, params, page, pageSize, total }: { path: string; params: Record<string, string>; page: number; pageSize: number; total: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <p className="px-5 py-3 text-xs text-muted-foreground">{total} {total === 1 ? "record" : "records"}</p>;
  const href = (p: number) => {
    const sp = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ""));
    sp.set("page", String(p));
    return `${path}?${sp.toString()}`;
  };
  return (
    <div className="flex items-center justify-between gap-2 px-5 py-3 text-xs text-muted-foreground">
      <span>Page {page} of {pages} · {total} records</span>
      <div className="flex gap-2">
        {page > 1 ? <Button asChild size="sm" variant="outline"><Link href={href(page - 1)}>Previous</Link></Button> : null}
        {page < pages ? <Button asChild size="sm" variant="outline"><Link href={href(page + 1)}>Next</Link></Button> : null}
      </div>
    </div>
  );
}
