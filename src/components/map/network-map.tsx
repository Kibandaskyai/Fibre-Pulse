"use client";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { MapCustomer, MapJob, MapRouter } from "@/modules/map/service";

// Leaflet draws SVG attributes, which cannot read CSS variables, so the
// status colours are repeated here from globals.css.
const COLOR = { online: "#22c55e", offline: "#ef4444", unknown: "#93a3bd", customer: "#3987e5", job: "#f59e0b" };
const NAIROBI: [number, number] = [-1.2864, 36.8172];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Routers, coverage, outages, customer points (if allowed) and open jobs on an OpenStreetMap base. */
export function NetworkMap({ routers, customers, jobs, height = 520 }: { routers: MapRouter[]; customers: MapCustomer[]; jobs: MapJob[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let map: import("leaflet").Map | null = null;
    (async () => {
      const L = await import("leaflet");
      if (disposed || !el.current) return;
      map = L.map(el.current, { scrollWheelZoom: false, attributionControl: true }).setView(NAIROBI, 12);
      // TODO: SOFTWARE ENGINEER - for production traffic use a commercial tile provider (OSM's public tiles have a fair-use policy).
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      const points: [number, number][] = [];
      for (const r of routers) {
        const color = COLOR[r.status as keyof typeof COLOR] ?? COLOR.unknown;
        if (r.coverage_m) L.circle([r.lat, r.lng], { radius: r.coverage_m, color: COLOR.customer, weight: 1, fillOpacity: 0.06, opacity: 0.5 }).addTo(map);
        L.circleMarker([r.lat, r.lng], { radius: 9, color: "#0b1220", weight: 2, fillColor: color, fillOpacity: 1 })
          .bindPopup(
            `<strong>${esc(r.name)}</strong><br/>${r.status === "online" ? "Online" : r.status === "offline" ? "OFFLINE" : "Not reporting"}` +
              ` · ${r.sessions} sessions${r.open_alerts ? ` · ${r.open_alerts} open alerts` : ""}${r.simulated ? "<br/><em>Simulated test router</em>" : ""}` +
              `<br/><a href="/network/routers/${r.id}">Open router</a>`,
          )
          .addTo(map);
        points.push([r.lat, r.lng]);
      }
      for (const c of customers) {
        L.circleMarker([c.lat, c.lng], { radius: 5, color: "#0b1220", weight: 1, fillColor: c.online ? COLOR.customer : COLOR.unknown, fillOpacity: 0.95 })
          .bindPopup(`<strong>${esc(c.name)}</strong> · ${esc(c.number)}<br/>${c.online ? "Online" : "No session"} · ${esc(c.status.replace("_", " "))}<br/><a href="/customers/${c.id}">Open customer</a>`)
          .addTo(map);
        points.push([c.lat, c.lng]);
      }
      for (const j of jobs) {
        L.circleMarker([j.lat, j.lng], { radius: 7, color: COLOR.job, weight: 3, fillColor: "#0b1220", fillOpacity: 1 })
          .bindPopup(`<strong>${esc(j.number)}</strong> · ${esc(j.type.replace(/_/g, " "))}${j.customer ? `<br/>${esc(j.customer)}` : ""}<br/><a href="/field-operations/${j.id}">Open job</a>`)
          .addTo(map);
        points.push([j.lat, j.lng]);
      }
      if (points.length > 1) map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 15 });
      else if (points.length === 1) map.setView(points[0], 15);
    })();
    return () => {
      disposed = true;
      map?.remove();
    };
  }, [routers, customers, jobs]);

  return (
    <div className="grid gap-2">
      <div ref={el} style={{ height }} className="z-0 w-full overflow-hidden rounded-lg border" role="region" aria-label="Network map. The lists below give the same information as text." />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Map legend">
        <li className="flex items-center gap-1.5"><span className="size-3 rounded-full" style={{ background: COLOR.online }} aria-hidden /> Router online</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded-full" style={{ background: COLOR.offline }} aria-hidden /> Router offline</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded-full" style={{ background: COLOR.unknown }} aria-hidden /> Not reporting / customer offline</li>
        <li className="flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: COLOR.customer }} aria-hidden /> Customer online</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded-full border-[3px]" style={{ borderColor: COLOR.job }} aria-hidden /> Open job</li>
        <li className="flex items-center gap-1.5"><span className="size-3 rounded-full border" style={{ borderColor: COLOR.customer }} aria-hidden /> Coverage area</li>
      </ul>
    </div>
  );
}
