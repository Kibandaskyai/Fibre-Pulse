import type { Metadata } from "next";
import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NetworkMap } from "@/components/map/network-map";
import { RouterStatusBadge } from "@/components/network/network-badges";
import { DataSourceBadge } from "@/components/shared/data-source-badge";
import { PageHeader } from "@/components/shared/page-header";
import { requirePagePermission } from "@/lib/auth/guards";
import { plural } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { myTechnicianId } from "@/modules/field/service";
import { loadMap } from "@/modules/map/service";

export const metadata: Metadata = { title: "Network Map" };

export default async function NetworkMapPage({ searchParams }: { searchParams: Promise<{ area?: string; status?: string }> }) {
  const ctx = await requirePagePermission("network:view");
  const sp = await searchParams;
  const perms = ctx.active.permissions;
  const db = await createClient();
  const exact = perms.has("customers:view_location");
  const technicianId = !perms.has("jobs:view") && perms.has("jobs:update_own") ? await myTechnicianId(db, ctx.active.tenantId, ctx.userId) : null;
  const status = ["online", "offline", "unknown"].includes(sp.status ?? "") ? sp.status! : "";
  const area = (sp.area ?? "").trim().slice(0, 80);
  const m = await loadMap(db, ctx.active.tenantId, {
    exact,
    jobsScope: exact && perms.has("jobs:view") ? "all" : technicianId ? "mine" : "none",
    technicianId,
    area,
    status,
  });
  const simulated = m.routers.some((r) => r.simulated);

  return (
    <>
      <PageHeader
        title="Network map"
        description="Routers and their coverage, outages, open jobs and, for roles allowed to see them, customer locations."
        actions={simulated ? <DataSourceBadge source="simulated" /> : null}
      />
      <form className="mb-4 grid gap-2 sm:grid-cols-[14rem_12rem_auto] sm:justify-start" role="search">
        <NativeSelect name="area" defaultValue={area} aria-label="Area">
          <option value="">All areas</option>
          {m.areaOptions.map((a) => <option key={a} value={a}>{a}</option>)}
        </NativeSelect>
        <NativeSelect name="status" defaultValue={status} aria-label="Network status">
          <option value="">Any status</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="unknown">Not reporting</option>
        </NativeSelect>
        <Button type="submit" variant="outline">Filter</Button>
      </form>

      {m.outages.length ? (
        <Card className="mb-4 border-danger/40">
          <CardContent className="py-3 text-sm">
            <span className="font-medium text-danger">Outage:</span> {m.outages.map((r) => r.name).join(", ")} {m.outages.length === 1 ? "is" : "are"} offline.
          </CardContent>
        </Card>
      ) : null}

      <Card className="mb-6">
        <CardContent className="pt-5">
          <NetworkMap routers={m.routers} customers={m.customers} jobs={m.jobs} />
          {!exact ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5" aria-hidden /> Exact customer locations are hidden for your role. {technicianId ? "Your own open jobs are shown." : "Areas are summarised below instead."}
            </p>
          ) : null}
          {m.unplaced.length ? <p className="mt-2 text-xs text-muted-foreground">{plural(m.unplaced.length, "router")} without coordinates: {m.unplaced.map((r) => r.name).join(", ")}. Add latitude and longitude on the router page.</p> : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Routers</CardTitle><CardDescription>{plural(m.routers.length, "router")} on the map</CardDescription></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Router</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Sessions</TableHead><TableHead className="hidden sm:table-cell">Coverage</TableHead></TableRow></TableHeader>
              <TableBody>
                {m.routers.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><Link className="font-medium hover:underline" href={`/network/routers/${r.id}`}>{r.name}</Link><p className="text-xs text-muted-foreground">{r.location ?? ""}</p></TableCell>
                    <TableCell><RouterStatusBadge status={r.status} /></TableCell>
                    <TableCell className="tabular text-right">{r.sessions}</TableCell>
                    <TableCell className="hidden text-sm sm:table-cell">{r.coverage_m ? `${(r.coverage_m / 1000).toFixed(1)} km` : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>By area</CardTitle><CardDescription>Customers per estate or town{area ? ` in ${area}` : ""}</CardDescription></CardHeader>
          <CardContent className="p-0">
            <div className="max-h-96 overflow-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Area</TableHead><TableHead className="text-right">Customers</TableHead><TableHead className="text-right">Online</TableHead><TableHead className="text-right">Open tickets</TableHead></TableRow></TableHeader>
                <TableBody>
                  {m.areas.map((a) => (
                    <TableRow key={a.area}>
                      <TableCell className="text-sm">{a.area}</TableCell>
                      <TableCell className="tabular text-right">{a.customers}</TableCell>
                      <TableCell className="tabular text-right">{a.online}</TableCell>
                      <TableCell className={`tabular text-right ${a.open_tickets ? "text-warning" : ""}`}>{a.open_tickets}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
