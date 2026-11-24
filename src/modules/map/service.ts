/**
 * Data for the network map. Exact customer points are returned only to
 * roles with customers:view_location (RLS on customer_locations enforces it
 * too); technicians get the points of their own open jobs. Everyone else
 * sees routers, outages and an area summary without coordinates.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type MapRouter = {
  id: string; name: string; status: string; lat: number; lng: number; coverage_m: number | null; sessions: number;
  location: string | null; simulated: boolean; open_alerts: number;
};
export type MapCustomer = { id: string; name: string; number: string; status: string; online: boolean; lat: number; lng: number; area: string | null };
export type MapJob = { id: string; number: string; type: string; status: string; customer: string | null; lat: number; lng: number; scheduled_for: string | null };
export type AreaSummary = { area: string; customers: number; active: number; online: number; open_tickets: number };

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function loadMap(
  db: SupabaseClient,
  tenantId: string,
  opts: { exact: boolean; jobsScope: "all" | "mine" | "none"; technicianId: string | null; area: string; status: string },
) {
  const areaMatch = (c: { estate: string | null; town: string | null; county: string | null }) =>
    !opts.area || [c.estate, c.town, c.county].some((v) => v?.toLowerCase() === opts.area.toLowerCase());

  const [routers, sessions, alerts, customers, tickets] = await Promise.all([
    db.from("routers").select("id, name, status, latitude, longitude, coverage_radius_m, location_name, data_source").eq("tenant_id", tenantId),
    db.from("network_sessions").select("router_id, customer_id").eq("tenant_id", tenantId).is("ended_at", null),
    db.from("network_alerts").select("router_id").eq("tenant_id", tenantId).neq("status", "resolved"),
    db.from("customers").select("id, full_name, customer_number, status, estate, town, county").eq("tenant_id", tenantId).neq("status", "terminated"),
    db.from("support_tickets").select("customer_id").eq("tenant_id", tenantId).in("status", ["open", "assigned", "in_progress"]),
  ]);

  const sessionCount = new Map<string, number>();
  const onlineCustomers = new Set<string>();
  for (const s of sessions.data ?? []) {
    sessionCount.set(s.router_id, (sessionCount.get(s.router_id) ?? 0) + 1);
    if (s.customer_id) onlineCustomers.add(s.customer_id);
  }
  const alertCount = new Map<string, number>();
  for (const a of alerts.data ?? []) if (a.router_id) alertCount.set(a.router_id, (alertCount.get(a.router_id) ?? 0) + 1);

  const allRouters = (routers.data ?? []).map((r) => ({
    id: r.id as string, name: r.name as string, status: r.status as string, lat: num(r.latitude), lng: num(r.longitude),
    coverage_m: num(r.coverage_radius_m), sessions: sessionCount.get(r.id) ?? 0, location: r.location_name as string | null,
    simulated: r.data_source === "simulated", open_alerts: alertCount.get(r.id) ?? 0,
  }));
  const statusOk = (s: string) => !opts.status || opts.status === s;
  const mapRouters = allRouters.filter((r): r is MapRouter => r.lat !== null && r.lng !== null && statusOk(r.status));
  const unplaced = allRouters.filter((r) => r.lat === null || r.lng === null);

  const custRows = (customers.data ?? []) as { id: string; full_name: string; customer_number: string; status: string; estate: string | null; town: string | null; county: string | null }[];
  const inArea = custRows.filter(areaMatch);

  let mapCustomers: MapCustomer[] = [];
  if (opts.exact && inArea.length) {
    const { data: locs } = await db.from("customer_locations").select("customer_id, latitude, longitude").eq("tenant_id", tenantId);
    const byId = new Map(inArea.map((c) => [c.id, c]));
    mapCustomers = (locs ?? [])
      .filter((l) => byId.has(l.customer_id))
      .map((l) => {
        const c = byId.get(l.customer_id)!;
        return { id: c.id, name: c.full_name, number: c.customer_number, status: c.status, online: onlineCustomers.has(c.id), lat: Number(l.latitude), lng: Number(l.longitude), area: c.estate ?? c.town };
      })
      .filter((c) => !opts.status || (opts.status === "online" ? c.online : opts.status === "offline" ? !c.online : true));
  }

  let jobs: MapJob[] = [];
  if (opts.jobsScope !== "none") {
    let q = db.from("installation_jobs").select("id, job_number, job_type, status, customer_id, scheduled_for, customers(full_name)").eq("tenant_id", tenantId).in("status", ["scheduled", "in_progress", "on_hold"]);
    if (opts.jobsScope === "mine") q = q.eq("technician_id", opts.technicianId ?? "00000000-0000-0000-0000-000000000000");
    const { data: jobRows } = await q;
    const ids = (jobRows ?? []).map((j) => j.customer_id).filter(Boolean) as string[];
    if (ids.length) {
      // RLS returns only locations this person may see (assigned technician or view_location).
      const { data: locs } = await db.from("customer_locations").select("customer_id, latitude, longitude").in("customer_id", ids);
      const loc = new Map((locs ?? []).map((l) => [l.customer_id, l]));
      jobs = (jobRows ?? []).flatMap((j) => {
        const l = j.customer_id ? loc.get(j.customer_id) : undefined;
        if (!l) return [];
        return [{ id: j.id, number: j.job_number, type: j.job_type, status: j.status, customer: (j.customers as unknown as { full_name: string } | null)?.full_name ?? null, lat: Number(l.latitude), lng: Number(l.longitude), scheduled_for: j.scheduled_for }];
      });
    }
  }

  const openTickets = new Map<string, number>();
  for (const t of tickets.data ?? []) if (t.customer_id) openTickets.set(t.customer_id, (openTickets.get(t.customer_id) ?? 0) + 1);
  const areas = new Map<string, AreaSummary>();
  for (const c of inArea) {
    const key = c.estate ?? c.town ?? c.county ?? "No area";
    const a = areas.get(key) ?? { area: key, customers: 0, active: 0, online: 0, open_tickets: 0 };
    a.customers += 1;
    if (c.status === "active") a.active += 1;
    if (onlineCustomers.has(c.id)) a.online += 1;
    a.open_tickets += openTickets.get(c.id) ?? 0;
    areas.set(key, a);
  }
  const areaOptions = [...new Set(custRows.flatMap((c) => [c.estate, c.town, c.county]).filter(Boolean) as string[])].sort();

  return {
    routers: mapRouters,
    unplaced,
    customers: mapCustomers,
    jobs,
    areas: [...areas.values()].sort((a, b) => b.customers - a.customers),
    areaOptions,
    outages: allRouters.filter((r) => r.status === "offline"),
  };
}
